package handler

import (
	"context"
	"net/http"
	"regexp"

	"github.com/DigitalTolk/ex/internal/service"
)

// clientNonceHeader carries the sender's client-generated tag for an
// optimistic send. A header rather than a body field: the body decoder
// rejects unknown fields, so during a rolling deploy a newer web app talking
// to an older server would fail every send — an unknown header is ignored.
const clientNonceHeader = "X-Client-Nonce"

var validClientNonce = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// withClientNonce returns the request context carrying a well-formed nonce
// from the request, if any.
func withClientNonce(r *http.Request) context.Context {
	nonce := r.Header.Get(clientNonceHeader)
	if !validClientNonce.MatchString(nonce) {
		return r.Context()
	}
	return service.WithClientNonce(r.Context(), nonce)
}
