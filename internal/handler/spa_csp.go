package handler

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"slices"

	"golang.org/x/net/html"
)

// inlineScriptHashes returns a CSP hash source ('sha256-…') for every inline
// <script> in page, in document order and without repeats, so the app page's
// script-src can allow exactly its own inline scripts instead of
// 'unsafe-inline'. A browser hashes a script's text as its parser hands it
// over (newlines normalized, no entity decoding) — which is what the
// tokenizer returns — so this must run over the bytes actually served.
func inlineScriptHashes(page []byte) []string {
	z := html.NewTokenizer(bytes.NewReader(page))
	var hashes []string
	var text []byte
	inline := false
	for {
		switch z.Next() {
		case html.ErrorToken:
			// io.EOF: a bytes.Reader has no other way to fail.
			return hashes
		case html.StartTagToken:
			if name, hasAttr := z.TagName(); string(name) == "script" {
				inline = !hasSrcAttr(z, hasAttr)
				text = text[:0]
			}
		case html.TextToken:
			if inline {
				text = append(text, z.Text()...)
			}
		case html.EndTagToken:
			if name, _ := z.TagName(); inline && string(name) == "script" {
				sum := sha256.Sum256(text)
				if hash := "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"; !slices.Contains(hashes, hash) {
					hashes = append(hashes, hash)
				}
				inline = false
			}
		}
	}
}

// hasSrcAttr reports whether the start tag the tokenizer is on has a src
// attribute (an external script, checked against 'self' instead).
func hasSrcAttr(z *html.Tokenizer, more bool) bool {
	for more {
		var key []byte
		key, _, more = z.TagAttr()
		if string(key) == "src" {
			return true
		}
	}
	return false
}
