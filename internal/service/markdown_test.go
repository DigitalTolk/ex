package service

import (
	"context"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func TestMarkdownRenderer_EmptyBody(t *testing.T) {
	r := NewMarkdownRenderer()
	out := r.RenderToHast("")
	if out.Type != "root" || len(out.Children) != 0 {
		t.Errorf("empty body should produce empty root, got %+v", out)
	}
}

func TestMarkdownRenderer_HeadingsAndParagraphs(t *testing.T) {
	r := NewMarkdownRenderer()
	out := r.RenderToHast("# Title\nbody text")
	tags := topLevelTags(out)
	if len(tags) != 2 || tags[0] != "h1" || tags[1] != "p" {
		t.Errorf("expected [h1 p], got %v", tags)
	}
	if firstText(out.Children[0]) != "Title" {
		t.Errorf("h1 text = %q", firstText(out.Children[0]))
	}
	if !strings.Contains(allText(out.Children[1]), "body text") {
		t.Errorf("p text = %q", allText(out.Children[1]))
	}
}

func TestMarkdownRenderer_BoldItalicStrike(t *testing.T) {
	r := NewMarkdownRenderer()
	out := r.RenderToHast("**b** *i* ~~s~~")
	flat := flattenTags(out)
	for _, tag := range []string{"strong", "em", "s"} {
		found := false
		for _, t := range flat {
			if t == tag {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("expected %s in tree, got %v", tag, flat)
		}
	}
}

func TestMarkdownRenderer_FencedCodeWithLanguageHint(t *testing.T) {
	r := NewMarkdownRenderer()
	out := r.RenderToHast("```javascript\nlet x = 1;\n```")
	if len(out.Children) != 1 || out.Children[0].TagName != "pre" {
		t.Fatalf("expected pre at root, got %+v", out.Children)
	}
	pre := out.Children[0]
	if pre.Properties["data-language"] != "javascript" {
		t.Errorf("data-language = %v", pre.Properties["data-language"])
	}
	code := pre.Children[0]
	cls, _ := code.Properties["className"].([]string)
	if len(cls) != 1 || cls[0] != "language-javascript" {
		t.Errorf("code className = %v", cls)
	}
	if firstText(code) != "let x = 1;" {
		t.Errorf("code text = %q", firstText(code))
	}
}

func TestMarkdownRenderer_LanguageAliases(t *testing.T) {
	r := NewMarkdownRenderer()
	cases := []struct {
		hint  string
		class string
	}{
		{"js", "language-javascript"},
		{"ts", "language-typescript"},
		{"py", "language-python"},
		{"sh", "language-bash"},
		{"c++", "language-cpp"},
		{"c#", "language-csharp"},
	}
	for _, tc := range cases {
		t.Run(tc.hint, func(t *testing.T) {
			out := r.RenderToHast("```" + tc.hint + "\ncode\n```")
			cls, _ := out.Children[0].Children[0].Properties["className"].([]string)
			if len(cls) == 0 || cls[0] != tc.class {
				t.Errorf("hint %q → got %v, want %s", tc.hint, cls, tc.class)
			}
		})
	}
}

func TestMarkdownRenderer_ListsAndBlockquote(t *testing.T) {
	r := NewMarkdownRenderer()
	out := r.RenderToHast("- one\n- two\n\n> quoted")
	tags := topLevelTags(out)
	hasUL, hasBQ := false, false
	for _, tag := range tags {
		if tag == "ul" {
			hasUL = true
		}
		if tag == "blockquote" {
			hasBQ = true
		}
	}
	if !hasUL || !hasBQ {
		t.Errorf("expected ul + blockquote, got %v", tags)
	}
}

func TestMarkdownRenderer_UserMentionToken(t *testing.T) {
	r := NewMarkdownRenderer()
	out := r.RenderToHast("hi @[u-1|Alice]")
	mention := findFirstByTag(out, "ex-mention-user")
	if mention == nil {
		t.Fatal("expected ex-mention-user")
	}
	if mention.Properties["data-user-id"] != "u-1" || mention.Properties["data-name"] != "Alice" {
		t.Errorf("mention props = %+v", mention.Properties)
	}
}

func TestMarkdownRenderer_ChannelMentionToken(t *testing.T) {
	r := NewMarkdownRenderer()
	out := r.RenderToHast("see ~[ch-1|general]")
	mention := findFirstByTag(out, "ex-mention-channel")
	if mention == nil || mention.Properties["data-channel-id"] != "ch-1" || mention.Properties["data-slug"] != "general" {
		t.Errorf("channel-mention props = %+v", mention)
	}
}

func TestMarkdownRenderer_GroupMentionToken(t *testing.T) {
	r := NewMarkdownRenderer()
	out := r.RenderToHast("ping @all please")
	mention := findFirstByTag(out, "ex-mention-group")
	if mention == nil || mention.Properties["data-group"] != "all" {
		t.Errorf("group-mention props = %+v", mention)
	}
}

func TestMarkdownRenderer_HashtagToken(t *testing.T) {
	r := NewMarkdownRenderer()
	out := r.RenderToHast("track #BugFix here")
	tag := findFirstByTag(out, "ex-hashtag")
	if tag == nil {
		t.Fatal("expected ex-hashtag")
	}
	// data-tag is lowercased; data-value preserves the original case.
	if tag.Properties["data-tag"] != "bugfix" {
		t.Errorf("data-tag = %v, want bugfix", tag.Properties["data-tag"])
	}
	if tag.Properties["data-value"] != "#BugFix" {
		t.Errorf("data-value = %v", tag.Properties["data-value"])
	}
}

func TestMarkdownRenderer_GiphyEmbedWithDimensions(t *testing.T) {
	r := NewMarkdownRenderer()
	out := r.RenderToHast("![GIPHY](giphy:abc =200x150)")
	g := findFirstByTag(out, "ex-giphy")
	if g == nil {
		t.Fatal("expected ex-giphy")
	}
	if g.Properties["data-id"] != "abc" || g.Properties["data-width"] != 200 || g.Properties["data-height"] != 150 {
		t.Errorf("giphy props = %+v", g.Properties)
	}
}

func TestMarkdownRenderer_MediaLiteralPreservesURL(t *testing.T) {
	r := NewMarkdownRenderer()
	out := r.RenderToHast("![cat](https://media.example/cat.gif =320x240)")
	lit := findFirstByTag(out, "ex-media-literal")
	if lit == nil {
		t.Fatal("expected ex-media-literal")
	}
	val, _ := lit.Properties["data-value"].(string)
	if !strings.Contains(val, "https://media.example/cat.gif") {
		t.Errorf("media-literal data-value lost https://: %q", val)
	}
	if !strings.Contains(val, "=320x240") {
		t.Errorf("media-literal data-value lost size suffix: %q", val)
	}
}

func TestMarkdownRenderer_BareURLToken(t *testing.T) {
	r := NewMarkdownRenderer()
	out := r.RenderToHast("see https://example.org now")
	url := findFirstByTag(out, "ex-bare-url")
	if url == nil || url.Properties["data-href"] != "https://example.org" {
		t.Errorf("bare-url = %+v", url)
	}
}

func TestMarkdownRenderer_EmojiShortcodeBare(t *testing.T) {
	r := NewMarkdownRenderer()
	out := r.RenderToHast(":smile:")
	emo := findFirstByTag(out, "ex-emoji-shortcode")
	if emo == nil || emo.Properties["data-name"] != "smile" {
		t.Errorf("emoji = %+v", emo)
	}
	if _, hasSkin := emo.Properties["data-skin"]; hasSkin {
		t.Errorf("bare emoji should not have data-skin")
	}
}

func TestMarkdownRenderer_EmojiShortcodeSkinToned(t *testing.T) {
	r := NewMarkdownRenderer()
	out := r.RenderToHast(":hand::skin-tone-3:")
	emo := findFirstByTag(out, "ex-emoji-shortcode")
	if emo == nil || emo.Properties["data-name"] != "hand" || emo.Properties["data-skin"] != "skin-tone-3" {
		t.Errorf("toned emoji = %+v", emo)
	}
}

func TestMarkdownRenderer_NoCustomTokensInsideCodeBlocks(t *testing.T) {
	r := NewMarkdownRenderer()
	// Mention syntax inside fenced code must NOT be turned into an
	// ex-mention-user — code blocks are literal.
	out := r.RenderToHast("```\n@[u-1|Alice]\n```")
	if findFirstByTag(out, "ex-mention-user") != nil {
		t.Error("should not extract mentions inside code blocks")
	}
}

func TestMarkdownRenderer_NoCustomTokensInsideInlineCode(t *testing.T) {
	r := NewMarkdownRenderer()
	out := r.RenderToHast("see `@[u-1|Alice]` literal")
	if findFirstByTag(out, "ex-mention-user") != nil {
		t.Error("should not extract mentions inside inline code")
	}
}

// End-to-end: the messages a client sees must carry Rendered when
// the markdown renderer is wired. This catches return paths missing
// an attachRendered call without touching every individual one.
func TestMessageService_AttachesRenderedOnReadPaths(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	svc.SetMarkdownRenderer(NewMarkdownRenderer())
	ctx := context.Background()
	memberships.memberships["ch-r#u-alice"] = &model.ChannelMembership{ChannelID: "ch-r", UserID: "u-alice", Role: model.ChannelRoleMember}

	// Send → returned message should already carry Rendered.
	sent, err := svc.Send(ctx, "u-alice", "ch-r", ParentChannel, "**bold** body", "")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if sent.Rendered == nil {
		t.Fatal("Send should attach Rendered to the returned message")
	}
	if sent.Rendered.Type != "root" {
		t.Errorf("Rendered.Type = %q", sent.Rendered.Type)
	}

	// List → every Message should carry Rendered.
	messages.messages["ch-r#m-existing"] = &model.Message{ID: "m-existing", ParentID: "ch-r", AuthorID: "u-alice", Body: "*italic*"}
	listed, _, err := svc.List(ctx, "u-alice", "ch-r", ParentChannel, "", 50)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(listed) == 0 {
		t.Fatal("List returned no messages")
	}
	for _, m := range listed {
		if m.Rendered == nil {
			t.Errorf("List message %s missing Rendered", m.ID)
		}
	}
}

// Soft-deleted messages have empty Body — Rendered should stay nil
// so the frontend renders the placeholder, not an empty hast tree.
func TestMessageService_DeletedMessagesHaveNilRendered(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	svc.SetMarkdownRenderer(NewMarkdownRenderer())
	ctx := context.Background()
	memberships.memberships["ch-d#u-alice"] = &model.ChannelMembership{ChannelID: "ch-d", UserID: "u-alice", Role: model.ChannelRoleMember}
	messages.messages["ch-d#m-deleted"] = &model.Message{ID: "m-deleted", ParentID: "ch-d", AuthorID: "u-alice", Deleted: true}

	listed, _, err := svc.List(ctx, "u-alice", "ch-d", ParentChannel, "", 50)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, m := range listed {
		if m.Deleted && m.Rendered != nil {
			t.Errorf("deleted message should have nil Rendered, got %+v", m.Rendered)
		}
	}
}

func TestMarkdownRenderer_BlankLinesProduceBlankParagraphs(t *testing.T) {
	r := NewMarkdownRenderer()
	out := r.RenderToHast("first\n\nsecond")
	tags := topLevelTags(out)
	// first paragraph, blank paragraph, second paragraph
	if len(tags) != 3 {
		t.Fatalf("expected 3 top-level blocks, got %v", tags)
	}
	for _, tag := range tags {
		if tag != "p" {
			t.Errorf("expected all p, got %v", tags)
			break
		}
	}
	// The middle paragraph must carry data-blank="true" so the
	// frontend renderer can give it an explicit min-height. Without
	// the marker, Tailwind preflight zeroes the <p>'s margin and the
	// visible gap the user typed in the composer disappears.
	middle := out.Children[1]
	if got, _ := middle.Properties["data-blank"].(string); got != "true" {
		t.Errorf("middle paragraph should have data-blank=\"true\", got %q (props=%+v)", got, middle.Properties)
	}
	if got, _ := out.Children[0].Properties["data-blank"].(string); got == "true" {
		t.Errorf("first paragraph should not carry data-blank")
	}
	if got, _ := out.Children[2].Properties["data-blank"].(string); got == "true" {
		t.Errorf("third paragraph should not carry data-blank")
	}
}

func TestMarkdownRenderer_IndentedCodeBlock(t *testing.T) {
	r := NewMarkdownRenderer()
	out := r.RenderToHast("    var x = 1\n    var y = 2")
	pre := findFirstByTag(out, "pre")
	if pre == nil {
		t.Fatal("expected pre")
	}
	code := findFirstByTag(pre, "code")
	if firstText(code) == "" {
		t.Errorf("indented code block should preserve text, got empty")
	}
}

func TestMarkdownRenderer_AutolinkAngleBrackets(t *testing.T) {
	r := NewMarkdownRenderer()
	// `<https://x>` autolink syntax → goldmark emits AutoLink, our
	// emitter re-streams as text so the bare-url custom-syntax pass
	// picks it up.
	out := r.RenderToHast("see <https://example.org>")
	url := findFirstByTag(out, "ex-bare-url")
	if url == nil {
		t.Fatal("expected ex-bare-url for autolink")
	}
	if url.Properties["data-href"] != "https://example.org" {
		t.Errorf("autolink href = %v", url.Properties["data-href"])
	}
}

func TestMarkdownRenderer_GiphyImageAltLabel(t *testing.T) {
	r := NewMarkdownRenderer()
	// Verify altText runs by giving an image a custom alt + giphy
	// URL; the giphy node emits the URL, but altText must execute
	// in the parser path.
	out := r.RenderToHast("![my caption](giphy:abc)")
	g := findFirstByTag(out, "ex-giphy")
	if g == nil || g.Properties["data-id"] != "abc" {
		t.Errorf("giphy = %+v", g)
	}
}

func TestMarkdownRenderer_LinkWithExplicitText(t *testing.T) {
	r := NewMarkdownRenderer()
	out := r.RenderToHast("see [docs](https://example.com)")
	link := findFirstByTag(out, "a")
	if link == nil {
		t.Fatal("expected a tag for explicit link")
	}
	if link.Properties["href"] != "https://example.com" {
		t.Errorf("href = %v", link.Properties["href"])
	}
	if firstText(link) != "docs" {
		t.Errorf("link text = %q", firstText(link))
	}
}

func TestMarkdownRenderer_LinkUnsafeSchemeDropped(t *testing.T) {
	r := NewMarkdownRenderer()
	for _, body := range []string{
		"click [here](javascript:alert(1))",
		"click [here](JavaScript:alert(1))",
		"see [x](data:text/html,<script>alert(1)</script>)",
		"open [y](vbscript:msgbox(1))",
	} {
		out := r.RenderToHast(body)
		if link := findFirstByTag(out, "a"); link != nil {
			t.Errorf("%q: expected no anchor for unsafe scheme, got href=%v", body, link.Properties["href"])
		}
		// The visible link text is preserved.
		if got := allText(out); !strings.Contains(got, "here") && !strings.Contains(got, "x") && !strings.Contains(got, "y") {
			t.Errorf("%q: expected link text preserved, got %q", body, got)
		}
	}
}

func TestIsSafeURL(t *testing.T) {
	cases := map[string]bool{
		"https://example.com":     true,
		"http://example.com":      true,
		"HTTPS://EXAMPLE.COM":     true,
		"mailto:x@example.com":    true,
		"/relative/path":          true, // slash before any colon
		"#anchor":                 true, // fragment first
		"?q=1":                    true, // query first
		"//cdn.example.com":       true, // scheme-relative
		"relative":                true, // no colon at all
		"a b:c":                   true, // space (non-scheme char) before colon
		"javascript:alert(1)":     false,
		"JavaScript:alert(1)":     false,
		"data:text/html,<script>": false,
		"vbscript:x":              false,
		"file:///etc/passwd":      false,
		"":                        false,
		"   ":                     false,
	}
	for in, want := range cases {
		if got := isSafeURL(in); got != want {
			t.Errorf("isSafeURL(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestMarkdownRenderer_LinkSafeSchemesKept(t *testing.T) {
	r := NewMarkdownRenderer()
	cases := map[string]string{
		"[a](https://example.com)":  "https://example.com",
		"[a](http://example.com)":   "http://example.com",
		"[a](mailto:x@example.com)": "mailto:x@example.com",
		"[a](/relative/path)":       "/relative/path",
		"[a](#anchor)":              "#anchor",
	}
	for body, want := range cases {
		out := r.RenderToHast(body)
		link := findFirstByTag(out, "a")
		if link == nil {
			t.Fatalf("%q: expected an anchor", body)
		}
		if link.Properties["href"] != want {
			t.Errorf("%q: href = %v, want %v", body, link.Properties["href"], want)
		}
	}
}

func TestMarkdownRenderer_BlankLinesMultiple(t *testing.T) {
	r := NewMarkdownRenderer()
	// Multiple-blank-line patterns produce one blank paragraph per
	// inter-block gap (heuristic). The exact count is bounded by the
	// number of adjacent block pairs.
	out := r.RenderToHast("a\n\nb")
	tags := topLevelTags(out)
	if len(tags) < 3 {
		t.Errorf("expected at least 3 blocks (a, blank, b), got %v", tags)
	}
}

func TestMarkdownRenderer_MultipleBlankLinesPreserveEachGap(t *testing.T) {
	r := NewMarkdownRenderer()
	// Regression: two blank lines between paragraphs must yield TWO
	// blank paragraphs (one per blank line), not collapse to one. The
	// composer exports "abc\n\n\nadsdaad" for abc + two empty lines +
	// adsdaad; the renderer previously stacked only a single blank <p>.
	out := r.RenderToHast("abc\n\n\nadsdaad")
	tags := topLevelTags(out)
	if len(tags) != 4 {
		t.Fatalf("expected 4 blocks (abc, blank, blank, adsdaad), got %v", tags)
	}
	for _, idx := range []int{1, 2} {
		if got, _ := out.Children[idx].Properties["data-blank"].(string); got != "true" {
			t.Errorf("child %d should be a blank paragraph, got props=%+v", idx, out.Children[idx].Properties)
		}
	}
	if got, _ := out.Children[0].Properties["data-blank"].(string); got == "true" {
		t.Errorf("first paragraph should not be blank")
	}
	if got, _ := out.Children[3].Properties["data-blank"].(string); got == "true" {
		t.Errorf("last paragraph should not be blank")
	}
}

// ----- helpers -----

func topLevelTags(root *HastNode) []string {
	out := make([]string, 0, len(root.Children))
	for _, c := range root.Children {
		if c.Type == "element" {
			out = append(out, c.TagName)
		}
	}
	return out
}

func flattenTags(node *HastNode) []string {
	out := []string{}
	if node.Type == "element" {
		out = append(out, node.TagName)
	}
	for _, c := range node.Children {
		out = append(out, flattenTags(c)...)
	}
	return out
}

func firstText(node *HastNode) string {
	if node.Type == "text" {
		return node.Value
	}
	for _, c := range node.Children {
		if t := firstText(c); t != "" {
			return t
		}
	}
	return ""
}

func allText(node *HastNode) string {
	if node.Type == "text" {
		return node.Value
	}
	var b strings.Builder
	for _, c := range node.Children {
		b.WriteString(allText(c))
	}
	return b.String()
}

func findFirstByTag(node *HastNode, tag string) *HastNode {
	if node.Type == "element" && node.TagName == tag {
		return node
	}
	for _, c := range node.Children {
		if hit := findFirstByTag(c, tag); hit != nil {
			return hit
		}
	}
	return nil
}
