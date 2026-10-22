package service

import (
	"errors"
	"fmt"
)

// ErrForbidden marks a request for an existing resource that the caller is not
// allowed to access. Handlers use it to distinguish 403 from true 404.
var ErrForbidden = errors.New("service: forbidden")

// ErrAlreadyExists marks a uniqueness conflict (duplicate name/slug/emoji).
// Wraps the store-layer sentinel where the conflict is a storage-uniqueness
// rule, and is minted directly for service-level uniqueness checks — handlers
// map it to 409 via errors.Is instead of the old error-string matching.
var ErrAlreadyExists = errors.New("service: already exists")

// ErrValidation marks caller input that fails a service-level bound (size,
// required field). Handlers map it to 400.
var ErrValidation = errors.New("service: invalid input")

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
// reaction, pin, rename, new member, webhook post) into an archived channel.
// An archived channel keeps its members and history but is read-only until an
// owner unarchives it. Handlers map it to 409 Conflict.
var ErrChannelArchived = errors.New("channel: channel is archived")

// ErrConversationConverted: the group message is a private channel now (the
// same ID). It is used as that channel; the conversation itself is no more.
var ErrConversationConverted = fmt.Errorf("message: this conversation is a channel now: %w", ErrForbidden)
