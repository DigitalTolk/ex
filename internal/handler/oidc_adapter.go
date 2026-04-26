package handler

import (
	"context"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/service"
)

// oidcAdapter wraps an auth.OIDCProvider to implement the service.OIDCProvider
// interface, bridging the OIDCUserInfo types.
type oidcAdapter struct {
	p *auth.OIDCProvider
}

// NewOIDCAdapter returns an adapter that satisfies service.OIDCProvider.
func NewOIDCAdapter(p *auth.OIDCProvider) *oidcAdapter {
	return &oidcAdapter{p: p}
}

func (a *oidcAdapter) AuthURL(state string) string {
	return a.p.AuthURL(state)
}

func (a *oidcAdapter) Exchange(ctx context.Context, code string) (*service.OIDCUserInfo, error) {
	info, err := a.p.Exchange(ctx, code)
	if err != nil {
		return nil, err
	}
	return &service.OIDCUserInfo{
		Email:   info.Email,
		Name:    info.Name,
		Picture: info.Picture,
	}, nil
}
