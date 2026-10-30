package handler

import (
	"context"
	"net/http"
	"slices"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

type UserStateHandler struct {
	stateSvc *service.UserStateService
	msgSvc   *service.MessageService
	convSvc  *service.ConversationService
	// skills validates hide/unhide targets; nil skips validation (tests).
	skills skillLookup
	// categories validates a sidebar sort's section; nil skips validation.
	categories categoryLister
}

// categoryLister is CategoryService narrowed to the one call a sidebar sort
// needs: the user's own categories.
type categoryLister interface {
	List(ctx context.Context, userID string) ([]*model.UserChannelCategory, error)
}

// SetCategoryLister wires section validation for SetSidebarSort.
func (h *UserStateHandler) SetCategoryLister(c categoryLister) { h.categories = c }

// skillLookup is AgentService narrowed to the one check hiding needs.
type skillLookup interface {
	GetVisibleSkill(ctx context.Context, userID, id string) (*model.Skill, error)
}

// SetSkillLookup wires skill validation for the hide/unhide endpoints.
func (h *UserStateHandler) SetSkillLookup(s skillLookup) { h.skills = s }

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
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, state)
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
		writeServiceError(w, r, err)
		return
	}
	if err := h.stateSvc.MarkThreadSeen(r.Context(), userID, parentID, parentType, threadRootID); err != nil {
		writeServiceError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// SetSidebarSort remembers how one sidebar section orders its rows: a
// built-in section's key, or the ID of one of the caller's own categories.
func (h *UserStateHandler) SetSidebarSort(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	section := pathParam(r, "section")
	var body struct {
		Sort model.SidebarSort `json:"sort"`
	}
	if err := readJSON(r, &body); err != nil || (body.Sort != model.SidebarSortRecent && body.Sort != model.SidebarSortAZ) {
		writeError(w, http.StatusBadRequest, "bad_request", `sort must be "recent" or "az"`)
		return
	}
	if !slices.Contains(model.SidebarBuiltInSections, section) && h.categories != nil {
		cats, err := h.categories.List(r.Context(), userID)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		if !slices.ContainsFunc(cats, func(c *model.UserChannelCategory) bool { return c.ID == section }) {
			writeError(w, http.StatusNotFound, "not_found", "no such sidebar section")
			return
		}
	}
	if err := h.stateSvc.SetSidebarSort(r.Context(), userID, section, body.Sort); err != nil {
		writeServiceError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// HideSkill / UnhideSkill toggle one skill's presence in THIS user's agent
// discovery index. Hiding is curation, not permission: an explicit /skill
// pick still attaches a hidden skill.
func (h *UserStateHandler) HideSkill(w http.ResponseWriter, r *http.Request) {
	h.setSkillHidden(w, r, true)
}

func (h *UserStateHandler) UnhideSkill(w http.ResponseWriter, r *http.Request) {
	h.setSkillHidden(w, r, false)
}

func (h *UserStateHandler) setSkillHidden(w http.ResponseWriter, r *http.Request, hidden bool) {
	userID := middleware.UserIDFromContext(r.Context())
	skillID := pathParam(r, "id")
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	if skillID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "skill ID is required")
		return
	}
	if h.skills != nil && hidden {
		if _, err := h.skills.GetVisibleSkill(r.Context(), userID, skillID); err != nil {
			writeServiceError(w, r, err)
			return
		}
	}
	var err error
	if hidden {
		err = h.stateSvc.HideSkill(r.Context(), userID, skillID)
	} else {
		err = h.stateSvc.UnhideSkill(r.Context(), userID, skillID)
	}
	if err != nil {
		writeServiceError(w, r, err)
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
		writeServiceError(w, r, err)
		return
	}
	var err error
	if hidden {
		err = h.stateSvc.HideConversation(r.Context(), userID, convID)
	} else {
		err = h.stateSvc.UnhideConversation(r.Context(), userID, convID)
	}
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
