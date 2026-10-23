package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/agents"
	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// The error contract clients rely on, locked in a golden file so that the one
// mapping (writeServiceError) cannot drift without the diff saying so. The SPA
// switches on statuses (404 vs 403 vs 5xx on channel/conversation/run reads,
// 404|409 on approvals, 404 on reminder cancel, 409 on attachment delete and
// on channel-name clashes, 4xx vs 5xx on token refresh), on three codes
// (draft_conflict, sidebar_conflict, two_factor_required) and on message text
// in two places (a convert clash must name "name"; a command denial is shown
// verbatim). Every row of the table is snapshotted too, so the desktop runner's
// and the MCP tools' codes are locked as well.
//
// Regenerate after an INTENDED change with:
//
//	go test ./internal/handler -run TestErrorContractGolden -update
var updateGolden = flag.Bool("update", false, "rewrite the error-contract golden file")

const errorContractGolden = "testdata/error_contract.golden.json"

type contractCase struct {
	name string
	err  error
}

// contractCases are the errors the SPA's behavior hangs on, built the way the
// services build them.
func contractCases() []contractCase {
	draft := &model.MessageDraft{ID: "d-1", Gen: "g-2", Body: "stored"}
	return []contractCase{
		{"draft save/delete on stale state", &service.DraftConflictError{Current: draft}},
		{"draft conflict on an empty scope", &service.DraftConflictError{}},
		{"sidebar move on a stale layout", fmt.Errorf("sidebar: move: %w", service.ErrSidebarConflict)},
		{"connector install needs a 2FA code", fmt.Errorf("%w:AC-42", agents.ErrTwoFactorRequired)},
		{"command denial shown verbatim", &service.CommandUserError{Message: "guests can't start Teams meetings"}},
		{"channel/conversation read: missing", fmt.Errorf("message: get conversation: %w", apperr.ErrNotFound)},
		{"channel/conversation read: no access", fmt.Errorf("message: not a conversation participant: %w", service.ErrForbidden)},
		{"channel/conversation read: store outage", errors.New("dynamo: ProvisionedThroughputExceededException: rate exceeded")},
		{"run read: not the invoker", agents.ErrNoRunAccess},
		{"approval decide: already settled", agents.ErrApprovalSettled},
		{"approval decide: gone", apperr.ErrNotFound},
		{"reminder cancel: already fired", fmt.Errorf("reminder: cancel: %w", apperr.ErrNotFound)},
		{"attachment delete: still referenced", apperr.Conflict("attachment: still referenced by sent messages")},
		{"channel create: name taken", fmt.Errorf("channel: a channel with this name already exists: %w", service.ErrAlreadyExists)},
		{"convert: already a channel", fmt.Errorf("channel: this conversation is a channel already: %w", service.ErrAlreadyExists)},
		{"refresh: dead session", service.ErrSessionInvalid},
		{"refresh: deactivated account", service.ErrAccountDeactivated},
		{"refresh: store outage", errors.New("redis: i/o timeout")},
		{"category create: name required", apperr.Invalid("category: name is required")},
		{"category create: duplicate", service.ErrCategoryNameTaken},
		{"archived channel write", fmt.Errorf("message: send: %w", service.ErrChannelArchived)},
		{"reply into a deleted thread", service.ErrThreadDeleted},
		{"message too long", service.ErrMessageTooLong},
		{"channel name rule", service.ErrChannelNameInvalid},
		{"forbidden with a reason", apperr.Forbidden("channel: cannot archive the general channel")},
		{"scheduled message being sent", service.ErrScheduledBusy},
		{"reminder time in the past", service.ErrReminderTimeInvalid},
		{"agent tool rejection keeps its hint", toolRejection("pin rejected", apperr.ErrNotFound, "the message must be in this run's own channel or DM")},
		{"agent tool rejection hides internals", toolRejection("post rejected", errors.New("dynamo: table gone"), "is the invoker a member?")},
	}
}

// contractEntry is one golden line: what the client receives.
type contractEntry struct {
	Case   string          `json:"case"`
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body"`
}

func contractAnswer(t *testing.T, name string, err error) contractEntry {
	t.Helper()
	rec := httptest.NewRecorder()
	writeServiceError(rec, httptest.NewRequest(http.MethodGet, "/api/v1/x", nil), err)
	var compact bytes.Buffer
	if err := json.Compact(&compact, rec.Body.Bytes()); err != nil {
		t.Fatalf("%s: body is not JSON: %v (%s)", name, err, rec.Body.String())
	}
	return contractEntry{Case: name, Status: rec.Code, Body: json.RawMessage(compact.String())}
}

