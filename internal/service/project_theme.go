package service

import (
	"fmt"
	"regexp"
	"strings"
)

// CondenseThemeCSS turns a project's main stylesheet (globals.css and the
// like) into the few lines a design agent needs, so a 40 KB file costs a few
// hundred tokens: the imports and plugins (they name the stack — tailwindcss,
// shadcn/tailwind.css…), every CSS custom property grouped by selector
// (:root, .dark, @theme…), and font families. Pure aliases inside @theme
// (`--color-x: var(--x)`) are dropped — they only restate the variables.
// Ordinary rules (.status-pill { … }) are ignored. Returns the summary and
// how many variables it kept.
func CondenseThemeCSS(css string) (string, int) {
	css = cssComment.ReplaceAllString(css, "")
	var (
		imports, plugins, fonts []string
		groups                  []*themeGroup
		byPath                  = map[string]*themeGroup{}
		stack                   []string
		buf                     strings.Builder
		count                   int
	)
	path := func() string { return strings.Join(stack, " › ") }
	decl := func(raw string) {
		d := strings.TrimSpace(raw)
		if d == "" {
			return
		}
		if len(stack) == 0 {
			switch {
			case strings.HasPrefix(d, "@import"):
				imports = append(imports, cssArg(d, "@import"))
			case strings.HasPrefix(d, "@plugin"):
				plugins = append(plugins, cssArg(d, "@plugin"))
			}
			return
		}
		name, value, ok := strings.Cut(d, ":")
		if !ok {
			return
		}
		name, value = strings.TrimSpace(name), cssValue(value)
		switch {
		case strings.HasPrefix(name, "--"):
			if strings.HasPrefix(stack[0], "@theme") && cssAlias.MatchString(value) {
				return
			}
			p := path()
			g := byPath[p]
			if g == nil {
				g = &themeGroup{path: p}
				byPath[p] = g
				groups = append(groups, g)
			}
			g.vars = append(g.vars, name+": "+value)
			count++
		case name == "font-family":
			if top := stack[len(stack)-1]; fontScope[top] {
				fonts = append(fonts, top+" → "+value)
			}
		}
	}
	for _, r := range css {
		switch r {
		case '{':
			stack = append(stack, strings.Join(strings.Fields(buf.String()), " "))
			buf.Reset()
		case ';':
			decl(buf.String())
			buf.Reset()
		case '}':
			decl(buf.String())
			buf.Reset()
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		default:
			buf.WriteRune(r)
		}
	}

	var b strings.Builder
	if len(imports) > 0 || len(plugins) > 0 {
		b.WriteString("Imports: " + strings.Join(imports, ", "))
		if len(plugins) > 0 {
			b.WriteString(" · plugins: " + strings.Join(plugins, ", "))
		}
		b.WriteString("\n")
	}
	if len(fonts) > 0 {
		b.WriteString("Fonts: " + strings.Join(fonts, "; ") + "\n")
	}
	shown := 0
	for _, g := range groups {
		if b.Len() > themeSummaryMaxChars {
			break
		}
		b.WriteString(g.path + "\n")
		for _, v := range g.vars {
			if b.Len() > themeSummaryMaxChars {
				break
			}
			b.WriteString("  " + v + "\n")
			shown++
		}
	}
	if shown < count {
		fmt.Fprintf(&b, "(+%d more variables not shown)\n", count-shown)
	}
	return strings.TrimRight(b.String(), "\n"), count
}

type themeGroup struct {
	path string
	vars []string
}

// themeSummaryMaxChars bounds the condensed theme in a bundle (~2k tokens).
const themeSummaryMaxChars = 7000

var (
	cssComment = regexp.MustCompile(`(?s)/\*.*?\*/`)
	cssAlias   = regexp.MustCompile(`^var\(--[\w-]+\)$`)
	fontScope  = map[string]bool{"html": true, "body": true, ":root": true, "*": true, "@font-face": true}
)

// cssArg is the argument of an at-statement, unquoted: @import "x" → x.
func cssArg(stmt, at string) string {
	arg := strings.TrimSpace(strings.TrimPrefix(stmt, at))
	arg = strings.TrimPrefix(strings.TrimSuffix(arg, ")"), "url(")
	return strings.Trim(arg, `"' `)
}

// cssValue collapses whitespace and caps one value's length.
func cssValue(v string) string {
	v = strings.Join(strings.Fields(v), " ")
	if len(v) > 160 {
		v = v[:160] + "…"
	}
	return v
}
