package search

import "fmt"

// must unwraps calls whose error is a programmer error, not a runtime
// condition: marshaling maps of string-keyed literals (the _aliases action
// payload), building the SigV4 signer with a non-empty service, and
// building a BulkIndexer around an existing client cannot fail for any
// input this package produces, so their error branches would be
// permanently dead. Collapsing them into panic-on-impossible (the
// template.Must idiom, same as internal/store's must helpers) keeps the
// contract explicit while leaving no unreachable lines behind. NOTE:
// marshaling caller-supplied documents (IndexDoc, Bulk entry Docs, Search
// bodies) is NOT in this family — those can carry unmarshalable values, so
// their error branches stay and are exercised by tests feeding a
// channel-typed value.
func must[T any](v T, err error) T {
	if err != nil {
		panic(fmt.Sprintf("search: impossible error: %v", err))
	}
	return v
}
