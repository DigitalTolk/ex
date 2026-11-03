package service

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/model"
)

// Rich text limits. Every part is counted against its block, and a payload
// over any of them is refused, never cut — like every other block limit.
const (
	maxRichNodes         = 50   // paragraph-level parts per rich_text block
	maxRichSpans         = 100  // pieces per paragraph, heading, quote or item
	maxRichChars         = 4000 // all text in one rich_text block, code included
	maxRichListItems     = 100  // list items per block, nested ones included
	maxRichListDepth     = 3    // a list, a list in it, and one more
	maxPillChars         = 40
	maxRichDateFormat    = 100
	maxRichDateFallback  = 200
	maxRichLinkChars     = maxButtonURLChars
	maxRichDateTimestamp = 1e11 // Unix seconds; anything later is a mistake
)

var (
	// A code block's language only picks the highlighter; an unknown one
	// draws plain. The pattern keeps it a token, never markup.
	richLanguagePattern = regexp.MustCompile(`^[A-Za-z0-9+#._-]{1,20}$`)
	emojiNamePattern    = regexp.MustCompile(`^[a-z0-9_+-]{1,64}$`)
	// What the webhook's markdown rewrite turns a resolved <@ref> and <#ref>
	// into: ex's own mention syntax.
	resolvedUserMention    = regexp.MustCompile(`^@\[([^|\]]+)\|([^\]]*)\]$`)
	resolvedChannelMention = regexp.MustCompile(`^~\[([^|\]]+)\|([^\]]*)\]$`)
	dateFormatToken        = regexp.MustCompile(`\{([a-z_]+)\}`)
)

// richDateTokens are the parts a date span's format may hold (Slack's names;
// the client draws each in the reader's own time zone).
var richDateTokens = map[string]bool{"date_short": true, "date": true, "date_long": true, "time": true}

// richBudget counts one rich_text block's text and list items.
type richBudget struct{ chars, items int }

func (b *richBudget) spend(at, text string) error {
	b.chars += utf8.RuneCountInString(text)
	if b.chars > maxRichChars {
		return invalidBlocks("%s: a rich_text block holds at most %d characters", at, maxRichChars)
	}
	return nil
}

// richText normalizes a rich_text block's parts: unknown kinds of part or
// piece are skipped (the rest still shows), empty ones dropped, mentions
// resolved to IDs, and everything else checked against the limits.
func (n *blockNormalizer) richText(at string, in []model.RichNode) ([]model.RichNode, error) {
	if len(in) > maxRichNodes {
		return nil, invalidBlocks("%s.content: a rich_text block holds at most %d parts", at, maxRichNodes)
	}
	budget := &richBudget{}
	out := make([]model.RichNode, 0, len(in))
	for i, node := range in {
		nn, keep, err := n.richNode(fmt.Sprintf("%s.content[%d]", at, i), node, budget)
		if err != nil {
			return nil, err
		}
		if keep {
			out = append(out, nn)
		}
	}
	return out, nil
}

func (n *blockNormalizer) richNode(at string, in model.RichNode, budget *richBudget) (model.RichNode, bool, error) {
	out := model.RichNode{Type: in.Type}
	switch in.Type {
	case model.RichParagraph, model.RichQuote, model.RichHeading:
		if in.Type == model.RichHeading {
			if in.Level < 1 || in.Level > 3 {
				return model.RichNode{}, false, invalidBlocks("%s: a heading's level is 1, 2 or 3", at)
			}
			out.Level = in.Level
		}
		spans, err := n.richSpans(at+".spans", in.Spans, budget)
		if err != nil || len(spans) == 0 {
			return model.RichNode{}, false, err
		}
		out.Spans = spans
	case model.RichList:
		switch in.Style {
		case "", model.RichListBullet:
			out.Style = model.RichListBullet
		case model.RichListOrdered:
			out.Style = model.RichListOrdered
		default:
			return model.RichNode{}, false, invalidBlocks("%s: a list's style is bullet or ordered", at)
		}
		items, err := n.richItems(at+".items", in.Items, 1, budget)
		if err != nil || len(items) == 0 {
			return model.RichNode{}, false, err
		}
		out.Items = items
	case model.RichCode:
		if in.Language != "" {
			if !richLanguagePattern.MatchString(in.Language) {
				return model.RichNode{}, false, invalidBlocks("%s: language must be a short name like go or typescript", at)
			}
			out.Language = strings.ToLower(in.Language)
		}
		if strings.TrimSpace(in.Text) == "" {
			return model.RichNode{}, false, nil
		}
		if err := budget.spend(at, in.Text); err != nil {
			return model.RichNode{}, false, err
		}
		out.Text = in.Text
	default:
		return model.RichNode{}, false, nil
	}
	return out, true, nil
}

