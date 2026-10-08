package service

import "context"

type clientNonceKey struct{}

// WithClientNonce attaches the sender's client-generated nonce to a send
// request; the created message carries it back (model.Message.ClientNonce).
func WithClientNonce(ctx context.Context, nonce string) context.Context {
	if nonce == "" {
		return ctx
	}
	return context.WithValue(ctx, clientNonceKey{}, nonce)
}

func clientNonce(ctx context.Context) string {
	nonce, _ := ctx.Value(clientNonceKey{}).(string)
	return nonce
}
