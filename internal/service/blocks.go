package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/model"
)

// ErrInvalidBlocks refuses a payload whose blocks break a rule; the message
// names the block. The HTTP layer answers 400 invalid_blocks.
var ErrInvalidBlocks = errors.New("invalid blocks")

// Block limits (Slack's, where Slack has one). A payload over any of them is
// refused rather than cut, so the app learns of it.
const (
	maxBlocksPerMessage   = 50
	maxActionsElements    = 25
	maxContextElements    = 10
	maxSectionFields      = 10
	maxBlockIDChars       = 255
	maxHeaderChars        = 150
	maxSectionChars       = 3000
	maxFieldChars         = 2000
	maxContextChars       = 2000
	maxButtonLabelChars   = 75
	maxButtonValueChars   = 2000
	maxButtonURLChars     = 3000
	maxConfirmChars       = 300
	maxAllowedUsers       = 50
	maxAllowedUserLookups = 100
	// maxStoredBlocksBytes bounds a message's blocks as stored: a DynamoDB
	// item holds 400 KB in all, and the same message goes to search and to
	// every live client.
	maxStoredBlocksBytes = 128 * 1024
)

func invalidBlocks(format string, args ...any) error {
	return apperr.Reject(ErrInvalidBlocks, format, args...)
}

// blockNormalizer checks and normalizes one message's blocks — its own and
// its cards' — so IDs are unique across all of them.
type blockNormalizer struct {
	// markdown rewrites a markdown text the way the webhook's text is
	// rewritten (Slack-style <@user> mentions and the like).
	markdown func(string) string
	// user resolves an allowed_users entry (an ex user ID or an email) to a
	// user ID, "" when no user matches.
	user func(ctx context.Context, ref string) string

	blocks   int
	images   int
	ids      map[string]bool
	nextID   int
	resolved map[string]string
}

func newBlockNormalizer(markdown func(string) string, user func(context.Context, string) string) *blockNormalizer {
	return &blockNormalizer{markdown: markdown, user: user, ids: map[string]bool{}, resolved: map[string]string{}}
}

