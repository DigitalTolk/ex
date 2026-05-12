package service

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// Wire-format golden tests. Every message a client sees is shaped
// by these JSON encodings — a silent change to the on-wire format
// has historically translated to either a frontend parse failure
// (events dropped, cache corrupted) or a render crash (children:[]
// stripped → React unmounts the entire tree → "chat goes black").
//
// These tests pin the JSON encoding of every wire-bearing struct
// and write the snapshots to testdata/. When the JSON encoding
// changes you'll see the diff first — silent regressions are not
// possible.
//
// Frontend mirrors these snapshots in
//   frontend/src/test/wire-fixtures.browser.test.tsx
// to assert that the same JSON parses + renders cleanly. The golden
// files live INSIDE the frontend test tree (not at project root)
// so the frontend can `import` them directly — single source of
// truth, no copy step needed. A backend wire-format change
// regenerates the snapshot; the frontend test then fails on the
// next CI run until its expectations are updated to match.

const goldenDir = "../../frontend/src/test/wire-fixtures"

func TestWireGolden_Message_FullyPopulated(t *testing.T) {
	r := NewMarkdownRenderer()
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	pinAt := now.Add(time.Hour)
	editAt := now.Add(2 * time.Hour)
	lastReply := now.Add(3 * time.Hour)
	msg := &model.Message{
		ID:                   "01J0000000000000000000MSG1",
		ParentID:             "01J0000000000000000000CH01",
		ParentType:           "channel",
		AuthorID:             "01J0000000000000000000US01",
		Body:                 "**Hello** @[u-2|Bob] check #BugFix at https://example.org :smile:",
		CreatedAt:            now,
		EditedAt:             &editAt,
		Pinned:               true,
		PinnedAt:             &pinAt,
		PinnedBy:             "01J0000000000000000000US01",
		ReplyCount:           3,
		LastReplyAt:          &lastReply,
		RecentReplyAuthorIDs: []string{"01J0000000000000000000US02"},
		Reactions:            map[string][]string{":+1:": {"01J0000000000000000000US02"}},
		AttachmentIDs:        []string{"01J0000000000000000000AT01"},
		Rendered:             r.RenderToHast("**Hello** @[u-2|Bob] check #BugFix at https://example.org :smile:"),
	}
	assertGolden(t, "message_fully_populated.json", msg)
}

func TestWireGolden_Message_Deleted(t *testing.T) {
	// Soft-deleted messages must round-trip cleanly — Rendered is
	// nil (the renderer skips empty bodies), Body is empty, but the
	// row stays so thread replies referencing it can still resolve.
	msg := &model.Message{
		ID:        "01J0000000000000000000MSG2",
		ParentID:  "01J0000000000000000000CH01",
		AuthorID:  "01J0000000000000000000US01",
		Body:      "",
		Deleted:   true,
		CreatedAt: time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC),
	}
	assertGolden(t, "message_deleted.json", msg)
}

func TestWireGolden_Message_Minimal(t *testing.T) {
	r := NewMarkdownRenderer()
	body := "plain text"
	msg := &model.Message{
		ID:        "01J0000000000000000000MSG3",
		ParentID:  "01J0000000000000000000CH01",
		AuthorID:  "01J0000000000000000000US01",
		Body:      body,
		CreatedAt: time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC),
		Rendered:  r.RenderToHast(body),
	}
	assertGolden(t, "message_minimal.json", msg)
}

func TestWireGolden_HastTree_AllCustomTags(t *testing.T) {
	r := NewMarkdownRenderer()
	// Body exercises every ex-* sentinel + the main standard tags.
	body := "**bold** *italic* ~~strike~~ `code`\n\n" +
		"# heading\n\n" +
		"> quote\n\n" +
		"- one\n- two\n\n" +
		"see @[u-1|Alice] and ~[ch-1|general] @all #BugFix :smile: at https://example.org\n\n" +
		"![GIPHY](giphy:abc =200x150)\n\n" +
		"![cat](https://example.com/cat.gif =320x240)\n\n" +
		"```js\nconst x = 1;\n```\n"
	tree := r.RenderToHast(body)
	assertGolden(t, "hast_all_custom_tags.json", tree)
}

func assertGolden(t *testing.T, name string, value interface{}) {
	t.Helper()
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	raw = append(raw, '\n')

	path := filepath.Join(goldenDir, name)
	if os.Getenv("UPDATE_GOLDEN") == "1" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(path, raw, 0o644); err != nil {
			t.Fatalf("write golden: %v", err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden %s: %v (run UPDATE_GOLDEN=1 to refresh)", path, err)
	}
	if string(want) != string(raw) {
		t.Errorf("golden mismatch for %s\nwant:\n%s\ngot:\n%s", path, want, raw)
	}
}