func (n *blockNormalizer) richItems(at string, in []model.RichItem, depth int, budget *richBudget) ([]model.RichItem, error) {
	if depth > maxRichListDepth {
		return nil, invalidBlocks("%s: lists nest at most %d deep", at, maxRichListDepth)
	}
	out := make([]model.RichItem, 0, len(in))
	for i, it := range in {
		iat := fmt.Sprintf("%s[%d]", at, i)
		budget.items++
		if budget.items > maxRichListItems {
			return nil, invalidBlocks("%s: a rich_text block holds at most %d list items", iat, maxRichListItems)
		}
		spans, err := n.richSpans(iat+".spans", it.Spans, budget)
		if err != nil {
			return nil, err
		}
		var nested []model.RichItem
		if len(it.Items) > 0 {
			if nested, err = n.richItems(iat+".items", it.Items, depth+1, budget); err != nil {
				return nil, err
			}
		}
		if len(spans) == 0 && len(nested) == 0 {
			continue
		}
		out = append(out, model.RichItem{Spans: spans, Items: nested})
	}
	return out, nil
}

func (n *blockNormalizer) richSpans(at string, in []model.RichSpan, budget *richBudget) ([]model.RichSpan, error) {
	if len(in) > maxRichSpans {
		return nil, invalidBlocks("%s: a part holds at most %d pieces", at, maxRichSpans)
	}
	out := make([]model.RichSpan, 0, len(in))
	for i, s := range in {
		ns, keep, err := n.richSpan(fmt.Sprintf("%s[%d]", at, i), s, budget)
		if err != nil {
			return nil, err
		}
		if keep {
			out = append(out, ns)
		}
	}
	return out, nil
}

func (n *blockNormalizer) richSpan(at string, in model.RichSpan, budget *richBudget) (model.RichSpan, bool, error) {
	switch in.Type {
	case "", model.RichSpanText:
		if in.Text == "" {
			return model.RichSpan{}, false, nil
		}
		if err := budget.spend(at, in.Text); err != nil {
			return model.RichSpan{}, false, err
		}
		out := model.RichSpan{Type: model.RichSpanText, Text: in.Text,
			Bold: in.Bold, Italic: in.Italic, Strike: in.Strike, Underline: in.Underline, Code: in.Code}
		var err error
		if out.Color, err = richColor(at+".color", in.Color, ""); err != nil {
			return model.RichSpan{}, false, err
		}
		if out.Highlight, err = richColor(at+".highlight", in.Highlight, ""); err != nil {
			return model.RichSpan{}, false, err
		}
		if in.Link != "" {
			if len(in.Link) > maxRichLinkChars || !isRichLink(in.Link) {
				return model.RichSpan{}, false, invalidBlocks("%s: link must be an http, https or mailto address of at most %d characters", at, maxRichLinkChars)
			}
			out.Link = in.Link
		}
		return out, true, nil
	case model.RichSpanUser:
		return n.richMention(at, strings.TrimSpace(in.User), "<@", "@", resolvedUserMention, model.RichSpanUser, budget)
	case model.RichSpanChannel:
		return n.richMention(at, strings.TrimPrefix(strings.TrimSpace(in.Channel), "#"), "<#", "~", resolvedChannelMention, model.RichSpanChannel, budget)
	case model.RichSpanEmoji:
		name := strings.Trim(strings.ToLower(strings.TrimSpace(in.Name)), ":")
		if !emojiNamePattern.MatchString(name) {
			return model.RichSpan{}, false, invalidBlocks("%s: an emoji's name is like rocket or white_check_mark", at)
		}
		return model.RichSpan{Type: model.RichSpanEmoji, Name: name}, true, nil
	case model.RichSpanDate:
		return richDate(at, in, budget)
	case model.RichSpanPill:
		text := strings.TrimSpace(in.Text)
		if text == "" {
			return model.RichSpan{}, false, nil
		}
		if utf8.RuneCountInString(text) > maxPillChars {
			return model.RichSpan{}, false, invalidBlocks("%s: a pill's text is at most %d characters", at, maxPillChars)
		}
		if err := budget.spend(at, text); err != nil {
			return model.RichSpan{}, false, err
		}
		color, err := richColor(at+".color", in.Color, "gray")
		if err != nil {
			return model.RichSpan{}, false, err
		}
		return model.RichSpan{Type: model.RichSpanPill, Text: text, Color: color}, true, nil
	default:
		return model.RichSpan{}, false, nil
	}
}

