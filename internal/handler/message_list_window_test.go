package handler

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func TestWriteMessageWindow_EmptyAndPopulated(t *testing.T) {
	// Nil messages coerce to an empty array with blank cursors.
	rec := httptest.NewRecorder()
	writeMessageWindow(rec, nil, false, false)
	var empty struct {
		Items    []json.RawMessage `json:"items"`
		OldestID string            `json:"oldestID"`
		NewestID string            `json:"newestID"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&empty); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if empty.Items == nil || len(empty.Items) != 0 {
		t.Fatalf("nil messages should serialize as empty array, got %v", empty.Items)
	}
	if empty.OldestID != "" || empty.NewestID != "" {
		t.Fatalf("empty window should have blank cursors, got %q/%q", empty.OldestID, empty.NewestID)
	}

	// Populated window reports newest-first cursors.
	rec = httptest.NewRecorder()
	msgs := []*model.Message{{ID: "m-newest"}, {ID: "m-mid"}, {ID: "m-oldest"}}
	writeMessageWindow(rec, msgs, true, false)
	var got struct {
		OldestID     string `json:"oldestID"`
		NewestID     string `json:"newestID"`
		HasMoreOlder bool   `json:"hasMoreOlder"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.NewestID != "m-newest" || got.OldestID != "m-oldest" {
		t.Fatalf("cursors = %q/%q, want m-newest/m-oldest", got.NewestID, got.OldestID)
	}
	if !got.HasMoreOlder {
		t.Error("hasMoreOlder should be true")
	}
}
