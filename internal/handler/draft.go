package handler

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// DraftClearer clears the composer draft for a scope when its message is sent —
// folding the draft cleanup into the message-create call so the client makes no
// separate request. Implemented by *service.DraftService.
type DraftClearer interface {
	DeleteForScope(ctx context.Context, userID, parentID, parentType, parentMessageID string) error
}

// clearSentDraftRetryDelays paces the send-fold's retries. "Sent ⇒ draft
// cleared" is an invariant, not a nicety: a draft that survives its send
// resurrects in every composer that scope opens next. Package vars (with the
// overall deadline below) so tests can compress the schedule; the worker
// snapshots them at start.
var clearSentDraftRetryDelays = []time.Duration{time.Second, 5 * time.Second}

// clearSentDraftTimeout bounds the whole clear-including-retries attempt.
var clearSentDraftTimeout = 30 * time.Second

// clearSentDraft removes the scope's draft after a successful send,
// unconditionally — sending is the authoritative user event for the scope.
// OFF the hot path: like the notify/index side effects of a send, it runs in
// a detached goroutine so the response doesn't wait on the draft store +
// pub/sub. Transient failures are retried within the deadline; exhausting
// them is logged at ERROR (the invariant was broken, not merely a hiccup).
func clearSentDraft(ctx context.Context, clearer DraftClearer, userID, parentID, parentType, parentMessageID string) {
	if clearer == nil {
		return
	}
	// Detached so the response doesn't wait, but bounded by a finite deadline:
	// the AWS SDK has no default per-call timeout, so a hung draft store/pub-sub
	// must not pin this goroutine indefinitely.
	bg := context.WithoutCancel(ctx)
	safe.Go(func() {
		delays := clearSentDraftRetryDelays
		bg, cancel := context.WithTimeout(bg, clearSentDraftTimeout)
		defer cancel()
		var err error
		for attempt := 0; ; attempt++ {
			if err = clearer.DeleteForScope(bg, userID, parentID, parentType, parentMessageID); err == nil {
				return
			}
			if attempt >= len(delays) {
				break
			}
			slog.Warn("clear sent draft failed, retrying", "userID", userID, "parentID", parentID, "parentType", parentType, "attempt", attempt+1, "error", err)
			select {
			case <-bg.Done():
				slog.Error("clear sent draft abandoned: deadline", "userID", userID, "parentID", parentID, "parentType", parentType, "error", err)
				return
			case <-time.After(delays[attempt]):
			}
		}
		slog.Error("clear sent draft failed after retries", "userID", userID, "parentID", parentID, "parentType", parentType, "error", err)
	})
}

// DraftHandler exposes server-side message draft endpoints.
type DraftHandler struct {
	draftSvc *service.DraftService
}

func NewDraftHandler(draftSvc *service.DraftService) *DraftHandler {
	return &DraftHandler{draftSvc: draftSvc}
}

func (h *DraftHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	drafts, err := h.draftSvc.List(r.Context(), userID)
	if err != nil {
		writeInternalError(w, r, "list_error", err)
		return
	}
	if drafts == nil {
		drafts = []*model.MessageDraft{}
	}
	writeJSON(w, http.StatusOK, drafts)
}

func (h *DraftHandler) Upsert(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	var body struct {
		ParentID        string   `json:"parentID"`
		ParentType      string   `json:"parentType"`
		ParentMessageID string   `json:"parentMessageID"`
		Body            string   `json:"body"`
		AttachmentIDs   []string `json:"attachmentIDs"`
		// Notify controls whether saving broadcasts the draft.updated event
		// (which surfaces the sidebar "draft available" indicator on this
		// and other devices). Omitted/true → broadcast, preserving legacy
		// behavior. The composer sends false for keystroke saves so the
		// indicator only appears once the field loses focus, then a final
		// save with notify=true (or omitted) surfaces it.
		Notify *bool `json:"notify"`
		// BasisGen is the generation the client is acting on ("" = it
		// believes the scope has no draft). REQUIRED: a pointer so a missing
		// field — a stale pre-gen client — is distinguishable from an
		// explicit empty basis and rejected outright, never guessed at.
		BasisGen *string `json:"basisGen"`
		// Ts is the retired client-clock field. Parsed only so pre-gen
		// clients' requests still decode (readJSON rejects unknown fields);
		// its value is ignored — ordering is server-owned.
		Ts int64 `json:"ts"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if body.BasisGen == nil {
		writeError(w, http.StatusBadRequest, "missing_basis", "basisGen is required; reload to update the app")
		return
	}
	silent := body.Notify != nil && !*body.Notify
	draft, err := h.draftSvc.Upsert(r.Context(), userID, body.ParentID, body.ParentType, body.ParentMessageID, body.Body, body.AttachmentIDs, *body.BasisGen, service.WithSilent(silent))
	if err != nil {
		writeDraftError(w, err)
		return
	}
	if draft == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, draft)
}

func (h *DraftHandler) Delete(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	// Explicit delete from the Drafts page. Still CAS-gated: the delete only
	// applies to the generation the user was looking at (?gen=), so a stale
	// page can't remove a draft that changed since it rendered — the 409
	// hands back the truth to re-render from.
	gen := r.URL.Query().Get("gen")
	if gen == "" {
		writeError(w, http.StatusBadRequest, "missing_basis", "gen is required; reload to update the app")
		return
	}
	if err := h.draftSvc.Delete(r.Context(), userID, pathParam(r, "id"), gen); err != nil {
		writeDraftError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeDraftError(w http.ResponseWriter, err error) {
	var conflict *service.DraftConflictError
	if errors.As(err, &conflict) {
		// The client acted on stale state. Nothing was written; hand back the
		// stored draft (null = the scope has no draft) so it can reconcile.
		writeJSON(w, http.StatusConflict, JSON{
			"error": JSON{
				"code":    "draft_conflict",
				"message": "draft changed since it was read",
			},
			"current": conflict.Current,
		})
		return
	}
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "draft target not found")
		return
	}
	msg := err.Error()
	if msg == "draft: not a channel member" || msg == "draft: not a conversation participant" {
		writeError(w, http.StatusForbidden, "forbidden", msg)
		return
	}
	writeServiceError(w, err, http.StatusInternalServerError, "draft_error")
}
