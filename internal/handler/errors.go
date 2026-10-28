package handler

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/DigitalTolk/ex/internal/agents"
	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/storage"
)

// errorMapping is one row of the error → HTTP table: the error it matches
// (errors.Is), the status and stable code it answers with, and its message —
// "" means the error's own text, which is a user-readable rejection for every
// row that uses it.
type errorMapping struct {
	err     error
	status  int
	code    string
	message string
}

// errorMappings is THE mapping from a service error to its HTTP answer,
// shared by every handler through writeServiceError. Rows are tried in
// order, so a specific sentinel comes before the kind it wraps (an archived
// channel before a plain conflict, the invite refusal before forbidden).
//
// Surfaces used to keep their own ladders, and they disagreed: the same
// sentinel answered 409 in one API and 429 in another, a store outage came
// back as a 403 carrying AWS text, a missing thread root as 403 instead of
// 404. Codes are stable strings clients switch on; error_contract_test.go
// locks the ones the SPA depends on.
var errorMappings = []errorMapping{
	// ---- chat
	{service.ErrChannelArchived, http.StatusConflict, "channel_archived", "this channel is archived and read-only"},
	{service.ErrMemberDeactivated, http.StatusConflict, "member_deactivated", "that account is deactivated"},
	{service.ErrThreadDeleted, http.StatusConflict, "thread_deleted", "this thread has been deleted"},
	{service.ErrInvalidThreadRoot, http.StatusBadRequest, "invalid_root", "root_id must reference a top-level message posted by this webhook in the target channel"},
	{service.ErrWebhookDMRejected, http.StatusBadRequest, "unsupported_channel", "webhook cannot post to that direct-message target"},
	{service.ErrWebhookUnavailable, http.StatusServiceUnavailable, "unavailable", "webhook delivery temporarily unavailable, retry shortly"},
	{service.ErrReservedEmoji, http.StatusBadRequest, "reserved_emoji", "that emoji is reserved for run states"},
	{service.ErrScheduledBusy, http.StatusConflict, "being_sent", "this message is being sent right now"},
	{service.ErrSidebarConflict, http.StatusConflict, "sidebar_conflict", ""},
	{service.ErrSidebarInvalid, http.StatusBadRequest, "invalid_move", ""},
	{service.ErrCategoryNameTaken, http.StatusConflict, "duplicate_category", ""},
	{service.ErrReminderTimeInvalid, http.StatusBadRequest, "invalid_time", ""},
	{service.ErrUnknownCommand, http.StatusNotFound, "unknown_command", "unknown command"},
	{service.ErrAttachmentUploaded, http.StatusConflict, "already_uploaded", ""},
	{storage.ErrRangeNotSatisfiable, http.StatusRequestedRangeNotSatisfiable, "invalid_range", "range not satisfiable"},

	// ---- agent runs, connectors, uploads
	{agents.ErrNoRunAccess, http.StatusForbidden, "forbidden", "no access to this run"},
	// 409, not 429: the channel's shared context is FULL, which retrying will
	// not fix — nothing here is rate-limited.
	{agents.ErrContextFull, http.StatusConflict, "context_full", "shared context is full for this channel"},
	{agents.ErrRunClosed, http.StatusConflict, "run_closed", "run reached a terminal state"},
	{agents.ErrWrongRunner, http.StatusConflict, "wrong_runner", "run is leased to another runner"},
	{agents.ErrApprovalSettled, http.StatusConflict, "settled", "approval already settled"},
	{agents.ErrApprovalUnavailable, http.StatusForbidden, "approval_unavailable", ""},
	{agents.ErrNotInvoker, http.StatusForbidden, "forbidden", "only the invoker decides this"},
	{agents.ErrAgentOffline, http.StatusConflict, "not_ready", "the agent can't start right now — try again shortly"},
	{agents.ErrAgentBusy, http.StatusConflict, "not_ready", "the agent can't start right now — try again shortly"},
	{agents.ErrArtifactCap, http.StatusTooManyRequests, "artifact_cap", "per-run artifact cap reached"},
	{agents.ErrUploadCap, http.StatusTooManyRequests, "upload_cap", "per-run upload cap reached"},
	{service.ErrUnsupportedUploadType, http.StatusUnsupportedMediaType, "unsupported_type", ""},
	{service.ErrUploadTooLarge, http.StatusRequestEntityTooLarge, "too_large", ""},
	{agents.ErrNoConnectorProvider, http.StatusServiceUnavailable, "no_provider", "no connector provider configured"},
	{agents.ErrConnectorInvalid, http.StatusBadRequest, "bad_request", ""},
	{agents.ErrTokenRejected, http.StatusUnauthorized, "token_rejected", "the service rejected that credential"},
	// The external service rejected the CALLER's credentials.
	{agents.ErrLoginFailed, http.StatusUnauthorized, "login_failed", ""},
	// We could not reach it at all — nothing is wrong with the caller. 424
	// (Failed Dependency), NOT 502: Cloudflare replaces origin 502/504 bodies
	// with its own error page, so the explanation never reached the browser.
	// 424 passes through with the body intact.
	{agents.ErrServiceUnreachable, http.StatusFailedDependency, "unreachable", ""},
	{agents.ErrRunnerGrantInvalid, http.StatusBadRequest, "invalid_grant", ""},
	{agents.ErrRunnerTokenRevoked, http.StatusUnauthorized, "runner_disconnected", ""},
	// The runner asks its user to fix the computer's clock and retries;
	// nothing was revoked.
	{agents.ErrRunnerClockSkew, http.StatusUnauthorized, "runner_clock_skew", ""},
	{agents.ErrRunnerUpgradeRequired, http.StatusUnauthorized, "runner_upgrade_required", ""},
	{agents.ErrInvalidDeviceKey, http.StatusBadRequest, "invalid_device_key", ""},

	// ---- coding tasks (the MCP tool callers key off these codes: 409s are
	// "stop / different step", 400s "fix your input", 403s "not yours")
	{agents.ErrTaskActive, http.StatusConflict, "task_active", ""},
	{agents.ErrProjectUnknown, http.StatusConflict, "project_unknown", ""},
	{agents.ErrTaskTransition, http.StatusConflict, "bad_transition", ""},
	{agents.ErrStaleTask, http.StatusConflict, "bad_transition", "the task changed meanwhile — read it again"},
	{agents.ErrTaskNotReady, http.StatusConflict, "not_ready", ""},
	{agents.ErrNotRequester, http.StatusForbidden, "forbidden", "only the requester can do that"},
	{agents.ErrTaskAgent, http.StatusServiceUnavailable, "no_dev_agent", "the dev coding agent is not available in this workspace"},
	{agents.ErrNotTaskRun, http.StatusBadRequest, "not_task_run", "this run is not bound to a coding task"},

	// ---- sign-in and accounts (the callers are often unauthenticated: fixed
	// messages only)
	{service.ErrInvalidCredentials, http.StatusUnauthorized, "invalid_credentials", "invalid email or password"},
	{service.ErrSessionInvalid, http.StatusUnauthorized, "session_invalid", "session expired, sign in again"},
	// The identity policy's refusals: the caller proved who they are and is
	// refused anyway — 403 on every sign-in path (password login, refresh, SSO
	// callback); the client signs out on it like on a 401.
	{service.ErrAccountDeactivated, http.StatusForbidden, "sign_in_refused", "this account is deactivated"},
	{service.ErrIdentityMismatch, http.StatusForbidden, "sign_in_refused", "this sign-in does not match the account's identity"},
	{service.ErrEmailUnverified, http.StatusForbidden, "sign_in_refused", "the identity provider has not verified this email address"},
	{service.ErrEmailDomainNotAllowed, http.StatusForbidden, "sign_in_refused", "this email domain may not sign in"},
	{service.ErrDesktopAuthInvalid, http.StatusUnauthorized, "desktop_auth_error", "this sign-in link is invalid or has expired"},
	{service.ErrInviteForbidden, http.StatusForbidden, "forbidden", "only admins can invite"},
	{service.ErrInviteInvalid, http.StatusBadRequest, "invite_error", "this invite is invalid or has expired"},
	{service.ErrAccountExists, http.StatusBadRequest, "invite_error", "an account with this email already exists"},
	{service.ErrInvalidDisplayName, http.StatusBadRequest, "invite_error", strings.TrimPrefix(service.ErrInvalidDisplayName.Error(), "auth: ")},
	{service.ErrInvalidPassword, http.StatusBadRequest, "invalid_password", strings.TrimPrefix(service.ErrInvalidPassword.Error(), "auth: ")},
	{service.ErrPasswordResetInvalid, http.StatusBadRequest, "invalid_token", ""},
	{service.ErrPasswordResetUnsupported, http.StatusConflict, "sso_account", ""},
	{service.ErrPasswordResetUnavailable, http.StatusServiceUnavailable, "reset_unavailable", ""},

	// ---- the shared kinds, last: anything typed above wins over its kind
	{apperr.ErrNotFound, http.StatusNotFound, "not_found", "not found"},
	{apperr.ErrAlreadyExists, http.StatusConflict, "already_exists", ""},
	{apperr.ErrConflict, http.StatusConflict, "conflict", ""},
	{apperr.ErrValidation, http.StatusBadRequest, "bad_request", ""},
	{apperr.ErrForbidden, http.StatusForbidden, "forbidden", "no access"},
}