// normalize checks blocks against the limits and returns them as ex stores
// them: unknown kinds dropped, every block and button named, "mrkdwn" read
// as ex markdown, allowed_users resolved to user IDs. where names the blocks'
// place in the payload for error messages ("blocks", "attachments[0].blocks").
func (n *blockNormalizer) normalize(ctx context.Context, where string, in model.Blocks) (model.Blocks, error) {
	if len(in) == 0 {
		return nil, nil
	}
	out := make(model.Blocks, 0, len(in))
	for i, b := range in {
		at := fmt.Sprintf("%s[%d]", where, i)
		nb, keep, err := n.block(ctx, at, b)
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
	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}

// normalizeMessage normalizes a message's blocks and its cards' (see
// normalize) and bounds their stored size. Every block ID the app chose, in
// any of them, is reserved first, so a generated ID never takes a name the
// app uses further on.
func (n *blockNormalizer) normalizeMessage(ctx context.Context, blocks model.Blocks, attachments []model.MessageAttachment) (model.Blocks, error) {
	n.reserveIDs(blocks)
	for _, a := range attachments {
		n.reserveIDs(a.Blocks)
	}
	out, err := n.normalize(ctx, "blocks", blocks)
	if err != nil {
		return nil, err
	}
	for i := range attachments {
		if attachments[i].Blocks, err = n.normalize(ctx, fmt.Sprintf("attachments[%d].blocks", i), attachments[i].Blocks); err != nil {
			return nil, err
		}
	}
	if err := checkStoredBlocksSize(out, attachments); err != nil {
		return nil, err
	}
	return out, nil
}

func (n *blockNormalizer) reserveIDs(in model.Blocks) {
	for _, b := range in {
		if b.BlockID != "" {
			n.ids["app:"+b.BlockID] = true
		}
		n.reserveIDs(b.Blocks)
	}
}

func (n *blockNormalizer) block(ctx context.Context, at string, b model.Block) (model.Block, bool, error) {
	switch b.Type {
	case model.BlockSection, model.BlockActions, model.BlockContext, model.BlockDivider, model.BlockHeader, model.BlockImage,
		model.BlockRichText, model.BlockCallout, model.BlockToggle, model.BlockTable, model.BlockColumns, model.BlockChart:
	default:
		// Unknown kinds are skipped: the rest of the message still shows.
		return model.Block{}, false, nil
	}
	out := model.Block{Type: b.Type}
	switch b.Type {
	case model.BlockHeader:
		if b.Text == nil || strings.TrimSpace(b.Text.Text) == "" {
			return model.Block{}, false, invalidBlocks("%s: a header needs text", at)
		}
		t, err := n.text(at+".text", *b.Text, maxHeaderChars, true)
		if err != nil {
			return model.Block{}, false, err
		}
		out.Text = &t
	case model.BlockSection:
		if err := n.section(ctx, at, b, &out); err != nil {
			return model.Block{}, false, err
		}
	case model.BlockImage:
		if err := n.imageBlock(at, b, &out); err != nil {
			return model.Block{}, false, err
		}
	case model.BlockActions:
		buttons, err := n.buttons(ctx, at, b.Elements)
		if err != nil {
			return model.Block{}, false, err
		}
		if len(buttons) == 0 {
			return model.Block{}, false, nil
		}
		out.Elements = buttons
	case model.BlockRichText:
		content, err := n.richText(at, b.Content)
		if err != nil {
			return model.Block{}, false, err
		}
		if len(content) == 0 {
			return model.Block{}, false, nil
		}
		out.Content = content
	case model.BlockCallout, model.BlockToggle, model.BlockTable, model.BlockColumns, model.BlockChart:
		keep, err := n.layoutBlock(ctx, at, b, &out)
		if err != nil || !keep {
			return model.Block{}, false, err
		}
	case model.BlockContext:
		texts, err := n.contextTexts(at, b.Elements)
		if err != nil {
			return model.Block{}, false, err
		}
		if len(texts) == 0 {
			return model.Block{}, false, nil
		}
		out.Elements = texts
	}
	// Named last, so a block dropped for being empty takes no generated ID.
	id, err := n.blockID(at, b.BlockID)
	if err != nil {
		return model.Block{}, false, err
	}
	out.BlockID = id
	return out, true, nil
}

// blockID keeps the app's ID or names the block b1, b2, …; IDs are unique
// across the whole message.
func (n *blockNormalizer) blockID(at, id string) (string, error) {
	if id == "" {
		for {
			n.nextID++
			id = "b" + strconv.Itoa(n.nextID)
			if !n.ids["app:"+id] && !n.ids[id] {
				break
			}
		}
	} else if utf8.RuneCountInString(id) > maxBlockIDChars {
		return "", invalidBlocks("%s: block_id is longer than %d characters", at, maxBlockIDChars)
	}
	if n.ids[id] {
		return "", invalidBlocks("%s: block_id %q is used twice", at, id)
	}
	n.ids[id] = true
	return id, nil
}

func (n *blockNormalizer) section(ctx context.Context, at string, b model.Block, out *model.Block) error {
	if b.Text != nil && strings.TrimSpace(b.Text.Text) != "" {
		t, err := n.text(at+".text", *b.Text, maxSectionChars, false)
		if err != nil {
			return err
		}
		out.Text = &t
	}
	if len(b.Fields) > maxSectionFields {
		return invalidBlocks("%s: a section can hold at most %d fields", at, maxSectionFields)
	}
	for i, f := range b.Fields {
		t, err := n.text(fmt.Sprintf("%s.fields[%d]", at, i), f, maxFieldChars, false)
		if err != nil {
			return err
		}
		out.Fields = append(out.Fields, t)
	}
	if out.Text == nil && len(out.Fields) == 0 {
		return invalidBlocks("%s: a section needs text or fields", at)
	}
	if b.Accessory == nil {
		return nil
	}
	switch {
	case b.Accessory.Type == model.ElementImage:
		img, err := n.imageElement(at+".accessory", *b.Accessory)
		if err != nil {
			return err
		}
		out.Accessory = &img
	case b.Accessory.Type == model.ElementButton || model.IsMessageInteractive(b.Accessory.Type):
		els, err := n.buttons(ctx, at+".accessory", []model.BlockElement{*b.Accessory})
		if err != nil {
			return err
		}
		out.Accessory = &els[0]
	}
	return nil
}

// buttons checks a row of elements: buttons and the elements that pick a
// value (selects, an overflow menu, pickers, checkboxes, radio buttons);
// anything else is skipped. An element without an action_id is named a1,
// a2, … — never a name another element of the row was given.
func (n *blockNormalizer) buttons(ctx context.Context, at string, in []model.BlockElement) ([]model.BlockElement, error) {
	var out []model.BlockElement
	given := map[string]bool{}
	for _, e := range in {
		given[e.ActionID] = true
	}
	used := map[string]bool{}
	next := 0
	for i, e := range in {
		if e.Type != model.ElementButton && !model.IsMessageInteractive(e.Type) {
			continue
		}
		if len(out) == maxActionsElements {
			return nil, invalidBlocks("%s: a row can hold at most %d elements", at, maxActionsElements)
		}
		for e.ActionID == "" {
			next++
			if id := "a" + strconv.Itoa(next); !given[id] {
				e.ActionID = id
			}
		}
		if used[e.ActionID] {
			return nil, invalidBlocks("%s: action_id %q is used twice in one block", at, e.ActionID)
		}
		eat := fmt.Sprintf("%s.elements[%d]", at, i)
		var b model.BlockElement
		var err error
		if e.Type == model.ElementButton {
			b, err = n.button(ctx, eat, e)
		} else {
			b, err = n.valueElement(ctx, eat, e, placeMessage)
		}
		if err != nil {
			return nil, err
		}
		used[b.ActionID] = true
		out = append(out, b)
	}
	return out, nil
}

func (n *blockNormalizer) button(ctx context.Context, at string, e model.BlockElement) (model.BlockElement, error) {
	if e.Text == nil || strings.TrimSpace(e.Text.Text) == "" {
		return model.BlockElement{}, invalidBlocks("%s: a button needs a label", at)
	}
	label, err := n.text(at+".text", *e.Text, maxButtonLabelChars, true)
	if err != nil {
		return model.BlockElement{}, err
	}
	out := model.BlockElement{Type: model.ElementButton, Text: &label, ActionID: e.ActionID, Value: e.Value}
	if utf8.RuneCountInString(out.ActionID) > maxBlockIDChars {
		return model.BlockElement{}, invalidBlocks("%s: action_id is longer than %d characters", at, maxBlockIDChars)
	}
	if utf8.RuneCountInString(out.Value) > maxButtonValueChars {
		return model.BlockElement{}, invalidBlocks("%s: value is longer than %d characters", at, maxButtonValueChars)
	}
	switch e.Style {
	case "", model.ButtonPrimary, model.ButtonDanger:
		out.Style = e.Style
	default:
		return model.BlockElement{}, invalidBlocks("%s: style must be primary or danger", at)
	}
	switch e.ExAction {
	case "", model.ExActionAck, model.ExActionVote:
		out.ExAction = e.ExAction
	default:
		return model.BlockElement{}, invalidBlocks("%s: ex_action must be ack or vote", at)
	}
	if e.URL != "" {
		if out.ExAction != "" {
			return model.BlockElement{}, invalidBlocks("%s: a button can't have both a url and an ex_action", at)
		}
		if len(e.URL) > maxButtonURLChars || !isWebURL(e.URL) {
			return model.BlockElement{}, invalidBlocks("%s: url must be an http or https address of at most %d characters", at, maxButtonURLChars)
		}
		out.URL = e.URL
	}
	if e.Confirm != nil {
		c, err := n.confirm(at+".confirm", *e.Confirm)
		if err != nil {
			return model.BlockElement{}, err
		}
		out.Confirm = &c
	}
	if len(e.AllowedUsers) > 0 {
		ids, err := n.allowedUsers(ctx, at, e.AllowedUsers)
		if err != nil {
			return model.BlockElement{}, err
		}
		out.AllowedUsers = ids
	}
	return out, nil
}

// confirm fills a confirm dialog's optional texts with defaults.
func (n *blockNormalizer) confirm(at string, c model.ConfirmDialog) (model.ConfirmDialog, error) {
	if strings.TrimSpace(c.Text.Text) == "" {
		return model.ConfirmDialog{}, invalidBlocks("%s: a confirm dialog needs text", at)
	}
	defaults := [...]string{"Are you sure?", "", "Confirm", "Cancel"}
	parts := [...]*model.TextObject{&c.Title, &c.Text, &c.Confirm, &c.Deny}
	for i, p := range parts {
		if strings.TrimSpace(p.Text) == "" {
			*p = model.TextObject{Type: model.TextPlain, Text: defaults[i]}
		}
		t, err := n.text(at, *p, maxConfirmChars, true)
		if err != nil {
			return model.ConfirmDialog{}, err
		}
		*p = t
	}
	return c, nil
}

// allowedUsers resolves emails and user IDs to user IDs. Lookups are capped
// per payload: this runs on an unauthenticated ingress. A list naming nobody
// is refused, never stored empty — empty means everyone.
func (n *blockNormalizer) allowedUsers(ctx context.Context, at string, refs []string) ([]string, error) {
	if len(refs) > maxAllowedUsers {
		return nil, invalidBlocks("%s: allowed_users can list at most %d people", at, maxAllowedUsers)
	}
	var ids []string
	for _, ref := range refs {
		ref = strings.TrimSpace(ref)
		id, seen := n.resolved[ref]
		if !seen {
			if len(n.resolved) >= maxAllowedUserLookups {
				return nil, invalidBlocks("%s: allowed_users names more than %d people across the message", at, maxAllowedUserLookups)
			}
			id = n.user(ctx, ref)
			n.resolved[ref] = id
		}
		if id != "" && !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return nil, invalidBlocks("%s: allowed_users names no ex user", at)
	}
	return ids, nil
}

// contextTexts keeps a context row's text and image elements.
func (n *blockNormalizer) contextTexts(at string, in []model.BlockElement) ([]model.BlockElement, error) {
	var out []model.BlockElement
	for i, e := range in {
		isImage := e.Type == model.ElementImage
		if !isImage && (!e.IsText() || strings.TrimSpace(e.Content) == "") {
			continue
		}
		if len(out) == maxContextElements {
			return nil, invalidBlocks("%s: a context row can hold at most %d elements", at, maxContextElements)
		}
		if isImage {
			img, err := n.imageElement(fmt.Sprintf("%s.elements[%d]", at, i), e)
			if err != nil {
				return nil, err
			}
			out = append(out, img)
			continue
		}
		t, err := n.text(fmt.Sprintf("%s.elements[%d]", at, i), model.TextObject{Type: e.Type, Text: e.Content}, maxContextChars, false)
		if err != nil {
			return nil, err
		}
		out = append(out, model.BlockElement{Type: t.Type, Content: t.Text})
	}
	return out, nil
}

// text checks a text's length and kind. plainOnly forces plain text (labels,
// headers, dialogs); otherwise "mrkdwn" becomes "markdown", rewritten like
// the webhook's own text.
func (n *blockNormalizer) text(at string, t model.TextObject, limit int, plainOnly bool) (model.TextObject, error) {
	if utf8.RuneCountInString(t.Text) > limit {
		return model.TextObject{}, invalidBlocks("%s: text is longer than %d characters", at, limit)
	}
	if plainOnly || (t.Type != model.TextMarkdown && t.Type != model.TextMrkdwn) {
		return model.TextObject{Type: model.TextPlain, Text: t.Text}, nil
	}
	return model.TextObject{Type: model.TextMarkdown, Text: n.markdown(t.Text)}, nil
}

// isWebURL admits only http and https addresses: a button opens it in a new
// tab, so mailto: and every script-capable scheme are out.
func isWebURL(raw string) bool {
	lower := strings.ToLower(stripURLControlBytes(raw))
	return isSafeURL(raw) && (strings.HasPrefix(lower, "https://") || strings.HasPrefix(lower, "http://"))
}

// checkStoredBlocksSize bounds a message's blocks — its own and its cards'
// — as they will be stored.
func checkStoredBlocksSize(blocks model.Blocks, attachments []model.MessageAttachment) error {
	size := 0
	add := func(b model.Blocks) {
		if len(b) > 0 {
			raw, _ := json.Marshal(b)
			size += len(raw)
		}
	}
	add(blocks)
	for _, a := range attachments {
		add(a.Blocks)
	}
	if size > maxStoredBlocksBytes {
		return invalidBlocks("the message's blocks are %d KB; at most %d KB fit", (size+1023)/1024, maxStoredBlocksBytes/1024)
	}
	return nil
}

// blocksFallbackText is the plain text a message with blocks but no text
// stands on: its headers, sections and context, one per line, cut to the
// body limit. Notifications, search and clients without blocks use it.
func blocksFallbackText(blocks model.Blocks, attachments []model.MessageAttachment) string {
	text := strings.Join(model.BlockTexts(blocks, attachments), "\n")
	if utf8.RuneCountInString(text) > MaxMessageBodyChars {
		text = string([]rune(text)[:MaxMessageBodyChars-1]) + "…"
	}
	return text
}
