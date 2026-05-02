package service

import "errors"

// ErrForbidden marks a request for an existing resource that the caller is not
// allowed to access. Handlers use it to distinguish 403 from true 404.
var ErrForbidden = errors.New("service: forbidden")
