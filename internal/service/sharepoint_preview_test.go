package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/msgraph"
)

func TestPreviewShowsTheFileAsTheViewer(t *testing.T) {
	h := newSPHarness(t)
	ctx := context.Background()
	h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	h.graph.preview = "https://contoso.sharepoint.com/sites/team/_layouts/15/embed.aspx"

	// Bob's own token asks for it: the address acts as him, not as alice.
	got, err := h.svc.Preview(ctx, "bob", "ch-sp", ParentChannel, spItemID)
	if err != nil || got != h.graph.preview+"?item=drive-1/item-1&as=tok-bob" {
		t.Fatalf("preview = %q, %v", got, err)
	}
}

func TestPreviewRefusals(t *testing.T) {
	h := newSPHarness(t)
	ctx := context.Background()
	msg := h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	h.graph.preview = "https://contoso.sharepoint.com/embed"

	h.access.err = ErrForbidden
	if _, err := h.svc.Preview(ctx, "bob", "ch-sp", ParentChannel, spItemID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("no access: err = %v", err)
	}
	h.access.err = nil
	if _, err := h.svc.Preview(ctx, "bob", "ch-sp", ParentChannel, "unknown"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown file: err = %v", err)
	}
	// A viewer ex holds no sign-in for (a guest, or before signing in again).
	h.tokens.missing["bob"] = true
	if _, err := h.svc.Preview(ctx, "bob", "ch-sp", ParentChannel, spItemID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("no token: err = %v", err)
	}
	h.tokens.missing["bob"] = false
	for _, gerr := range []error{msgraph.ErrNotFound, msgraph.ErrForbidden} {
		h.graph.previewErr = gerr
		if _, err := h.svc.Preview(ctx, "bob", "ch-sp", ParentChannel, spItemID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%v: err = %v, want ErrNotFound", gerr, err)
		}
	}
	h.graph.previewErr = errors.New("503")
	if _, err := h.svc.Preview(ctx, "bob", "ch-sp", ParentChannel, spItemID); err == nil || !strings.Contains(err.Error(), "preview") {
		t.Fatalf("outage: err = %v", err)
	}
	h.graph.previewErr = nil
	// Only a SharePoint host is ever framed.
	h.graph.preview = "https://elsewhere.example.com/embed"
	if _, err := h.svc.Preview(ctx, "bob", "ch-sp", ParentChannel, spItemID); err == nil || !strings.Contains(err.Error(), "not a SharePoint host") {
		t.Fatalf("foreign host: err = %v", err)
	}
	h.records.getItemErr = errors.New("dynamo")
	if _, err := h.svc.Preview(ctx, "bob", "ch-sp", ParentChannel, spItemID); err == nil || !strings.Contains(err.Error(), "read file") {
		t.Fatalf("store: err = %v", err)
	}
	h.records.getItemErr = nil

	// A retired file, and a folder, have no preview.
	h.tokens.missing["alice"] = true
	msg.Body = "never mind"
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	if _, err := h.svc.Preview(ctx, "bob", "ch-sp", ParentChannel, spItemID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("retired: err = %v", err)
	}
	it := h.records.item("ch-sp", spItemID)
	it.Retired, it.Folder = false, true
	_ = h.records.PutSharePointItem(ctx, it)
	if _, err := h.svc.Preview(ctx, "bob", "ch-sp", ParentChannel, spItemID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("folder: err = %v", err)
	}
}
