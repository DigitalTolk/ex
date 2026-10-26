package events

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// ephemeralFixture is the frontend's copy of ephemeralTypes. The client must
// not advance its replay cursor on an ephemeral frame (its ULID can outrun an
// in-flight durable message.new, and the next reconnect's ?since= would skip
// that message), so src/lib/event-types.ts keeps the same set — and
// src/lib/event-types.test.ts asserts it against this file. The file lives in
// the frontend test tree so vitest imports it directly, as with the wire
// goldens in internal/service.
const ephemeralFixture = "../../src/test/wire-fixtures/ephemeral_event_types.json"

// TestEphemeralTypesFixture fails when the fixture no longer matches
// ephemeralTypes. Refresh it with UPDATE_GOLDEN=1, then update
// EPHEMERAL_EVENT_TYPES until the frontend test passes again.
func TestEphemeralTypesFixture(t *testing.T) {
	names := make([]string, 0, len(ephemeralTypes))
	for name := range ephemeralTypes {
		names = append(names, name)
	}
	sort.Strings(names)
	raw, err := json.MarshalIndent(names, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	raw = append(raw, '\n')

	path := filepath.Clean(ephemeralFixture)
	if os.Getenv("UPDATE_GOLDEN") == "1" {
		if err := os.WriteFile(path, raw, 0o644); err != nil {
			t.Fatalf("write fixture: %v", err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture %s: %v (run UPDATE_GOLDEN=1 go test ./internal/events to refresh)", path, err)
	}
	if string(want) != string(raw) {
		t.Errorf("%s is stale — run UPDATE_GOLDEN=1 go test ./internal/events and update EPHEMERAL_EVENT_TYPES in src/lib/event-types.ts\nwant:\n%s\ngot:\n%s", path, want, raw)
	}
}