// richMention resolves a user or channel the way the webhook's markdown does
// (<@ref>, <#ref>), sharing its bounded lookups. Someone or something that
// isn't found is shown as typed, as text — never a mention of a near match.
func (n *blockNormalizer) richMention(at, ref, open, sigil string, resolved *regexp.Regexp, kind string, budget *richBudget) (model.RichSpan, bool, error) {
	if ref == "" {
		return model.RichSpan{}, false, invalidBlocks("%s: a mention names who or what it mentions", at)
	}
	if m := resolved.FindStringSubmatch(n.markdown(open + ref + ">")); m != nil {
		out := model.RichSpan{Type: kind, Name: m[2]}
		if kind == model.RichSpanUser {
			out.User = m[1]
		} else {
			out.Channel = m[1]
		}
		return out, true, nil
	}
	text := sigil + ref
	if err := budget.spend(at, text); err != nil {
		return model.RichSpan{}, false, err
	}
	return model.RichSpan{Type: model.RichSpanText, Text: text}, true, nil
}

func richDate(at string, in model.RichSpan, budget *richBudget) (model.RichSpan, bool, error) {
	if in.Timestamp <= 0 || in.Timestamp > maxRichDateTimestamp {
		return model.RichSpan{}, false, invalidBlocks("%s: a date needs a timestamp in Unix seconds", at)
	}
	format := in.Format
	if format == "" {
		format = "{date_short}"
	}
	if utf8.RuneCountInString(format) > maxRichDateFormat {
		return model.RichSpan{}, false, invalidBlocks("%s: a date's format is at most %d characters", at, maxRichDateFormat)
	}
	for _, m := range dateFormatToken.FindAllStringSubmatch(format, -1) {
		if !richDateTokens[m[1]] {
			return model.RichSpan{}, false, invalidBlocks("%s: a date's format may use {date_short}, {date}, {date_long} and {time}", at)
		}
	}
	if utf8.RuneCountInString(in.Fallback) > maxRichDateFallback {
		return model.RichSpan{}, false, invalidBlocks("%s: a date's fallback is at most %d characters", at, maxRichDateFallback)
	}
	if err := budget.spend(at, format+in.Fallback); err != nil {
		return model.RichSpan{}, false, err
	}
	return model.RichSpan{Type: model.RichSpanDate, Timestamp: in.Timestamp, Format: format, Fallback: in.Fallback}, true, nil
}

