// Keyword matching for notification triggers: whole-word, boundary-aware
// matching over the message body. Split out of notification.go (2026-08-12).

package service

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// matchesKeywords reports whether body contains any of the recipient's
// notification keywords as a whole word, case-insensitively. Keywords let the
// quiet "mentions, DMs & keywords only" level still surface messages a user
// cares about even when they're not @-mentioned.
func matchesKeywords(body string, keywords []string) bool {
	if body == "" || len(keywords) == 0 {
		return false
	}
	return keywordsMatchLower(strings.ToLower(body), keywords)
}

// keywordsMatchLower is matchesKeywords with the body already lowercased. The
// per-message hot path lowercases msg.Body once and reuses it across every
// recipient's keyword list rather than re-lowercasing the whole body per member.
func keywordsMatchLower(lowerBody string, keywords []string) bool {
	for _, kw := range keywords {
		kw = strings.ToLower(strings.TrimSpace(kw))
		if kw == "" {
			continue
		}
		if containsWord(lowerBody, kw) {
			return true
		}
	}
	return false
}

// containsWord reports whether needle appears in haystack bounded by non-word
// characters on both sides (a lightweight \bneedle\b without compiling a regex
// per keyword per message). Both arguments are expected to be lowercased.
// Boundaries are Unicode-aware so accented and non-Latin keywords (common at a
// translation company, and seeded from display names) match on whole words
// rather than mid-word — e.g. "ann" must not fire inside "annü".
func containsWord(haystack, needle string) bool {
	from := 0
	for {
		idx := strings.Index(haystack[from:], needle)
		if idx < 0 {
			return false
		}
		start := from + idx
		end := start + len(needle)
		if boundaryBefore(haystack, start) && boundaryAfter(haystack, end) {
			return true
		}
		from = start + 1
	}
}

// boundaryBefore reports whether byte offset i begins a word — true at the start
// of the string or when the preceding rune is not a word rune.
func boundaryBefore(s string, i int) bool {
	if i <= 0 {
		return true
	}
	r, _ := utf8.DecodeLastRuneInString(s[:i])
	return !isWordRune(r)
}

// boundaryAfter reports whether byte offset i ends a word — true at the end of
// the string or when the following rune is not a word rune.
func boundaryAfter(s string, i int) bool {
	if i >= len(s) {
		return true
	}
	r, _ := utf8.DecodeRuneInString(s[i:])
	return !isWordRune(r)
}

// isWordRune treats Unicode letters and digits (plus underscore) as word
// characters so whole-word boundaries hold for accented and non-Latin alphabets
// (e.g. "ann" must not fire inside "annü"). Ideographic / syllabic scripts
// (Han, Kana, Hangul) are excluded because they're written without spaces — each
// such rune is its own word, so a CJK keyword still matches as a substring of
// CJK text rather than being blocked by a non-existent word boundary.
func isWordRune(r rune) bool {
	if r == '_' {
		return true
	}
	if !unicode.IsLetter(r) && !unicode.IsDigit(r) {
		return false
	}
	return !unicode.In(r, unicode.Han, unicode.Hiragana, unicode.Katakana, unicode.Hangul)
}
