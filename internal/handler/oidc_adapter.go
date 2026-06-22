package handler

import (
	"context"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/service"
)

// authProvider is the slice of *auth.OIDCProvider the adapter needs. As an
// interface it lets tests inject a fake whose Exchange succeeds, covering the
// OIDCUserInfo-mapping branch a real provider can't reach without a live IdP
// (it requires a verified, signed id_token round-trip).
type authProvider interface {
	AuthURL(state, nonce string) string
	Exchange(ctx context.Context, code, nonce string) (*auth.OIDCUserInfo, error)
}

// oidcAdapter wraps an auth.OIDCProvider to implement the service.OIDCProvider
// interface, bridging the OIDCUserInfo types.
type oidcAdapter struct {
	p authProvider
}

// NewOIDCAdapter returns an adapter that satisfies service.OIDCProvider.
func NewOIDCAdapter(p *auth.OIDCProvider) *oidcAdapter {
	return &oidcAdapter{p: p}
}

func (a *oidcAdapter) AuthURL(state, nonce string) string {
	return a.p.AuthURL(state, nonce)
}

func (a *oidcAdapter) Exchange(ctx context.Context, code, nonce string) (*service.OIDCUserInfo, error) {
	info, err := a.p.Exchange(ctx, code, nonce)
	if err != nil {
		return nil, err
	}
	return &service.OIDCUserInfo{
		Email:   info.Email,
		Name:    info.Name,
		Picture: info.Picture,
	}, nil
}
