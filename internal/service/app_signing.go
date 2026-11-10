package service

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"strconv"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// rotationOverlap is how long a replaced bot token or signing secret keeps
// working, so an app can switch over without downtime. "Revoke now" skips it.
const rotationOverlap = 24 * time.Hour

const (
	botTokenPrefix      = "exb_"
	signingSecretPrefix = "exs_"
)

// AppSigner signs what ex sends to apps. An app's signing secret is derived
// from the server's key, the webhook and a version — so it is never stored,
// and reading the database alone yields none. Rotating bumps the version.
type AppSigner struct {
	key []byte
}

// NewAppSigner returns a signer over the server key.
func NewAppSigner(key []byte) *AppSigner { return &AppSigner{key: key} }

// Secret is a webhook's signing secret of the given version.
func (s *AppSigner) Secret(webhookID string, version int) string {
	mac := hmac.New(sha256.New, s.key)
	mac.Write([]byte("ex/app-signing-secret:" + webhookID + ":" + strconv.Itoa(version)))
	return signingSecretPrefix + hex.EncodeToString(mac.Sum(nil))
}

// SignatureHeader is the X-Ex-Signature value for a request body sent at
// timestamp: "v0=<hex HMAC-SHA256 of v0:<ts>:<body>>" with the current
// secret, followed — while a rotation's overlap lasts — by one with the
// previous secret, so an app still holding the old one verifies too.
func (s *AppSigner) SignatureHeader(wh *model.IncomingWebhook, timestamp int64, body []byte, now time.Time) string {
	sigs := []string{signRequest(s.Secret(wh.ID, wh.SecretVersion), timestamp, body)}
	if wh.SecretVersion > 1 && wh.PrevSecretUntil != nil && now.Before(*wh.PrevSecretUntil) {
		sigs = append(sigs, signRequest(s.Secret(wh.ID, wh.SecretVersion-1), timestamp, body))
	}
	return strings.Join(sigs, ",")
}

// signRequest is one signature, the way an app checks it: HMAC-SHA256 keyed
// with the signing secret over "v0:<timestamp>:<raw body>".
func signRequest(secret string, timestamp int64, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("v0:" + strconv.FormatInt(timestamp, 10) + ":"))
	mac.Write(body)
	return "v0=" + hex.EncodeToString(mac.Sum(nil))
}

// newBotToken mints a bot token and the hash ex keeps of it. crypto/rand
// never fails (it aborts the process instead).
func newBotToken() (token, hash string) {
	raw := make([]byte, 32)
	_, _ = rand.Read(raw)
	token = botTokenPrefix + base64.RawURLEncoding.EncodeToString(raw)
	return token, hashBotToken(token)
}

// botTokenMatches reports whether token is wh's bot token — the current
// one, or the previous during its overlap. Compared in constant time.
func botTokenMatches(wh *model.IncomingWebhook, token string, now time.Time) bool {
	if token == "" || wh.BotTokenHash == "" {
		return false
	}
	got := []byte(hashBotToken(token))
	if subtle.ConstantTimeCompare(got, []byte(wh.BotTokenHash)) == 1 {
		return true
	}
	return wh.PrevBotTokenHash != "" && wh.PrevBotTokenUntil != nil && now.Before(*wh.PrevBotTokenUntil) &&
		subtle.ConstantTimeCompare(got, []byte(wh.PrevBotTokenHash)) == 1
}