// toolError frames a service error for an agent tool caller: what was refused
// and, when there is one, the usual next move. The status and the reason still
// come from the table; the frame only adds context around the mapped text, so
// an unmapped (internal) error stays a generic 500 and never leaks through it.
type toolError struct {
	err  error
	what string
	hint string
}

func (e *toolError) Error() string { return e.what + ": " + e.err.Error() }

// Unwrap exposes the service error to the table.
func (e *toolError) Unwrap() error { return e.err }

// toolRejection frames err for writeServiceError; pass hint "" when there is
// no usual cause to name.
func toolRejection(what string, err error, hint string) error {
	return &toolError{err: err, what: what, hint: hint}
}

// lookupError finds err's row in the table.
func lookupError(err error) (errorMapping, bool) {
	for _, m := range errorMappings {
		if errors.Is(err, m.err) {
			return m, true
		}
	}
	return errorMapping{}, false
}

// text is the message a row answers with: a Rejection of the row's kind
// speaks for itself, then the row's fixed text, then the error's own.
func (m errorMapping) text(err error) string {
	if msg, ok := apperr.Message(err, m.err); ok {
		return msg
	}
	if m.message != "" {
		return m.message
	}
	return err.Error()
}

// writeServiceError answers a failed service call — every handler routes its
// service errors here, so one error means one status everywhere.
//
// Errors that carry a payload of their own come first (a draft conflict hands
// back the stored draft, a two-factor challenge its access code, a command
// denial its user-facing reason). Then the table. Anything unmapped is the
// server's fault: a generic 500 for the client — internal error text (store,
// SDK, network) never leaves the server — with the real error logged against
// the request id.
func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	var conflict *service.DraftConflictError
	if errors.As(err, &conflict) {
		// The client acted on stale state. Nothing was written; hand back the
		// stored draft (null = the scope has no draft) so it can reconcile.
		writeJSON(w, http.StatusConflict, JSON{
			"error":   JSON{"code": "draft_conflict", "message": "draft changed since it was read"},
			"current": conflict.Current,
		})
		return
	}
	if errors.Is(err, agents.ErrTwoFactorRequired) {
		writeError2FA(w, agents.TwoFactorAccessCode(err))
		return
	}
	var denial *service.CommandUserError
	if errors.As(err, &denial) {
		// A user-facing denial: the composer shows this message verbatim.
		writeError(w, http.StatusForbidden, "command_denied", denial.Message)
		return
	}
	m, ok := lookupError(err)
	if !ok {
		writeInternalError(w, r, "internal_error", err)
		return
	}
	if m.status >= http.StatusInternalServerError {
		// A mapped 5xx is a dependency that is down or unconfigured: worth a
		// line in the log even though the client gets a fixed answer.
		slog.Warn("request failed",
			"code", m.code,
			"requestID", middleware.RequestIDFromContext(r.Context()),
			"method", r.Method,
			"path", middleware.RedactPath(r.URL.Path),
			"error", err)
	}
	var frame *toolError
	if errors.As(err, &frame) {
		msg := frame.what + ": " + m.text(frame.err)
		if frame.hint != "" {
			msg += " — " + frame.hint
		}
		writeError(w, m.status, m.code, msg)
		return
	}
	writeError(w, m.status, m.code, m.text(err))
}
