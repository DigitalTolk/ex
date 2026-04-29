package main

import (
	"context"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// attachmentResolver looks up attachment metadata for the search
// indexer. Per-message attachment counts are capped well below 100,
// so a sequential loop over GetByID is fine; switching to a batched
// DDB BatchGetItem only matters at much larger volumes.
type attachmentResolver struct {
	s *store.AttachmentStoreImpl
}

func newAttachmentResolver(s *store.AttachmentStoreImpl) *attachmentResolver {
	return &attachmentResolver{s: s}
}

func (r *attachmentResolver) ResolveFilenames(ctx context.Context, ids []string) []string {
	atts := r.ResolveAttachments(ctx, ids)
	out := make([]string, 0, len(atts))
	for _, a := range atts {
		if a.Filename != "" {
			out = append(out, a.Filename)
		}
	}
	return out
}

func (r *attachmentResolver) ResolveAttachments(ctx context.Context, ids []string) []*model.Attachment {
	if len(ids) == 0 || r.s == nil {
		return nil
	}
	out := make([]*model.Attachment, 0, len(ids))
	for _, id := range ids {
		a, err := r.s.GetByID(ctx, id)
		if err != nil || a == nil {
			continue
		}
		out = append(out, a)
	}
	return out
}
