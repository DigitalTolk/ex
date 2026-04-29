package handler

import (
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// listMessages is the shared body for /channels/{id}/messages and
// /conversations/{id}/messages. Pagination modes:
//   - ?around=<msgId>  – window centered on a message (deep link)
//   - ?after=<msgId>   – messages strictly newer than cursor
//   - ?cursor=<msgId>  – messages strictly older than cursor (default)
// Responses always carry hasMoreOlder + hasMoreNewer so the client can
// drive bidirectional infinite scroll without a second probe call.
func listMessages(
	w http.ResponseWriter,
	r *http.Request,
	parentType, parentID string,
	svc *service.MessageService,
) {
	userID := middleware.UserIDFromContext(r.Context())
	limit := queryInt(r, "limit", 50)

	if around := queryParam(r, "around", ""); around != "" {
		before := queryInt(r, "before", limit/2)
		after := queryInt(r, "after_count", limit/2)
		msgs, hasMoreOlder, hasMoreNewer, err := svc.ListAround(r.Context(), userID, parentID, parentType, around, before, after)
		if err != nil {
			writeError(w, http.StatusForbidden, "list_error", err.Error())
			return
		}
		writeMessageWindow(w, msgs, hasMoreOlder, hasMoreNewer)
		return
	}

	if after := queryParam(r, "after", ""); after != "" {
		msgs, hasMore, err := svc.ListAfter(r.Context(), userID, parentID, parentType, after, limit)
		if err != nil {
			writeError(w, http.StatusForbidden, "list_error", err.Error())
			return
		}
		writeMessageWindow(w, msgs, false, hasMore)
		return
	}

	cursor := queryParam(r, "cursor", "")
	msgs, hasMore, err := svc.List(r.Context(), userID, parentID, parentType, cursor, limit)
	if err != nil {
		writeError(w, http.StatusForbidden, "list_error", err.Error())
		return
	}
	writeMessageWindow(w, msgs, hasMore, false)
}

// writeMessageWindow encodes the bidirectional message list response.
// Both cursors are derived from the page bounds so the frontend can
// page in either direction with a single round-trip per scroll edge.
func writeMessageWindow(w http.ResponseWriter, msgs []*model.Message, hasMoreOlder, hasMoreNewer bool) {
	if msgs == nil {
		msgs = []*model.Message{}
	}
	var oldestID, newestID string
	if len(msgs) > 0 {
		// Service contract: messages newest-first.
		newestID = msgs[0].ID
		oldestID = msgs[len(msgs)-1].ID
	}
	writeJSON(w, http.StatusOK, JSON{
		"items":        msgs,
		"hasMoreOlder": hasMoreOlder,
		"hasMoreNewer": hasMoreNewer,
		"oldestID":     oldestID,
		"newestID":     newestID,
	})
}
