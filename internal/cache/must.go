package cache

import "fmt"

// mustJSON returns the encoded bytes, panicking on the impossible error —
// used only for cache records made of scalar/string/time fields
// (json.Marshal of such shapes cannot fail). Same template.Must idiom as
// internal/store/must.go: a permanently-dead error branch is a panic, not an
// unreachable return.
func mustJSON(b []byte, err error) []byte {
	if err != nil {
		panic(fmt.Sprintf("cache: static struct failed to marshal to JSON: %v", err))
	}
	return b
}
