package service

import (
	"strings"
	"testing"
)

// A relative link onto the app's own /auth/ routes (the desktop-login
// completion, the OIDC callback) must never be a clickable anchor in a
// message: one click would replay a login code or hand a session to the
// poster. Every spelling a browser would resolve there counts.
func TestIsAppAuthLink(t *testing.T) {
	cases := map[string]bool{
		"/auth/desktop/complete?code=X": true,
		"/auth":                         true,
		"/auth/":                        true,
		"/auth?x=1":                     true,
		"/auth#frag":                    true,
		"/AUTH/oidc/callback":           true, // case-insensitive
		"/%61uth/desktop/complete":      true, // percent-encoded letter
		"/%41UTH/x":                     true,
		"/%2e%2e/auth/x":                true, // encoded dot segment
		"../auth/x":                     true, // climbs to the root from any page
		"../../../auth/x":               true,
		"/./auth/x":                     true,
		"/channel/../auth/x":            true,
		"auth/x":                        true, // relative to a root-level page
		"x/../../auth":                  true,
		`\auth\desktop\complete`:        true, // browsers read \ as /
		"/au\tth/x":                     true, // tab/newline are dropped
		"/au\nth/x":                     true,
		"  /auth/x  ":                   true, // surrounding space trimmed
		"/auth/%zz":                     true, // unparsable: blocked, never a live link
		"/authors":                      false,
		"/author/x":                     false,
		"/channel/auth/x":               false,
		"/channel/general":              false,
		"auth.example.com/x":            false,
		"#auth":                         false,
		"?auth=1":                       false,
		"https://example.com/auth/x":    false, // absolute: another host's /auth
		"http://example.com/auth":       false,
		"//example.com/auth/x":          false, // scheme-relative names a host
		`\\example.com\auth`:            false, // browsers read \\ as //
		"mailto:auth@example.com":       false,
		"":                              false,
	}
	for in, want := range cases {
		if got := isAppAuthLink(in); got != want {
			t.Errorf("isAppAuthLink(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestMarkdownRenderer_AuthLinkRendersAsText(t *testing.T) {
	r := NewMarkdownRenderer()
	for _, body := range []string{
		"[open me](/auth/desktop/complete?code=X)",
		"[open me](../auth/desktop/complete?code=X)",
		"[open me](/%61uth/desktop/complete?code=X)",
		"[open me](/./AUTH/oidc/callback)",
	} {
		out := r.RenderToHast(body)
		if link := findFirstByTag(out, "a"); link != nil {
			t.Errorf("%q: expected no anchor onto /auth/, got href=%v", body, link.Properties["href"])
		}
		if got := allText(out); !strings.Contains(got, "open me") {
			t.Errorf("%q: link text lost, got %q", body, got)
		}
	}
}

func TestMarkdownRenderer_NonAuthLinksStayLinks(t *testing.T) {
	r := NewMarkdownRenderer()
	for body, want := range map[string]string{
		"[a](https://example.com/auth/x)": "https://example.com/auth/x",
		"[a](/authors)":                   "/authors",
		"[a](/channel/general)":           "/channel/general",
	} {
		link := findFirstByTag(r.RenderToHast(body), "a")
		if link == nil {
			t.Fatalf("%q: expected an anchor", body)
		}
		if link.Properties["href"] != want {
			t.Errorf("%q: href = %v, want %v", body, link.Properties["href"], want)
		}
	}
}