// richColor checks a colour name against the palette; empty means def.
// emojiIcon is a callout's or a card's icon: an emoji name, with or without
// its colons, or the emoji itself.
func emojiIcon(at, raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || isEmojiGlyph(raw) {
		return raw, nil
	}
	icon := strings.Trim(strings.ToLower(raw), ":")
	if !emojiNamePattern.MatchString(icon) {
		return "", invalidBlocks("%s: an icon is an emoji like 🚀 or its name like rocket", at)
	}
	return icon, nil
}

// isEmojiGlyph reports whether s is one emoji, sequences included (skin
// tones, ZWJ families, flags): symbols and the joiners between them only, so
// no text or control character rides along.
func isEmojiGlyph(s string) bool {
	if utf8.RuneCountInString(s) > 10 {
		return false
	}
	for _, r := range s {
		switch {
		case r < 0x80:
			// ASCII's own symbols (^, `) are no emoji.
			return false
		case unicode.Is(unicode.So, r), unicode.Is(unicode.Sk, r):
		case r == 0x200D, r == 0xFE0F, r == 0x20E3, r >= 0xE0020 && r <= 0xE007F:
		default:
			return false
		}
	}
	return true
}

func richColor(at, c, def string) (string, error) {
	if c == "" {
		return def, nil
	}
	if !model.IsRichColor(c) {
		return "", invalidBlocks("%s: colour must be one of %s", at, strings.Join(model.RichColors, ", "))
	}
	return c, nil
}

// isRichLink admits http, https and mailto addresses: a link in text opens
// in a new tab or the mail app, so every script-capable scheme is out.
func isRichLink(raw string) bool {
	if isWebURL(raw) {
		return true
	}
	return isSafeURL(raw) && strings.HasPrefix(strings.ToLower(stripURLControlBytes(raw)), "mailto:")
}

// Layout block limits.
const (
	maxToggleChildren   = 20
	maxToggleSummary    = 300 // characters in a toggle's summary line
	maxTableColumns     = 10
	maxTableRows        = 50
	maxTableHeaderChars = 100
)

// layoutBlock normalizes a callout, toggle, table, columns or chart into
// out; false when it turned out empty and is dropped.
func (n *blockNormalizer) layoutBlock(ctx context.Context, at string, b model.Block, out *model.Block) (bool, error) {
	switch b.Type {
	case model.BlockCallout:
		return n.callout(at, b, out)
	case model.BlockToggle:
		return n.toggle(ctx, at, b, out)
	case model.BlockColumns:
		return n.columns(ctx, at, b, out)
	case model.BlockChart:
		return chart(at, b, out)
	default:
		return n.table(at, b, out)
	}
}

// childBlocks normalizes the blocks a container holds. allowed names the
// kinds it may hold — text-only ones, so what a click reaches and which
// images ex fetches stay in the message's top level; kinds says so in the
// refusal. Children count towards the message's block limit and take block
// IDs like any other block.
func (n *blockNormalizer) childBlocks(ctx context.Context, at string, in model.Blocks, max int, allowed func(string) bool, kinds string) (model.Blocks, error) {
	if len(in) > max {
		return nil, invalidBlocks("%s.blocks: holds at most %d blocks", at, max)
	}
	out := make(model.Blocks, 0, len(in))
	for i, child := range in {
		cat := fmt.Sprintf("%s.blocks[%d]", at, i)
		if !allowed(child.Type) {
			return nil, invalidBlocks("%s: %s", cat, kinds)
		}
		if child.Accessory != nil {
			return nil, invalidBlocks("%s: a section inside another block can't have an accessory", cat)
		}
		for _, e := range child.Elements {
			if e.Type == model.ElementImage {
				return nil, invalidBlocks("%s: context inside another block holds text only", cat)
			}
		}
		nb, keep, err := n.block(ctx, cat, child)
		if err != nil {
			return nil, err
		}
		if !keep {
			continue
		}
		n.blocks++
		if n.blocks > maxBlocksPerMessage {
			return nil, invalidBlocks("a message can hold at most %d blocks", maxBlocksPerMessage)
		}
		out = append(out, nb)
	}
	return out, nil
}

