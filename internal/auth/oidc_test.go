package auth

import (
	"context"
	"testing"
	"time"
)

func TestNewOIDCProvider_InvalidIssuer(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := NewOIDCProvider(ctx, "http://127.0.0.1:1/invalid-issuer", "client-id", "client-secret", "http://localhost/callback")
	if err == nil {
		t.Fatal("expected error for invalid issuer, got nil")
	}
}

func TestNewOIDCProvider_EmptyIssuer(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, err := NewOIDCProvider(ctx, "", "client-id", "client-secret", "http://localhost/callback")
	if err == nil {
		t.Fatal("expected error for empty issuer, got nil")
	}
}

// TestOIDCUserInfoStruct ensures the struct can be created and fields accessed.
func TestOIDCUserInfoStruct(t *testing.T) {
	info := OIDCUserInfo{
		Email:   "test@example.com",
		Name:    "Test User",
		Picture: "https://example.com/avatar.png",
	}

	if info.Email != "test@example.com" {
		t.Errorf("Email = %q, want %q", info.Email, "test@example.com")
	}
	if info.Name != "Test User" {
		t.Errorf("Name = %q, want %q", info.Name, "Test User")
	}
	if info.Picture != "https://example.com/avatar.png" {
		t.Errorf("Picture = %q, want %q", info.Picture, "https://example.com/avatar.png")
	}
}
