package service

import "errors"

// ErrForbidden marks a request for an existing resource that the caller is not
// allowed to access. Handlers use it to distinguish 403 from true 404.
var ErrForbidden = errors.New("service: forbidden")

// ErrThreadDeleted is returned when a reply is attempted on a thread whose
// root message has been soft-deleted. A deleted thread is closed for good —
// the cascade in MessageService.Delete tombstones every existing reply and
// this guard prevents new ones. Handlers map it to 409 Conflict.
var ErrThreadDeleted = errors.New("message: thread has been deleted")
