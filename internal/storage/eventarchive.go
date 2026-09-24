package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"io"

	"github.com/DigitalTolk/ex/internal/model"
)

// EventArchive rolls a terminal run's timeline into a single object-storage
// blob so the hot DynamoDB table carries only live runs' events. One immutable
// object per run: run-events/<runID>.json (a JSON array of RunEvent). It is
// written once, when the run reaches a terminal state, and read back only when
// the Activity drawer opens an archived run.
type EventArchive struct {
	s3 *S3Client
}

// NewEventArchive wires the archive over an S3 client. A nil client disables
// archiving upstream (the orchestrator keeps events in DynamoDB instead).
func NewEventArchive(c *S3Client) *EventArchive { return &EventArchive{s3: c} }

func eventArchiveKey(runID string) string { return "run-events/" + runID + ".json" }

// Archive writes the run's full event list as one JSON array. Overwrites are
// harmless (idempotent): the same terminal run always produces the same log.
func (a *EventArchive) Archive(ctx context.Context, runID string, events []*model.RunEvent) error {
	body, err := json.Marshal(events)
	if err != nil {
		return fmt.Errorf("archive: marshal events: %w", err)
	}
	return a.s3.PutObject(ctx, eventArchiveKey(runID), "application/json", body)
}

// Delete removes a run's archived log — called when the chat it belongs to is
// deleted, so a message's logs don't outlive it. A missing object is not an
// error (S3 DeleteObject is idempotent).
func (a *EventArchive) Delete(ctx context.Context, runID string) error {
	return a.s3.DeleteObject(ctx, eventArchiveKey(runID))
}

// Load reads back an archived run's events, restoring RunID on each (it rides
// the JSON but is elided from the DynamoDB mapping, so belt-and-suspenders).
func (a *EventArchive) Load(ctx context.Context, runID string) ([]*model.RunEvent, error) {
	body, _, _, _, err := a.s3.GetObject(ctx, eventArchiveKey(runID))
	if err != nil {
		return nil, fmt.Errorf("archive: get events: %w", err)
	}
	defer func() { _ = body.Close() }()
	raw, err := io.ReadAll(body)
	if err != nil {
		return nil, fmt.Errorf("archive: read events: %w", err)
	}
	var events []*model.RunEvent
	if err := json.Unmarshal(raw, &events); err != nil {
		return nil, fmt.Errorf("archive: unmarshal events: %w", err)
	}
	for _, e := range events {
		if e != nil {
			e.RunID = runID
		}
	}
	return events, nil
}
