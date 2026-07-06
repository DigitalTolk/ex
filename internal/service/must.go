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

// mustJSONBody unwraps json.Marshal of request structs composed solely of
// strings and string maps/slices.
func mustJSONBody(b []byte, err error) []byte {
	if err != nil {
		panic(fmt.Sprintf("service: static struct failed to marshal to JSON: %v", err))
	}
	return b
}
