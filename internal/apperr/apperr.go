// Package apperr holds the error kinds every layer shares. The store raises
// ErrNotFound and ErrAlreadyExists, the service layer wraps them or raises
// its own rejections, and the HTTP layer maps them to statuses — all against
// these same values, so a handler can tell "not found" from "forbidden"
// without importing the store, and there is exactly one ErrAlreadyExists.
package apperr

import (
	"errors"
	"fmt"
)

var (
	// ErrNotFound: the thing asked for does not exist.
	ErrNotFound = errors.New("not found")
	// ErrAlreadyExists: a uniqueness rule refused the write (a duplicate
	// name, slug, key or ID).
	ErrAlreadyExists = errors.New("already exists")
	// ErrForbidden: the thing exists, but the caller may not do this to it.
	ErrForbidden = errors.New("forbidden")
	// ErrValidation: the caller's input breaks a rule (a bound, a required
	// field, an unknown value).
	ErrValidation = errors.New("invalid input")
	// ErrConflict: the request is fine, but the thing's current state refuses
	// it (still in use, changed meanwhile).
	ErrConflict = errors.New("conflict")
)

// Rejection is a refusal whose message is written for the person who asked:
// the HTTP layer shows Message as is, and Kind (one of the sentinels above,
// or a service sentinel) picks the status. errors.Is(r, r.Kind) holds, so a
// typed refusal is still matched like the bare sentinel.
type Rejection struct {
	Kind    error
	Message string
}

func (r *Rejection) Error() string { return r.Message }

// Unwrap exposes Kind to errors.Is / errors.As.
func (r *Rejection) Unwrap() error { return r.Kind }

// Reject returns a refusal of the given kind carrying a user-facing message.
func Reject(kind error, format string, args ...any) error {
	return &Rejection{Kind: kind, Message: fmt.Sprintf(format, args...)}
}

// Forbidden refuses an action the caller may not take, saying why.
func Forbidden(format string, args ...any) error { return Reject(ErrForbidden, format, args...) }

// Invalid refuses input that breaks a rule, saying which.
func Invalid(format string, args ...any) error { return Reject(ErrValidation, format, args...) }

// NotFound reports a missing thing in words the caller can act on.
func NotFound(format string, args ...any) error { return Reject(ErrNotFound, format, args...) }

// Conflict refuses an action the thing's current state does not allow.
func Conflict(format string, args ...any) error { return Reject(ErrConflict, format, args...) }

// Message returns the user-facing text of err's Rejection of the given kind,
// if it carries one.
func Message(err, kind error) (string, bool) {
	var r *Rejection
	if errors.As(err, &r) && errors.Is(r.Kind, kind) {
		return r.Message, true
	}
	return "", false
}
