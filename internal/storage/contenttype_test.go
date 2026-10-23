package storage

import "testing"

func TestServedContentType(t *testing.T) {
	for _, tc := range []struct {
		raw    string
		want   string
		inline bool
	}{
		{"image/png", "image/png", true},
		{"Image/PNG", "image/png", true},
		{"image/jpeg", "image/jpeg", true},
		{"text/plain; charset=UTF-8", "text/plain; charset=UTF-8", true},
		{"video/mp4", "video/mp4", true},
		{"application/pdf", "application/pdf", true},
		// A comma list renders as its last type in a browser.
		{"image/png, text/html", octetStream, false},
		{"image/png,text/html; charset=utf-8", octetStream, false},
		{"", octetStream, false},
		{"not a type", octetStream, false},
		// Scriptable types never render inline.
		{"text/html", "text/html", false},
		{"TEXT/HTML; charset=utf-8", "text/html; charset=utf-8", false},
		{"application/xhtml+xml", "application/xhtml+xml", false},
		{"image/svg+xml", "image/svg+xml", false},
		{"application/xml", "application/xml", false},
		{"text/xml", "text/xml", false},
		{"application/foo+xml", "application/foo+xml", false},
	} {
		got, inline := ServedContentType(tc.raw)
		if got != tc.want || inline != tc.inline {
			t.Errorf("ServedContentType(%q) = %q, %v; want %q, %v", tc.raw, got, inline, tc.want, tc.inline)
		}
	}
}
