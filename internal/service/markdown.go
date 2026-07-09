package service

import (
	"strings"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	extast "github.com/yuin/goldmark/extension/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// HastNode is re-exported from the model package — the structure is
// shared with HTTP/WS wire formats. See model/hast.go for the full
// shape and the per-tag conventions.
type HastNode = model.HastNode

// MarkdownRenderer wraps a goldmark parser configured with the
// extensions we use: GFM strikethrough only (we deliberately disable
// autolink-literal because the frontend wants to format bare URLs
// with the leading https:// stripped from the visible text — easier
// to reason about with a single bare-url renderer than two paths).
type MarkdownRenderer struct {
	md goldmark.Markdown
}

// blockParsersWithoutSetext is goldmark's DefaultBlockParsers minus the
// SetextHeading parser (priority 100). Removing it means `foobar\n---` is a
// paragraph followed by a thematic break (<hr>) rather than an <h2> setext
// heading — matching the composer (which also drops SetextHeading) and the
// Slack-style model where a line of `---` is a divider.
func blockParsersWithoutSetext() []util.PrioritizedValue {
	return []util.PrioritizedValue{
		util.Prioritized(parser.NewThematicBreakParser(), 200),
		util.Prioritized(parser.NewListParser(), 300),
		util.Prioritized(parser.NewListItemParser(), 400),
		util.Prioritized(parser.NewCodeBlockParser(), 500),
		util.Prioritized(parser.NewATXHeadingParser(), 600),
		util.Prioritized(parser.NewFencedCodeBlockParser(), 700),
		util.Prioritized(parser.NewBlockquoteParser(), 800),
		util.Prioritized(parser.NewHTMLBlockParser(), 900),
		util.Prioritized(parser.NewParagraphParser(), 1000),
	}
}

func NewMarkdownRenderer() *MarkdownRenderer {
	md := goldmark.New(
		// GFM strikethrough + tables. The Table extension works via a paragraph
		// transformer (it rewrites a header+delimiter paragraph into a Table
		// node), so it composes with the custom block-parser set below rather
		// than needing its own block parser.
		goldmark.WithExtensions(extension.Strikethrough, extension.Table),
		goldmark.WithParser(parser.NewParser(
			parser.WithBlockParsers(blockParsersWithoutSetext()...),
			parser.WithInlineParsers(parser.DefaultInlineParsers()...),
			parser.WithParagraphTransformers(parser.DefaultParagraphTransformers()...),
		)),
	)
	return &MarkdownRenderer{md: md}
}

// RenderToHast parses `body` and returns a hast tree. The tree is
// always a `root` node; children are block-level elements.
//
// The transform also walks every text leaf to extract our custom
// inline syntax (mentions, hashtags, emoji shortcodes, giphy refs,
// raw image syntax left as literal text, bare URLs) into `ex-*`
// element nodes. Doing this on the backend keeps the per-message
// parsing cost a single, server-side pass — no matter how many
// clients render it, no matter how many times a message re-renders
// on the frontend.
func (r *MarkdownRenderer) RenderToHast(body string) *HastNode {
	if body == "" {
		return &HastNode{Type: "root", Children: []*HastNode{}}
	}
	src := []byte(body)
	doc := r.md.Parser().Parse(text.NewReader(src))
	root := &HastNode{Type: "root", Children: []*HastNode{}}
	emitChildren(doc, src, root)
	walkAndExtractCustom(root)
	insertBlankLineParagraphs(body, root)
	return root
}

// emitChildren walks the goldmark AST under `node` and appends hast
// children to `parent`. `src` is the original source the AST
// references for text segments.
func emitChildren(node ast.Node, src []byte, parent *HastNode) {
	for child := node.FirstChild(); child != nil; child = child.NextSibling() {
		emitNode(child, src, parent)
	}
}

func emitNode(node ast.Node, src []byte, parent *HastNode) {
	switch n := node.(type) {
	case *ast.Heading:
		el := element("h"+itoa(n.Level), nil)
		// Heading classes match the legacy renderer so the visual
		// surface is unchanged. Class strings live with the frontend
		// component map; we just emit the bare tag here. (Frontend
		// components map adds the classes.)
		emitChildren(n, src, el)
		parent.Children = append(parent.Children, el)
	case *ast.Paragraph:
		el := element("p", nil)
		emitChildren(n, src, el)
		parent.Children = append(parent.Children, el)
	case *ast.TextBlock:
		// Used inside loose lists. Treat like a paragraph but without
		// the wrapping <p> so list-item children stay flat.
		emitChildren(n, src, parent)
	case *ast.List:
		tag := "ul"
		if n.IsOrdered() {
			tag = "ol"
		}
		el := element(tag, nil)
		emitChildren(n, src, el)
		parent.Children = append(parent.Children, el)
	case *ast.ListItem:
		el := element("li", nil)
		emitChildren(n, src, el)
		parent.Children = append(parent.Children, el)
	case *ast.Blockquote:
		el := element("blockquote", nil)
		emitChildren(n, src, el)
		parent.Children = append(parent.Children, el)
	case *ast.ThematicBreak:
		parent.Children = append(parent.Children, element("hr", nil))
	case *ast.FencedCodeBlock:
		lang := string(n.Language(src))
		props := map[string]interface{}{}
		if lang != "" {
			props["className"] = []string{"language-" + normalizeCodeLanguageGo(lang)}
		}
		var b strings.Builder
		for i := 0; i < n.Lines().Len(); i++ {
			line := n.Lines().At(i)
			b.Write(line.Value(src))
		}
		// Strip the trailing newline goldmark always appends — the
		// frontend's <pre> renderer doesn't want it (matches the
		// legacy renderer's behaviour).
		raw := b.String()
		raw = strings.TrimRight(raw, "\n")
		preProps := map[string]interface{}{"data-language": lang}
		pre := element("pre", preProps)
		code := element("code", props)
		code.Children = []*HastNode{textNode(raw)}
		pre.Children = []*HastNode{code}
		parent.Children = append(parent.Children, pre)
	case *ast.CodeBlock:
		// Indented (4-space) code block — no language hint.
		var b strings.Builder
		for i := 0; i < n.Lines().Len(); i++ {
			line := n.Lines().At(i)
			b.Write(line.Value(src))
		}
		raw := strings.TrimRight(b.String(), "\n")
		pre := element("pre", nil)
		code := element("code", nil)
		code.Children = []*HastNode{textNode(raw)}
		pre.Children = []*HastNode{code}
		parent.Children = append(parent.Children, pre)
	case *ast.Text:
		// Goldmark splits soft-wrapped lines into multiple Text
		// nodes; concat the value and append a newline only when
		// SoftLineBreak/HardLineBreak is set. The custom-syntax
		// post-walker later splits these on token boundaries.
		seg := n.Segment
		val := string(seg.Value(src))
		if n.SoftLineBreak() || n.HardLineBreak() {
			val += "\n"
		}
		appendTextChild(parent, val)
	case *ast.Emphasis:
		tag := "em"
		if n.Level == 2 {
			tag = "strong"
		}
		el := element(tag, nil)
		emitChildren(n, src, el)
		parent.Children = append(parent.Children, el)
	case *extast.Strikethrough:
		// Frontend renders <s> not <del>; the legacy regex parser
		// emitted <s> too.
		el := element("s", nil)
		emitChildren(n, src, el)
		parent.Children = append(parent.Children, el)
	case *extast.Table:
		// GFM table → <table><thead><tr><th>…</th></tr></thead>
		// <tbody><tr><td>…</td></tr>…</tbody></table>. The header row is the
		// first child; the rest are body rows. Cell alignment (from the
		// delimiter row's colons) rides along as a `data-align` prop the
		// frontend maps to a text-align class — omitted for the default
		// (left/none) so the common case stays clean.
		table := element("table", nil)
		var thead, tbody *HastNode
		for row := n.FirstChild(); row != nil; row = row.NextSibling() {
			switch row.(type) {
			case *extast.TableHeader:
				tr := element("tr", nil)
				emitTableRow(row, src, tr, "th")
				thead = element("thead", nil)
				thead.Children = []*HastNode{tr}
			case *extast.TableRow:
				tr := element("tr", nil)
				emitTableRow(row, src, tr, "td")
				if tbody == nil {
					tbody = element("tbody", nil)
				}
				tbody.Children = append(tbody.Children, tr)
			}
		}
		if thead != nil {
			table.Children = append(table.Children, thead)
		}
		if tbody != nil {
			table.Children = append(table.Children, tbody)
		}
		parent.Children = append(parent.Children, table)
	case *ast.CodeSpan:
		el := element("code", nil)
		var b strings.Builder
		for c := n.FirstChild(); c != nil; c = c.NextSibling() {
			if t, ok := c.(*ast.Text); ok {
				b.Write(t.Segment.Value(src))
			}
		}
		el.Children = []*HastNode{textNode(b.String())}
		parent.Children = append(parent.Children, el)
	case *ast.Link:
		dest := string(n.Destination)
		if !isSafeURL(dest) {
			// Disallowed scheme (javascript:, data:, vbscript: …) — drop the
			// anchor and keep its visible text, mirroring how raw HTML and
			// non-giphy images are handled. The frontend renders this HAST
			// href verbatim, so neutralising it here is the authoritative XSS
			// guard for every client (and incoming webhooks).
			emitChildren(n, src, parent)
			return
		}
		props := map[string]interface{}{
			"href":   dest,
			"target": "_blank",
			"rel":    "noopener noreferrer",
		}
		el := element("a", props)
		emitChildren(n, src, el)
		parent.Children = append(parent.Children, el)
	case *ast.AutoLink:
		// Goldmark emits AutoLink for <https://x> only (URL bracket
		// syntax). Re-emit the URL into the text stream so the
		// custom-syntax walker turns it into an `ex-bare-url` node.
		appendTextChild(parent, string(n.URL(src)))
	case *ast.Image:
		// Image markdown — the frontend renders a literal text span
		// for non-giphy URLs (security: no arbitrary remote media in
		// chat) or a GiphyEmbed for `giphy:<id>`. Dimension suffix
		// (`=WxH`) is preserved in the source-text fallback path.
		dest := string(n.Destination)
		alt := altText(n, src)
		if strings.HasPrefix(dest, "giphy:") {
			id := strings.TrimPrefix(dest, "giphy:")
			props := map[string]interface{}{"data-id": id}
			parent.Children = append(parent.Children, &HastNode{
				Type:       "element",
				TagName:    "ex-giphy",
				Properties: props,
				Children:   []*HastNode{},
			})
			return
		}
		// Reconstruct the original markdown for the fallback render.
		appendTextChild(parent, "!["+alt+"]("+dest+")")
	default:
		// Fallback: drop unknown nodes but keep their text content.
		// (Tables would land here if/when we enable the GFM table
		// extension.)
		emitChildren(n, src, parent)
	}
}

func element(tag string, properties map[string]interface{}) *HastNode {
	return &HastNode{Type: "element", TagName: tag, Properties: properties, Children: []*HastNode{}}
}

// emitTableRow appends one hast cell (`th` for the header, `td` for a body row)
// per goldmark TableCell child, carrying the cell's inline content and its
// alignment.
func emitTableRow(row ast.Node, src []byte, tr *HastNode, cellTag string) {
	for cell := row.FirstChild(); cell != nil; cell = cell.NextSibling() {
		// goldmark only ever nests TableCell nodes under a header/body row.
		c := cell.(*extast.TableCell)
		el := element(cellTag, tableCellProps(c.Alignment))
		emitChildren(c, src, el)
		tr.Children = append(tr.Children, el)
	}
}

// tableCellProps maps a GFM column alignment to the `data-align` prop the
// frontend reads. Left/none is the rendered default, so it emits nothing to
// keep the tree compact.
func tableCellProps(a extast.Alignment) map[string]interface{} {
	switch a {
	case extast.AlignCenter:
		return map[string]interface{}{"data-align": "center"}
	case extast.AlignRight:
		return map[string]interface{}{"data-align": "right"}
	default:
		return nil
	}
}

// isSafeURL reports whether a link destination is safe to emit as an href.
// Absolute URLs are allowed only for the http/https/mailto schemes; anything
// with another explicit scheme (javascript:, data:, vbscript:, file: …) is
// rejected as a potential script-injection vector. Scheme-relative ("//host"),
// path-relative, query, and fragment URLs carry no scheme and are allowed.
// stripURLControlBytes removes ASCII control characters and spaces (<= 0x20)
// and DEL (0x7f) from a URL — the bytes a browser drops before navigating, and
// the ones an attacker uses to split a "java\tscript:" scheme past a naive scan.
func stripURLControlBytes(raw string) string {
	var b strings.Builder
	b.Grow(len(raw))
	for i := 0; i < len(raw); i++ {
		if c := raw[i]; c > 0x20 && c != 0x7f {
			b.WriteByte(c)
		}
	}
	return b.String()
}

// isSchemeChar reports whether c is a valid URL-scheme byte per RFC 3986:
// ALPHA / DIGIT / "+" / "-" / ".".
func isSchemeChar(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '+' || c == '-' || c == '.'
}

func isSafeURL(raw string) bool {
	// Browsers strip ASCII control characters and spaces from a URL before
	// navigating, so "java\tscript:alert(1)" would still execute. Strip them
	// first (matching src/lib/url-safety.ts) so the scheme scan below
	// evaluates what the browser will act on instead of being fooled into
	// treating a split scheme as a relative reference.
	s := stripURLControlBytes(raw)
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		// A '/', '?' or '#' before any ':' means there is no scheme — the URL
		// is relative (or an anchor/query), which is safe.
		if c == '/' || c == '?' || c == '#' {
			return true
		}
		if c == ':' {
			scheme := strings.ToLower(s[:i])
			return scheme == "http" || scheme == "https" || scheme == "mailto"
		}
		// Any non-scheme byte before a ':' means it isn't a scheme → relative.
		if !isSchemeChar(c) {
			return true
		}
	}
	// No ':' encountered at all → relative reference → safe.
	return true
}

