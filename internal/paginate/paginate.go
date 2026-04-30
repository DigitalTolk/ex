// Package paginate centralizes the cursor-loop pattern used by every
// "drain a paginated source" caller. Each caller previously inlined
// the same accumulate-pages-until-next-is-empty loop, which drifted
// in subtle ways (caps differ, break conditions differ, error
// handling differs). A single helper keeps them consistent.
package paginate

import "context"

// FetchPage returns the next page plus a continuation cursor. An empty
// `next` signals end-of-stream.
type FetchPage[T any] func(ctx context.Context, cursor string) (page []T, next string, err error)

// All accumulates every page until fetchPage returns an empty `next`.
// `maxRounds` caps the loop as a safety bound; pass 0 to disable the
// cap (only do this when the caller has external bounds on result
// size — a misbehaving cursor will otherwise pin the request).
func All[T any](ctx context.Context, fetchPage FetchPage[T], maxRounds int) ([]T, error) {
	out := make([]T, 0)
	cursor := ""
	for i := 0; maxRounds == 0 || i < maxRounds; i++ {
		page, next, err := fetchPage(ctx, cursor)
		if err != nil {
			return nil, err
		}
		out = append(out, page...)
		if next == "" {
			return out, nil
		}
		cursor = next
	}
	return out, nil
}
