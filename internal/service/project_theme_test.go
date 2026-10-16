package service

import (
	"strings"
	"testing"
)

func TestCondenseThemeCSS(t *testing.T) {
	css := `/* tokens */
@import "tailwindcss";
@import url('https://fonts.example.com/css?family=Inter');
@plugin "@tailwindcss/typography";
@custom-variant dark (&:is(.dark *));
@theme inline {
  --color-background: var(--background);
  --radius-sm: calc(var(--radius) - 4px);
}
:root {
  --background:   oklch(1 0 0);
  --radius: 0.25rem
}
.dark { --background: oklch(0.1 0 0); }
@media (prefers-color-scheme: dark) { :root { --accent: #111; } }
body { font-family: Inter, system-ui; color: red; }
.card { font-family: Comic; --local: 1px; }
@font-face { font-family: "Geist"; src: url(/geist.woff2); }
.weird { nonsense }
}`
	got, n := CondenseThemeCSS(css)
	if n != 6 {
		t.Fatalf("variables = %d\n%s", n, got)
	}
	for _, want := range []string{
		"Imports: tailwindcss, https://fonts.example.com/css?family=Inter · plugins: @tailwindcss/typography",
		"Fonts: body → Inter, system-ui; @font-face → \"Geist\"",
		"@theme inline\n  --radius-sm: calc(var(--radius) - 4px)",
		":root\n  --background: oklch(1 0 0)\n  --radius: 0.25rem",
		".dark\n  --background: oklch(0.1 0 0)",
		"@media (prefers-color-scheme: dark) › :root\n  --accent: #111",
		".card\n  --local: 1px",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("summary missing %q:\n%s", want, got)
		}
	}
	for _, unwanted := range []string{"--color-background", "tokens", "Comic", "color: red"} {
		if strings.Contains(got, unwanted) {
			t.Errorf("summary should drop %q:\n%s", unwanted, got)
		}
	}
}

func TestCondenseThemeCSS_PlainAndHuge(t *testing.T) {
	if got, n := CondenseThemeCSS(".a { color: red; }"); n != 0 || got != "" {
		t.Fatalf("no tokens: %q %d", got, n)
	}
	if got, n := CondenseThemeCSS(`@import "x";`); n != 0 || got != "Imports: x" {
		t.Fatalf("imports only: %q %d", got, n)
	}
	var b strings.Builder
	b.WriteString(":root {")
	for i := 0; i < 600; i++ {
		b.WriteString("--token-" + strings.Repeat("x", 10) + string(rune('a'+i%26)) + ": " + strings.Repeat("v", 200) + ";")
	}
	b.WriteString("}")
	got, n := CondenseThemeCSS(b.String())
	if n != 600 || len(got) > themeSummaryMaxChars+400 || !strings.Contains(got, "more variables not shown") || !strings.Contains(got, "…") {
		t.Fatalf("huge theme: n=%d len=%d tail=%q", n, len(got), got[len(got)-60:])
	}
	// A group header past the budget stops the listing too.
	var two strings.Builder
	two.WriteString(":root {")
	for i := 0; i < 45; i++ {
		two.WriteString("--a" + strings.Repeat("y", 3) + ": " + strings.Repeat("v", 170) + ";")
	}
	two.WriteString("} .dark { --z: 1; }")
	if got, n := CondenseThemeCSS(two.String()); n != 46 || strings.Contains(got, ".dark") {
		t.Fatalf("budget before the second group: n=%d dark=%v", n, strings.Contains(got, ".dark"))
	}
}
