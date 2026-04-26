package auth

import (
	"context"
	"fmt"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// OIDCUserInfo holds user profile data returned by the identity provider.
type OIDCUserInfo struct {
	Email   string
	Name    string
	Picture string
}

// OIDCProvider wraps an OpenID Connect provider for authentication.
type OIDCProvider struct {
	provider     *oidc.Provider
	oauth2Config oauth2.Config
	verifier     *oidc.IDTokenVerifier
}

// NewOIDCProvider discovers the OIDC provider and configures OAuth2.
func NewOIDCProvider(ctx context.Context, issuer, clientID, clientSecret, redirectURL string) (*OIDCProvider, error) {
	provider, err := oidc.NewProvider(ctx, issuer)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery: %w", err)
	}

	oauth2Cfg := oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		RedirectURL:  redirectURL,
		Endpoint:     provider.Endpoint(),
		Scopes:       []string{oidc.ScopeOpenID, "profile", "email"},
	}

	verifier := provider.Verifier(&oidc.Config{ClientID: clientID})

	return &OIDCProvider{
		provider:     provider,
		oauth2Config: oauth2Cfg,
		verifier:     verifier,
	}, nil
}

// AuthURL returns the URL to redirect the user to for authentication.
func (p *OIDCProvider) AuthURL(state string) string {
	return p.oauth2Config.AuthCodeURL(state)
}

// Exchange trades an authorization code for tokens, verifies the ID token,
// and extracts user profile information.
func (p *OIDCProvider) Exchange(ctx context.Context, code string) (*OIDCUserInfo, error) {
	oauth2Token, err := p.oauth2Config.Exchange(ctx, code)
	if err != nil {
		return nil, fmt.Errorf("oauth2 exchange: %w", err)
	}

	rawIDToken, ok := oauth2Token.Extra("id_token").(string)
	if !ok {
		return nil, fmt.Errorf("no id_token in token response")
	}

	idToken, err := p.verifier.Verify(ctx, rawIDToken)
	if err != nil {
		return nil, fmt.Errorf("id_token verification: %w", err)
	}

	var claims struct {
		Email   string `json:"email"`
		Name    string `json:"name"`
		Picture string `json:"picture"`
	}
	if err := idToken.Claims(&claims); err != nil {
		return nil, fmt.Errorf("parse id_token claims: %w", err)
	}

	return &OIDCUserInfo{
		Email:   claims.Email,
		Name:    claims.Name,
		Picture: claims.Picture,
	}, nil
}
