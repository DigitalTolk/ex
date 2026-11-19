package service

import (
	"strings"
	"testing"
)

// outline renders a hast tree as tag{children} with text inline, so a test
// can state the whole block structure in one string.
func outline(n *HastNode) string {
	if n.Type == "text" {
		return strings.ReplaceAll(n.Value, "\n", "⏎")
	}
	parts := make([]string, 0, len(n.Children))
	for _, c := range n.Children {
		parts = append(parts, outline(c))
	}
	if n.Type == "root" {
		return strings.Join(parts, " ")
	}
	return n.TagName + "{" + strings.Join(parts, "") + "}"
}

func TestMarkdownRenderer_ListEndsAtUnindentedLine(t *testing.T) {
	r := NewMarkdownRenderer()
	cases := []struct {
		name, body, want string
	}{
		{
			// The reported message: the line under the list joined "GHI".
			name: "bullet list then a plain line",
			body: "Intro:\n- ABC\n- DEF\n- GHI\nAdditional info.",
			want: "p{Intro:} ul{li{ABC}li{DEF}li{GHI}} p{Additional info.}",
		},
		{
			name: "numbered list then a plain line",
			body: "1. one\n2. two\nAfter.",
			want: "ol{li{one}li{two}} p{After.}",
		},
		{
			name: "the paragraph after the list keeps going",
			body: "- a\nline one\nline two",
			want: "ul{li{a}} p{line one⏎line two}",
		},
		{
			name: "a new item after the plain line starts a new list",
			body: "- a\nbetween\n- b",
			want: "ul{li{a}} p{between} ul{li{b}}",
		},
		{
			// Indented text still belongs to the item.
			name: "indented continuation stays in the item",
			body: "- a\n  more of a",
			want: "ul{li{a⏎more of a}}",
		},
		{
			// Under a nested item, a line indented to the outer item's text
			// belongs to the outer item, not lazily to the nested one.
			name: "nested list, line indented to the outer item",
			body: "- a\n  - b\n  back in a",
			want: "ul{li{aul{li{b}}back in a}}",
		},
		{
			name: "nested list, unindented line",
			body: "- a\n  - b\nafter",
			want: "ul{li{aul{li{b}}}} p{after}",
		},
		{
			// A blank line already ended the list; unchanged.
			name: "blank line before the plain line",
			body: "- a\n\nafter",
			want: "ul{li{a}} p{ } p{after}",
		},
		{
			// Lazy continuation outside lists is left as CommonMark has it.
			name: "blockquote lazy line untouched",
			body: "> quoted\nstill quoted",
			want: "blockquote{p{quoted⏎still quoted}}",
		},
		{
			name: "plain paragraphs untouched",
			body: "one\ntwo",
			want: "p{one⏎two}",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := outline(r.RenderToHast(tc.body)); got != tc.want {
				t.Errorf("\nbody: %q\n got: %s\nwant: %s", tc.body, got, tc.want)
			}
		})
	}
}