func textNode(value string) *HastNode {
	return &HastNode{Type: "text", Value: value}
}

// appendTextChild concatenates with the trailing text node when the
// parent already ends in one — keeps the tree compact and lets the
// custom-syntax walker match tokens that span what was originally
// multiple goldmark Text nodes (e.g. soft line breaks inside a
// paragraph).
func appendTextChild(parent *HastNode, value string) {
	if value == "" {
		return
	}
	n := len(parent.Children)
	if n > 0 && parent.Children[n-1].Type == "text" {
		parent.Children[n-1].Value += value
		return
	}
	parent.Children = append(parent.Children, textNode(value))
}

// itoa is a tiny no-import alternative; goldmark only emits levels 1–6.
func itoa(level int) string {
	return string(rune('0' + level))
}

// altText concatenates an image node's alt label.
func altText(img *ast.Image, src []byte) string {
	var b strings.Builder
	for c := img.FirstChild(); c != nil; c = c.NextSibling() {
		if t, ok := c.(*ast.Text); ok {
			b.Write(t.Segment.Value(src))
		}
	}
	return b.String()
}

// normalizeCodeLanguageGo mirrors the frontend alias map so a `js`
// fence still emits `language-javascript` — same string the legacy
// renderer used.
func normalizeCodeLanguageGo(language string) string {
	lowered := strings.ToLower(language)
	switch lowered {
	case "c++":
		return "cpp"
	case "c#":
		return "csharp"
	case "f#":
		return "fsharp"
	case "js":
		return "javascript"
	case "py":
		return "python"
	case "rb":
		return "ruby"
	case "sh":
		return "bash"
	case "ts":
		return "typescript"
	}
	// Same allowlist as the frontend: a-z, 0-9, _, -. Any other char
	// becomes a hyphen, then trim leading/trailing hyphens.
	var b strings.Builder
	for _, r := range lowered {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	return out
}

// insertBlankLineParagraphs preserves the legacy renderer's behaviour
// of stacking one empty paragraph per blank line in the source. CommonMark
// collapses runs of blank lines, so we count runs in the raw body and
// insert ex-blank-paragraph siblings between adjacent block elements
// whose source positions span those gaps.
//
// Implementation note: rather than tracking source offsets through
// goldmark (which is fiddly), we simply walk the line array and emit
// one blank paragraph per blank line in the *flat top-level block
// stream*. Inline blank-handling (rare) keeps the legacy fallback —
// you'd need a heading-then-blank-then-paragraph pattern, which the
// regex parser also collapsed under most conditions.
func insertBlankLineParagraphs(body string, root *HastNode) {
	// Number of blank lines in each source gap that separates two
	// top-level content runs, in order. The i-th entry lines up with
	// the gap between the i-th and (i+1)-th rendered top-level blocks
	// for the dominant case (blocks separated by blank-line runs), so
	// we consume it by index while walking the children.
	gaps := gapBlankCounts(body)
	total := 0
	for _, g := range gaps {
		total += g
	}
	if total == 0 {
		return
	}
	out := make([]*HastNode, 0, len(root.Children)+total)
	for i, child := range root.Children {
		out = append(out, child)
		if i >= len(root.Children)-1 {
			continue
		}
		// One blank paragraph per blank line in this gap (N blank
		// lines → N blank <p>). A gap absent from the source (two
		// blocks adjacent with no blank line, e.g. a heading directly
		// above a paragraph) inserts nothing.
		n := 0
		if i < len(gaps) {
			n = gaps[i]
		}
		for k := 0; k < n; k++ {
			out = append(out, blankParagraph())
		}
	}
	root.Children = out
}

// gapBlankCounts returns, in order, the number of blank lines in each
// run that separates two content runs at the top level. Blank lines
// inside fenced code blocks and leading/trailing blank runs are
// ignored (they don't sit between two blocks). Without source-position
// tracking from goldmark this maps 1:1 onto inter-block gaps for the
// common case where every top-level block is separated by a blank-line
// run — which covers ordinary chat messages and the test corpus.
func gapBlankCounts(body string) []int {
	lines := strings.Split(body, "\n")
	gaps := make([]int, 0, len(lines))
	inFence := false
	seenContent := false
	pending := 0
	for _, line := range lines {
		if strings.HasPrefix(line, "```") {
			// An opening fence starts a new top-level block, so a blank run
			// that preceded it closes an inter-block gap (e.g. the blank
			// lines between two adjacent fenced code blocks). Flush it before
			// resetting — without this the gap between two code blocks was
			// silently dropped.
			if !inFence && seenContent && pending > 0 {
				gaps = append(gaps, pending)
			}
			inFence = !inFence
			seenContent = true
			pending = 0
			continue
		}
		if inFence {
			seenContent = true
			pending = 0
			continue
		}
		if strings.TrimSpace(line) == "" {
			if seenContent {
				pending++
			}
			continue
		}
		// Non-blank content line: a blank run that preceded it closes
		// an inter-block gap.
		if seenContent && pending > 0 {
			gaps = append(gaps, pending)
		}
		pending = 0
		seenContent = true
	}
	return gaps
}

func blankParagraph() *HastNode {
	p := element("p", map[string]interface{}{"data-blank": "true"})
	p.Children = []*HastNode{textNode(" ")}
	return p
}

// walkAndExtractCustom recurses through the hast tree and rewrites
// every text leaf into a sequence of {text + ex-* element} nodes by
// running the custom-inline-syntax extractor. Skips inside <code> /
// <pre> so syntax tokens inside fenced code stay literal.
func walkAndExtractCustom(node *HastNode) {
	if node == nil {
		return
	}
	if node.Type == "element" && (node.TagName == "code" || node.TagName == "pre") {
		return
	}
	out := make([]*HastNode, 0, len(node.Children))
	for _, child := range node.Children {
		if child.Type == "text" {
			out = append(out, extractCustomTokens(child.Value)...)
			continue
		}
		walkAndExtractCustom(child)
		out = append(out, child)
	}
	node.Children = out
}
