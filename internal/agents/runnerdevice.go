package agents

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// Keeping a runner token on the computer it was issued to. A runner that
// made a P-256 device key at sign-in (in the Secure Enclave where there is
// one) signs every request with it. A request on a keyed token without a
// valid proof revokes the token and tells its owner — a real runner always
// signs, so a missing or bad proof means someone has the token without the
// key. A copied credentials file is useless elsewhere.

const (
	// runnerTouchEvery bounds how often a busy install's last-used stamp is
	// rewritten: heartbeats arrive every few seconds, the Runners page needs
	// minutes.
	runnerTouchEvery = 5 * time.Minute
	// runnerProofSkew is how far a proof's timestamp may sit from the
	// server's clock before the runner is told to correct for it.
	runnerProofSkew = 10 * time.Minute
	// runnerProofVersion opens every signed proof message and its header.
	runnerProofVersion = "ex-runner-proof/v1"
	// runnersDeepLink is where the owner's alert opens: the Runners page.
	runnersDeepLink = "/runners"
)

var (
	// ErrRunnerClockSkew refuses a proof whose timestamp is too far from the
	// server's clock. Nothing is revoked: the runner tells its user to fix the
	// computer's clock and keeps retrying.
	ErrRunnerClockSkew = errors.New("runner: this computer's clock is more than 10 minutes off")
	// ErrRunnerUpgradeRequired refuses an install without a device key while
	// the workspace requires one.
	ErrRunnerUpgradeRequired = errors.New("runner: this ex-runner is too old for this workspace — update ex-runner, then run ex-runner login again")
	// ErrInvalidDeviceKey refuses a device key that is not a P-256 public key.
	ErrInvalidDeviceKey = errors.New("runner: the device key is not a P-256 public key")
)

// RunnerDeviceKey is the public half of an install's device key, as the
// runner sends it at sign-in.
type RunnerDeviceKey struct {
	// PublicKey is base64 (std) of the key's SPKI DER.
	PublicKey string `json:"publicKey"`
	// Hardware reports that the private key lives in the computer's secure
	// chip.
	Hardware bool `json:"hardware"`
}

// RunnerRequest is one runner-token request, as AuthorizeRunner sees it.
type RunnerRequest struct {
	Method string
	Path   string
	// Proof is the X-Ex-Runner-Proof header.
	Proof string
	// IP is the client address (respecting the trusted proxies).
	IP string
}

// runnerOwnerNotifier alerts a token's owner (desktop + mobile) when their
// install was disconnected for them.
type runnerOwnerNotifier interface {
	NotifyDirect(ctx context.Context, userID string, notif service.Notification)
}

// SetOwnerNotifier wires the alert sent when an install is revoked because
// a request on it failed its device proof.
func (s *RunnerTokenService) SetOwnerNotifier(n runnerOwnerNotifier) { s.notifier = n }

// SetRequireDeviceKey makes a device key mandatory: installs without one are
// refused (runner_upgrade_required) on every runner route, so they must
// update ex-runner and sign in again.
func (s *RunnerTokenService) SetRequireDeviceKey(on bool) { s.requireDeviceKey = on }

// AuthorizeRunner is the runner middleware's check behind every runner-token
// request. The install must still exist and belong to an active account
// (deactivation also revokes every install, but that sweep can fail or lag;
// the runner acts with the owner's access). A keyed install must prove it
// holds the key. The install's last-used stamp is refreshed now and then.
func (s *RunnerTokenService) AuthorizeRunner(ctx context.Context, claims *model.TokenClaims, req RunnerRequest) error {
	rec, err := s.activeRecord(ctx, claims)
	if err != nil {
		return err
	}
	if rec == nil {
		return ErrRunnerTokenRevoked
	}
	status, _, err := s.users.UserAccess(ctx, rec.UserID)
	if err != nil {
		return fmt.Errorf("runner token: owner status: %w", err)
	}
	if status == "deactivated" {
		return ErrRunnerTokenRevoked
	}
	switch {
	case rec.DeviceKey != "":
		switch verifyRunnerProof(rec.DeviceKey, rec.ID, req, s.now()) {
		case proofSkewed:
			return ErrRunnerClockSkew
		case proofBad:
			return s.revokeCompromised(ctx, rec)
		}
	case s.requireDeviceKey:
		return ErrRunnerUpgradeRequired
	}
	s.touch(ctx, rec, req.IP)
	return nil
}

