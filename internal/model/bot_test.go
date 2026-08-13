package model

import (
	"testing"
	"time"
)

func TestIsBotUserID(t *testing.T) {
	// Callers that only hold an id (message authorship, mention handling) use this
	// instead of loading the User row, so it must not match a human's bare ULID.
	if !IsBotUserID(BotUserIDPrefix + "01HXYZ") {
		t.Error("a prefixed id must be recognized as a bot")
	}
	for _, id := range []string{"01HXYZ", "", "webhook", "cliffy", "robot_1"} {
		if IsBotUserID(id) {
			t.Errorf("IsBotUserID(%q) = true, want false", id)
		}
	}
}

func TestBotTransport(t *testing.T) {
	tests := []struct {
		transport  BotTransport
		valid      bool
		normalized BotTransport
	}{
		// The empty string is valid and means the default — an older bot row that
		// predates the field must keep working.
		{transport: "", valid: true, normalized: BotTransportEx},
		{transport: BotTransportEx, valid: true, normalized: BotTransportEx},
		{transport: BotTransportMattermost, valid: true, normalized: BotTransportMattermost},
		{transport: "slack", valid: false, normalized: "slack"},
		{transport: "MATTERMOST", valid: false, normalized: "MATTERMOST"},
	}
	for _, tc := range tests {
		if got := tc.transport.Valid(); got != tc.valid {
			t.Errorf("BotTransport(%q).Valid() = %v, want %v", tc.transport, got, tc.valid)
		}
		if got := tc.transport.Normalized(); got != tc.normalized {
			t.Errorf("BotTransport(%q).Normalized() = %q, want %q", tc.transport, got, tc.normalized)
		}
	}
}

func TestBotTokenRevoked(t *testing.T) {
	var nilToken *BotToken
	if nilToken.Revoked() {
		t.Error("a nil token must not report as revoked")
	}
	if (&BotToken{}).Revoked() {
		t.Error("a token with no RevokedAt is live")
	}
	now := time.Now()
	if !(&BotToken{RevokedAt: &now}).Revoked() {
		t.Error("a stamped token must report as revoked")
	}
}
