package model

import "testing"

func TestRenderAuthHeader(t *testing.T) {
	cases := []struct {
		template, token, name, value string
	}{
		{"", "tok", "Authorization", "Bearer tok"},
		{"   ", "tok", "Authorization", "Bearer tok"},
		{"X-Api-Key: {token}", "mb_1", "X-Api-Key", "mb_1"},
		{"X-Api-Key", "mb_1", "X-Api-Key", "mb_1"},
		{"X-Api-Key:", "mb_1", "X-Api-Key", "mb_1"},
		{"Authorization: Token", "t", "Authorization", "Token t"},
		{"Authorization: Basic {token} extra", "b", "Authorization", "Basic b extra"},
	}
	for _, c := range cases {
		n, v := RenderAuthHeader(c.template, c.token)
		if n != c.name || v != c.value {
			t.Errorf("RenderAuthHeader(%q, %q) = %q,%q want %q,%q", c.template, c.token, n, v, c.name, c.value)
		}
	}
	conn := &Connector{AuthHeader: "X-Metabase-Session: {token}"}
	if n, v := conn.CredentialHeader("s1"); n != "X-Metabase-Session" || v != "s1" {
		t.Fatalf("CredentialHeader = %q,%q", n, v)
	}
}

func TestValidateAuthHeader(t *testing.T) {
	for _, ok := range []string{"", "  ", "X-Api-Key: {token}", "Authorization: Bearer {token}", "X-Api-Key"} {
		if err := ValidateAuthHeader(ok); err != nil {
			t.Errorf("ValidateAuthHeader(%q) = %v, want nil", ok, err)
		}
	}
	for _, bad := range []string{"X-Api-Key: {token}\r\nEvil: 1", "Bad Name: x", ": x", "X Key"} {
		if err := ValidateAuthHeader(bad); err == nil {
			t.Errorf("ValidateAuthHeader(%q) = nil, want error", bad)
		}
	}
}
