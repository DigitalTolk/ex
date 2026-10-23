package service

import "fmt"

// Panic-on-impossible helpers (the template.Must idiom): the wrapped calls
// cannot fail for the inputs this package produces, so their error branches at
// the call sites were permanently dead. See internal/store/must.go for the
// same policy on the storage side.

// mustThumb unwraps encodeWebPThumbnail for images the caller just decoded —
// a failure would be a programmer error.
func mustThumb(b []byte, err error) []byte {
	if err != nil {
		panic(fmt.Sprintf("service: thumbnail encode of a just-decoded image failed: %v", err))
	}
	return b
}

// mustEncode checks an image encode into a bytes.Buffer of an image the
// caller just built — a failure would be a programmer error.
func mustEncode(err error) {
	if err != nil {
		panic(fmt.Sprintf("service: encode of an in-memory image failed: %v", err))
	}
}

// mustLRU unwraps a golang-lru constructor, which fails only for a
// non-positive size — every caller passes a positive constant.
func mustLRU[T any](c T, err error) T {
	if err != nil {
		panic(fmt.Sprintf("service: LRU cache construction failed: %v", err))
	}
	return c
}

// mustJSONBody unwraps json.Marshal of request structs composed solely of
// strings and string maps/slices.
func mustJSONBody(b []byte, err error) []byte {
	if err != nil {
		panic(fmt.Sprintf("service: static struct failed to marshal to JSON: %v", err))
	}
	return b
}
