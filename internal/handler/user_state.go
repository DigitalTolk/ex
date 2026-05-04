package handler

import (
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/service"
)

type UserStateHandler struct {
	stateSvc *service.UserStateService
	msgSvc   *service.MessageService
	convSvc  *service.ConversationService
}

func NewUserStateHandler(stateSvc *service.UserStateService, msgSvc *service.MessageService, convSvc *service.ConversationService) *UserStateHandler {
	return &UserStateHandler{stateSvc: stateSvc, msgSvc: msgSvc, convSvc: convSvc}
}

func (h *UserStateHandler) Get(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	state, err := h.stateSvc.List(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "state_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func (h *UserStateHandler) ClearChannelNotification(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	channelID := pathParam(r, "id")
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	if channelID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "channel ID is required")
		return
	}
	if err := h.stateSvc.ClearChannelNotifications(r.Context(), userID, channelID); err != nil {
		writeError(w, http.StatusInternalServerError, "state_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *UserStateHandler) MarkThreadSeen(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	parentID := pathParam(r, "parentID")
	threadRootID := pathParam(r, "threadRootID")
	parentType, ok := normalizeThreadParentType(pathParam(r, "parentType"))
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	if parentID == "" || threadRootID == "" || !ok {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid thread seen target")
		return
	}
	if err := h.msgSvc.CheckAccess(r.Context(), userID, parentID, parentType); err != nil {
		writeReadResourceError(w, err, "thread")
		return
	}
	if err := h.stateSvc.MarkThreadSeen(r.Context(), userID, parentID, parentType, threadRootID); err != nil {
		writeError(w, http.StatusInternalServerError, "state_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *UserStateHandler) HideConversation(w http.ResponseWriter, r *http.Request) {
	h.setConversationHidden(w, r, true)
}

func (h *UserStateHandler) UnhideConversation(w http.ResponseWriter, r *http.Request) {
	h.setConversationHidden(w, r, false)
}

func (h *UserStateHandler) setConversationHidden(w http.ResponseWriter, r *http.Request, hidden bool) {
	userID := middleware.UserIDFromContext(r.Context())
	convID := pathParam(r, "id")
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	if convID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "conversation ID is required")
		return
	}
	if _, err := h.convSvc.GetByID(r.Context(), userID, convID); err != nil {
		writeReadResourceError(w, err, "conversation")
		return
	}
	var err error
	if hidden {
		err = h.stateSvc.HideConversation(r.Context(), userID, convID)
	} else {
		err = h.stateSvc.UnhideConversation(r.Context(), userID, convID)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "state_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
