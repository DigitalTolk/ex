package service

import (
	"strings"
	"testing"
)

func TestMarkdown_OrderedList(t *testing.T) {
	r := NewMarkdownRenderer()
	out := r.RenderToHast("1. one\n2. two")
	if got := flattenTags(out); !containsTag(got, "ol") {
		t.Errorf("expected ol in %v", got)
	}
}

func TestMarkdown_ThematicBreak(t *testing.T) {
	r := NewMarkdownRenderer()
	out := r.RenderToHast("a\n\n---\n\nb")
	if got := flattenTags(out); !containsTag(got, "hr") {
		t.Errorf("expected hr in %v", got)
	}
}

func TestMarkdown_SoftLineBreakInParagraph(t *testing.T) {
	r := NewMarkdownRenderer()
	out := r.RenderToHast("line one\nline two")
	if !strings.Contains(allText(out.Children[0]), "\n") {
		t.Errorf("expected newline from soft break, got %q", allText(out.Children[0]))
	}
}

func TestMarkdown_ImageFallbackRendersAsText(t *testing.T) {
	r := NewMarkdownRenderer()
	// Non-giphy image markdown is reconstructed into the text stream
	// (exercising the appendTextChild fallback) where the custom-syntax
	// walker turns it into an ex-media-literal element.
	out := r.RenderToHast("![alt text](https://example.com/x.png)")
	if got := flattenTags(out); !containsTag(got, "ex-media-literal") {
		t.Errorf("expected ex-media-literal from image fallback, got %v", got)
	}
}

func TestMarkdown_InlineRawHTMLHitsDefault(t *testing.T) {
	r := NewMarkdownRenderer()
	// Inline raw HTML tags become *ast.RawHTML, which falls through to the
	// default switch arm (drops the tag, keeps surrounding text).
	out := r.RenderToHast("a <b>x</b> b")
	if got := allText(out); !strings.Contains(got, "a ") || !strings.Contains(got, "x") {
		t.Errorf("expected text content preserved, got %q", got)
	}
}

func TestMarkdown_AppendTextChild_EmptyValueIgnored(t *testing.T) {
	parent := &HastNode{Type: "element", TagName: "p", Children: []*HastNode{}}
	appendTextChild(parent, "")
	if len(parent.Children) != 0 {
		t.Errorf("empty value should be ignored, got %d children", len(parent.Children))
	}
}

func TestMarkdown_WalkAndExtractCustom_NilNode(t *testing.T) {
	// Direct call with nil exercises the nil-guard early return.
	walkAndExtractCustom(nil)
}

func TestExtractCustomTokens_EmptyInput(t *testing.T) {
	if got := extractCustomTokens(""); got != nil {
		t.Errorf("empty input should return nil, got %v", got)
	}
}

func containsTag(tags []string, want string) bool {
	for _, t := range tags {
		if t == want {
			return true
		}
	}
	return false
}
