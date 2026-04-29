package main

import (
	"context"

	"github.com/DigitalTolk/ex/internal/search"
)

// idSearcher narrows search.Searcher's full-hit responses to the bare
// IDs the service-layer hooks consume. Two methods (Users/Channels)
// share one type since they only differ in which underlying call they
// dispatch to.
type idSearcher struct {
	s search.Searcher
}

func newIDSearcher(s search.Searcher) *idSearcher { return &idSearcher{s: s} }

func (a *idSearcher) Users(ctx context.Context, q string, limit int) ([]string, error) {
	res, err := a.s.Users(ctx, q, limit)
	if err != nil || res == nil {
		return nil, err
	}
	return hitIDs(res.Hits), nil
}

func (a *idSearcher) Channels(ctx context.Context, q string, limit int) ([]string, error) {
	res, err := a.s.Channels(ctx, q, limit)
	if err != nil || res == nil {
		return nil, err
	}
	return hitIDs(res.Hits), nil
}

func hitIDs(hits []search.SearchHit) []string {
	out := make([]string, len(hits))
	for i, h := range hits {
		out[i] = h.ID
	}
	return out
}
