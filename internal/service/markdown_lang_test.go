package service

import "testing"

func TestNormalizeCodeLanguageGo(t *testing.T) {
	cases := map[string]string{
		"C++":   "cpp",
		"c#":    "csharp",
		"F#":    "fsharp",
		"JS":    "javascript",
		"py":    "python",
		"rb":    "ruby",
		"sh":    "bash",
		"ts":    "typescript",
		"Rust":  "rust",
		"Go!":   "go",
		"--x--": "x",
		"a b c": "a-b-c",
	}
	for in, want := range cases {
		if got := normalizeCodeLanguageGo(in); got != want {
			t.Errorf("normalizeCodeLanguageGo(%q) = %q, want %q", in, got, want)
		}
	}
}