func (n *blockNormalizer) callout(at string, b model.Block, out *model.Block) (bool, error) {
	content, err := n.richText(at, b.Content)
	if err != nil || len(content) == 0 {
		return false, err
	}
	if out.Icon, err = emojiIcon(at+".icon", b.Icon); err != nil {
		return false, err
	}
	if out.Color, err = richColor(at+".color", b.Color, "gray"); err != nil {
		return false, err
	}
	out.Content = content
	return true, nil
}

// toggle checks a toggle's summary and its children. Children are text-only
// kinds (model.IsToggleChild) and count towards the message's block limit;
// each takes a block ID like any other block.
func (n *blockNormalizer) toggle(ctx context.Context, at string, b model.Block, out *model.Block) (bool, error) {
	summary, err := n.richSpans(at+".summary", b.Summary, &richBudget{})
	if err != nil {
		return false, err
	}
	if len(summary) == 0 {
		return false, invalidBlocks("%s: a toggle needs a summary", at)
	}
	if utf8.RuneCountInString(model.RichSpansPlain(summary)) > maxToggleSummary {
		return false, invalidBlocks("%s.summary: a toggle's summary is at most %d characters", at, maxToggleSummary)
	}
	children, err := n.childBlocks(ctx, at, b.Blocks, maxToggleChildren, model.IsToggleChild,
		"a toggle holds text only: rich_text, table, divider, section and context blocks")
	if err != nil || len(children) == 0 {
		return false, err
	}
	out.Summary, out.Blocks, out.Open = summary, children, b.Open
	return true, nil
}

// table checks columns and rows; short rows are padded to the column count.
func (n *blockNormalizer) table(at string, b model.Block, out *model.Block) (bool, error) {
	if len(b.Columns) == 0 || len(b.Columns) > maxTableColumns {
		return false, invalidBlocks("%s.columns: a table has 1 to %d columns", at, maxTableColumns)
	}
	if len(b.Rows) > maxTableRows {
		return false, invalidBlocks("%s.rows: a table has at most %d rows", at, maxTableRows)
	}
	cols := make([]model.TableColumn, len(b.Columns))
	for i, c := range b.Columns {
		cat := fmt.Sprintf("%s.columns[%d]", at, i)
		if utf8.RuneCountInString(c.Header) > maxTableHeaderChars {
			return false, invalidBlocks("%s: a header is at most %d characters", cat, maxTableHeaderChars)
		}
		switch c.Align {
		case "", model.AlignLeft:
			cols[i] = model.TableColumn{Header: c.Header, Align: model.AlignLeft}
		case model.AlignCenter, model.AlignRight:
			cols[i] = model.TableColumn{Header: c.Header, Align: c.Align}
		default:
			return false, invalidBlocks("%s: align is left, center or right", cat)
		}
	}
	budget := &richBudget{}
	rows := make([][]model.TableCell, 0, len(b.Rows))
	for r, row := range b.Rows {
		rat := fmt.Sprintf("%s.rows[%d]", at, r)
		if len(row) > len(cols) {
			return false, invalidBlocks("%s: a row has at most as many cells as the table has columns (%d)", rat, len(cols))
		}
		cells := make([]model.TableCell, len(cols))
		for c, cell := range row {
			cat := fmt.Sprintf("%s[%d]", rat, c)
			in := cell.Spans
			if cell.Text != "" {
				if len(in) > 0 {
					return false, invalidBlocks("%s: a cell has text or spans, not both", cat)
				}
				in = []model.RichSpan{{Text: cell.Text}}
			}
			spans, err := n.richSpans(cat, in, budget)
			if err != nil {
				return false, err
			}
			cells[c] = model.TableCell{Spans: spans}
		}
		rows = append(rows, cells)
	}
	if len(rows) == 0 {
		return false, nil
	}
	out.Columns, out.Rows = cols, rows
	return true, nil
}
