package service

import (
	"errors"
	"fmt"

	"github.com/DigitalTolk/ex/internal/apperr"
)

// ErrForbidden marks a request for an existing resource that the caller is not
// allowed to access. Handlers use it to distinguish 403 from true 404.
var ErrForbidden = apperr.ErrForbidden

// ErrAlreadyExists marks a uniqueness conflict (duplicate name/slug/emoji).
// It is the store's sentinel too (both are apperr.ErrAlreadyExists): a
// storage-uniqueness conflict and a service-level one are the same kind, and
// handlers map it to 409 via errors.Is.
var ErrAlreadyExists = apperr.ErrAlreadyExists

// ErrValidation marks caller input that fails a service-level bound (size,
// required field). Handlers map it to 400.
var ErrValidation = apperr.ErrValidation

// ErrNotFound is the shared not-found kind (the store raises it).
var ErrNotFound = apperr.ErrNotFound

// ErrThreadDeleted is returned when a reply is attempted on a thread whose
// root message has been soft-deleted. A deleted thread is closed for good —
// the cascade in MessageService.Delete tombstones every existing reply and
// this guard prevents new ones. Handlers map it to 409 Conflict.
var ErrThreadDeleted = errors.New("message: thread has been deleted")

// ErrInvalidThreadRoot is returned when a webhook reply names a root it may
// not reply under: missing, itself a reply, or not posted by that webhook.
// The webhook handler maps it to 400.
var ErrInvalidThreadRoot = errors.New("message: invalid thread root")

// ErrChannelArchived is returned for a write (post, reply, edit, delete,
// reaction, pin, rename, self-join, webhook post) into an archived channel.
// An archived channel keeps its members and history but is read-only until an
// owner unarchives it; members can still add people to it. Handlers map it to
// 409 Conflict.
var ErrChannelArchived = errors.New("channel: channel is archived")

// ErrConversationConverted: the group message is a private channel now (the
// same ID). It is used as that channel; the conversation itself is no more.
var ErrConversationConverted = fmt.Errorf("message: this conversation is a channel now: %w", ErrForbidden)