// touch records when and from where the install was used — only when the
// stamp is stale or the address changed, never per request. Best effort: a
// failed write is logged and the request goes on.
func (s *RunnerTokenService) touch(ctx context.Context, rec *model.RunnerToken, ip string) {
	now := s.now()
	if ip == rec.LastIP && now.Sub(rec.LastUsedAt) <= runnerTouchEvery {
		return
	}
	if err := s.store.TouchRunnerToken(ctx, rec.ID, now, ip); err != nil {
		slog.WarnContext(ctx, "runner token: last-used update failed", "tokenID", rec.ID, "error", err)
	}
}

// revokeCompromised disconnects an install whose token was used without its
// device key, and tells its owner. The delete is conditional, so of several
// requests catching the same token at once only one alerts.
// Always answers ErrRunnerTokenRevoked unless the delete itself failed.
func (s *RunnerTokenService) revokeCompromised(ctx context.Context, rec *model.RunnerToken) error {
	err := s.store.RevokeRunnerToken(ctx, rec.ID)
	if errors.Is(err, store.ErrNotFound) {
		return ErrRunnerTokenRevoked // another request revoked it and alerted
	}
	if err != nil {
		return fmt.Errorf("runner token: revoke: %w", err)
	}
	slog.WarnContext(ctx, "runner token revoked: missing or invalid device proof",
		"tokenID", rec.ID, "userID", rec.UserID)
	s.changed(ctx, rec.UserID)
	if s.notifier != nil {
		s.notifier.NotifyDirect(ctx, rec.UserID, service.Notification{
			// No kind of its own: every non-message kind renders as a plain
			// title + body alert, and this one asks the owner to act.
			Kind:  service.NotificationKindApproval,
			Title: "Runner disconnected for your safety",
			Body: "“" + rec.Label + "” was used from somewhere other than the computer it was set up on, " +
				"so ex disconnected it. If you didn't do this, tell your admin. " +
				"To reconnect, run ex-runner login on your computer.",
			DeepLink: runnersDeepLink,
			// One alert per install: the client dedup, the desktop ack and the
			// mobile fallback all key on it.
			AlertID:   "runner-revoked:" + rec.ID,
			CreatedAt: s.now(),
		})
	}
	return ErrRunnerTokenRevoked
}

// parseDeviceKey validates a device key sent by a runner and returns it
// re-encoded; "" for none.
func parseDeviceKey(k *RunnerDeviceKey) (string, error) {
	if k == nil {
		return "", nil
	}
	der, err := base64.StdEncoding.DecodeString(k.PublicKey)
	if err != nil || p256Key(der) == nil {
		return "", ErrInvalidDeviceKey
	}
	return base64.StdEncoding.EncodeToString(der), nil
}

// p256Key parses SPKI DER as a P-256 ECDSA public key; nil if it is not one.
func p256Key(der []byte) *ecdsa.PublicKey {
	pub, _ := x509.ParsePKIXPublicKey(der) // nil on error: refused below
	if ec, ok := pub.(*ecdsa.PublicKey); ok && ec.Curve == elliptic.P256() {
		return ec
	}
	return nil
}

type proofVerdict int

const (
	proofOK proofVerdict = iota
	proofSkewed
	proofBad
)

// runnerProofMessage is the message a runner signs for one request:
// "ex-runner-proof/v1", the method, the URL path, the unix-seconds timestamp
// and the token ID (jti), newline-joined.
func runnerProofMessage(method, path, unix, tokenID string) string {
	return strings.Join([]string{runnerProofVersion, strings.ToUpper(method), path, unix, tokenID}, "\n")
}

// verifyRunnerProof checks an X-Ex-Runner-Proof header,
// "v1.<unix-seconds>.<base64url DER signature>", against the install's key.
// The signature is checked before the clock, so garbage with a stale
// timestamp still counts as a bad proof.
func verifyRunnerProof(deviceKey, tokenID string, req RunnerRequest, now time.Time) proofVerdict {
	parts := strings.Split(req.Proof, ".")
	if len(parts) != 3 || parts[0] != "v1" {
		return proofBad
	}
	ts, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || strconv.FormatInt(ts, 10) != parts[1] {
		return proofBad
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return proofBad
	}
	der, _ := base64.StdEncoding.DecodeString(deviceKey) // stored normalized
	pub := p256Key(der)
	sum := sha256.Sum256([]byte(runnerProofMessage(req.Method, req.Path, parts[1], tokenID)))
	if pub == nil || !ecdsa.VerifyASN1(pub, sum[:], sig) {
		return proofBad
	}
	if d := now.Sub(time.Unix(ts, 0)); d > runnerProofSkew || d < -runnerProofSkew {
		return proofSkewed
	}
	return proofOK
}
