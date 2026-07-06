package search

import "fmt"

// mustJSON wraps json.Marshal calls whose failure is a programmer error,
// not a runtime condition: marshaling maps of string-keyed literals and
// scalar strings (the _aliases action payload, the _bulk action header)
// cannot fail for any input this package produces, so their error
// branches were permanently dead — untestable without faking the encoder.
// Collapsing them into panic-on-impossible (the template.Must idiom, same
// as internal/store's must helpers) keeps the contract explicit while
// leaving no unreachable lines behind. NOTE: marshaling caller-supplied
// documents (IndexDoc, Bulk entry Docs, Search bodies) is NOT in this
// family — those can carry unmarshalable values, so their error branches
// stay and are exercised by tests feeding a channel-typed value.
func mustJSON(b []byte, err error) []byte {
	if err != nil {
		panic(fmt.Sprintf("search: static value failed to marshal to JSON: %v", err))
	}
	return b
}
