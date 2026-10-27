package model

import "strings"

// namePrefixes are leading name words people are not called by. "Muhammad"
// (in its common spellings and abbreviations) opens a great many Pakistani
// names: "Muhammad Ali Khan" goes by Ali Khan, and calling everyone
// "Muhammad" names nobody. Keep in step with NAME_PREFIXES in
// src/lib/format.ts.
var namePrefixes = map[string]bool{
	"muhammad": true,
	"muhammed": true,
	"mohammad": true,
	"mohammed": true,
	"mohamed":  true,
	"mohamad":  true,
	"muhamad":  true,
	"mohd":     true,
	"md":       true,
}

// IsNamePrefix reports whether word is a leading name word people are not
// called by ("Muhammad", "Md."), case- and trailing-dot-insensitive.
func IsNamePrefix(word string) bool {
	return namePrefixes[strings.ToLower(strings.TrimSuffix(word, "."))]
}

// ShortName is the name a person goes by: the first word of their display
// name, or — for a name opening with a name prefix — everything after the
// prefix: "Muhammad Ali Khan" → "Ali Khan", since so many go by Ali that the
// next word alone would still name a crowd. A name that is nothing but
// prefixes keeps its first word.
func ShortName(displayName string) string {
	words := strings.Fields(displayName)
	rest := 0
	for rest < len(words) && IsNamePrefix(words[rest]) {
		rest++
	}
	switch {
	case len(words) == 0:
		return ""
	case rest == 0 || rest == len(words):
		return words[0]
	default:
		return strings.Join(words[rest:], " ")
	}
}