func TestErrorContractGolden(t *testing.T) {
	var got []contractEntry
	for _, c := range contractCases() {
		got = append(got, contractAnswer(t, c.name, c.err))
	}
	// Every row of the table, keyed by its sentinel's text.
	for _, m := range errorMappings {
		got = append(got, contractAnswer(t, "row: "+m.err.Error(), m.err))
	}
	out, err := json.MarshalIndent(got, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	out = append(out, '\n')
	if *updateGolden {
		if err := os.MkdirAll(filepath.Dir(errorContractGolden), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(errorContractGolden, out, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(errorContractGolden)
	if err != nil {
		t.Fatalf("read golden (run with -update to create it): %v", err)
	}
	if string(want) != string(out) {
		t.Fatalf("the error contract changed; if that is intended, regenerate %s with -update and review the diff.\n--- got:\n%s", errorContractGolden, out)
	}
}

// The behaviors the SPA codes against, asserted directly on top of the
// snapshot so a regenerated golden can't quietly break them.
func TestErrorContractSPAExpectations(t *testing.T) {
	answer := func(err error) (int, map[string]any) {
		rec := httptest.NewRecorder()
		writeServiceError(rec, httptest.NewRequest(http.MethodGet, "/api/v1/x", nil), err)
		var body map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return rec.Code, body
	}
	code := func(body map[string]any) string { return body["error"].(map[string]any)["code"].(string) }
	message := func(body map[string]any) string { return body["error"].(map[string]any)["message"].(string) }

	// useDrafts: 409 + draft_conflict + current.
	status, body := answer(&service.DraftConflictError{Current: &model.MessageDraft{ID: "d-1", Gen: "g"}})
	if status != http.StatusConflict || code(body) != "draft_conflict" || body["current"].(map[string]any)["gen"] != "g" {
		t.Errorf("draft conflict = %d %v", status, body)
	}
	// useSidebar: 409 + sidebar_conflict.
	if status, body := answer(service.ErrSidebarConflict); status != http.StatusConflict || code(body) != "sidebar_conflict" {
		t.Errorf("sidebar conflict = %d %v", status, body)
	}
	// useConnectors: 409 + two_factor_required + accessCode.
	if status, body := answer(fmt.Errorf("%w:AC-1", agents.ErrTwoFactorRequired)); status != http.StatusConflict ||
		code(body) != "two_factor_required" || body["accessCode"] != "AC-1" {
		t.Errorf("two-factor = %d %v", status, body)
	}
	// ChannelView / ConversationView / RunActivityDrawer: 404 vs 403 vs 5xx.
	for err, want := range map[error]int{
		apperr.ErrNotFound:            http.StatusNotFound,
		service.ErrForbidden:          http.StatusForbidden,
		agents.ErrNoRunAccess:         http.StatusForbidden,
		errors.New("store outage"):    http.StatusInternalServerError,
		agents.ErrApprovalSettled:     http.StatusConflict, // approvals: 404|409 = settled
		service.ErrSessionInvalid:     http.StatusUnauthorized,
		service.ErrAccountDeactivated: http.StatusForbidden, // refresh: any 4xx signs out
	} {
		if status, _ := answer(err); status != want {
			t.Errorf("%v = %d, want %d", err, status, want)
		}
	}
	// ConvertToChannelDialog: a name clash is 409 and says "name"; "already a
	// channel" is 409 and must not.
	nameRe := regexp.MustCompile(`name`)
	if status, body := answer(fmt.Errorf("channel: a channel with this name already exists: %w", service.ErrAlreadyExists)); status != http.StatusConflict || !nameRe.MatchString(message(body)) {
		t.Errorf("name clash = %d %v", status, body)
	}
	if status, body := answer(fmt.Errorf("channel: this conversation is a channel already: %w", service.ErrAlreadyExists)); status != http.StatusConflict || nameRe.MatchString(message(body)) {
		t.Errorf("already a channel = %d %v", status, body)
	}
	// MessageInput: a command denial's message is shown verbatim.
	if _, body := answer(&service.CommandUserError{Message: "guests can't start Teams meetings"}); message(body) != "guests can't start Teams meetings" {
		t.Errorf("command denial = %v", body)
	}
	// Readable validation messages stay readable; internal text never leaks.
	if _, body := answer(apperr.Invalid("category: name is required")); message(body) != "category: name is required" {
		t.Errorf("validation = %v", body)
	}
	if _, body := answer(errors.New("dynamo: secret table arn:aws:dynamodb:eu-north-1:123")); strings.Contains(message(body), "dynamo") {
		t.Errorf("internal text leaked: %v", body)
	}
}
