package agents

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// rtDeviceKey is a runner's device key: the private half signs, the public
// half is what the runner sends at sign-in.
type rtDeviceKey struct {
	priv *ecdsa.PrivateKey
	pub  string // base64 std SPKI DER
}

func newRTDeviceKey(t *testing.T, curve elliptic.Curve) rtDeviceKey {
	t.Helper()
	priv, err := ecdsa.GenerateKey(curve, rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	der, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	return rtDeviceKey{priv: priv, pub: base64.StdEncoding.EncodeToString(der)}
}

// proof signs one request exactly as the runner does: the newline-joined
// message, SHA-256, ASN.1 DER signature, base64url without padding.
func (k rtDeviceKey) proof(t *testing.T, method, path string, at time.Time, tokenID string) string {
	t.Helper()
	unix := strconv.FormatInt(at.Unix(), 10)
	msg := "ex-runner-proof/v1\n" + method + "\n" + path + "\n" + unix + "\n" + tokenID
	sum := sha256.Sum256([]byte(msg))
	sig, err := ecdsa.SignASN1(rand.Reader, k.priv, sum[:])
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return "v1." + unix + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// keyedEnv is an env with alice's keyed install rt-key, a notifier and a
// publisher attached.
type keyedEnv struct {
	*rtEnv
	key      rtDeviceKey
	notifier *fakeNotifier
	pub      *mockPublisher
}

func newKeyedEnv(t *testing.T) *keyedEnv {
	env := &keyedEnv{rtEnv: newRTEnv(), key: newRTDeviceKey(t, elliptic.P256()), notifier: &fakeNotifier{}, pub: newMockPublisher()}
	env.svc.SetOwnerNotifier(env.notifier)
	env.svc.SetPublisher(env.pub)
	env.seedToken("rt-key", "u-alice", env.now.Add(time.Hour))
	env.store.tokens["rt-key"].DeviceKey = env.key.pub
	env.store.tokens["rt-key"].DeviceKeyHardware = true
	return env
}

func (e *keyedEnv) request(t *testing.T, proof string) RunnerRequest {
	return RunnerRequest{Method: "POST", Path: "/api/v1/agent/runner/heartbeat", Proof: proof, IP: "198.51.100.7"}
}

func (e *keyedEnv) signed(t *testing.T, at time.Time) RunnerRequest {
	return e.request(t, e.key.proof(t, "POST", "/api/v1/agent/runner/heartbeat", at, "rt-key"))
}

// wantRevokedAndAlerted asserts the install is gone, its owner was told once
// (title, body naming the computer, a link to the Runners page) and their
// clients were nudged to refetch the list.
func (e *keyedEnv) wantRevokedAndAlerted(t *testing.T, id string) {
	t.Helper()
	if _, ok := e.store.tokens[id]; ok {
		t.Fatalf("%s survived", id)
	}
	if len(e.notifier.got) != 1 {
		t.Fatalf("owner alerted %d times, want once", len(e.notifier.got))
	}
	n := e.notifier.got[0]
	wantBody := "“mac” was used from somewhere other than the computer it was set up on, so ex disconnected it. " +
		"If you didn't do this, tell your admin. To reconnect, run ex-runner login on your computer."
	if n.Title != "Runner disconnected for your safety" || n.Body != wantBody || n.DeepLink != "/runners" ||
		n.AlertID != "runner-revoked:"+id || n.Kind != service.NotificationKindApproval || !n.CreatedAt.Equal(e.now) {
		t.Fatalf("alert = %+v", n)
	}
	if len(e.pub.published) != 1 || e.pub.published[0].channel != pubsub.UserChannel("u-alice") || e.pub.published[0].event.Type != events.EventRunnersChanged {
		t.Fatalf("published = %+v", e.pub.published)
	}
}

// ------------------------------------------------------------------ keys

func TestRunnerDevice_ParseKey(t *testing.T) {
	if k, err := parseDeviceKey(nil); k != "" || err != nil {
		t.Fatalf("no key: %q, %v", k, err)
	}
	good := newRTDeviceKey(t, elliptic.P256())
	wrapped := good.pub[:20] + "\n" + good.pub[20:]
	if k, err := parseDeviceKey(&RunnerDeviceKey{PublicKey: wrapped}); err != nil || k != good.pub {
		t.Fatalf("P-256 key: %q, %v (want it re-encoded without the line break)", k, err)
	}
	p384 := newRTDeviceKey(t, elliptic.P384())
	for name, raw := range map[string]string{
		"not base64":   "%%%",
		"not a key":    base64.StdEncoding.EncodeToString([]byte("hello")),
		"wrong curve":  p384.pub,
		"empty string": "",
	} {
		if _, err := parseDeviceKey(&RunnerDeviceKey{PublicKey: raw}); !errors.Is(err, ErrInvalidDeviceKey) {
			t.Errorf("%s: want ErrInvalidDeviceKey, got %v", name, err)
		}
	}
}

func TestRunnerDevice_ExchangeBindsTheKey(t *testing.T) {
	ctx := context.Background()
	key := newRTDeviceKey(t, elliptic.P256())

	env := newRTEnv()
	code, verifier := env.grant(t, "mac")
	if _, err := env.svc.Exchange(ctx, code, verifier, &RunnerDeviceKey{PublicKey: key.pub, Hardware: true}); err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if rec := env.store.tokens["rt-1"]; rec.DeviceKey != key.pub || !rec.DeviceKeyHardware {
		t.Fatalf("record = %+v, want the hardware key bound", rec)
	}

	env = newRTEnv()
	code, verifier = env.grant(t, "mac")
	if _, err := env.svc.Exchange(ctx, code, verifier, &RunnerDeviceKey{PublicKey: key.pub}); err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if rec := env.store.tokens["rt-1"]; rec.DeviceKey != key.pub || rec.DeviceKeyHardware {
		t.Fatalf("record = %+v, want the software key bound", rec)
	}

	// A bad key is refused before the code is spent: the runner can retry.
	env = newRTEnv()
	code, verifier = env.grant(t, "mac")
	if _, err := env.svc.Exchange(ctx, code, verifier, &RunnerDeviceKey{PublicKey: "nope"}); !errors.Is(err, ErrInvalidDeviceKey) {
		t.Fatalf("bad key: want ErrInvalidDeviceKey, got %v", err)
	}
	if _, err := env.svc.Exchange(ctx, code, verifier, nil); err != nil {
		t.Fatalf("the code must survive a refused key: %v", err)
	}
	if rec := env.store.tokens["rt-1"]; rec.DeviceKey != "" || rec.DeviceKeyHardware {
		t.Fatalf("keyless exchange recorded a key: %+v", rec)
	}
}

// ------------------------------------------------------------------ proofs

func TestRunnerDevice_ValidProofPasses(t *testing.T) {
	env := newKeyedEnv(t)
	for _, at := range []time.Time{env.now, env.now.Add(-runnerProofSkew), env.now.Add(runnerProofSkew)} {
		if err := env.svc.AuthorizeRunner(context.Background(), rtClaims("rt-key", "u-alice"), env.signed(t, at)); err != nil {
			t.Fatalf("signed at %v: %v", at, err)
		}
	}
	if len(env.notifier.got) != 0 {
		t.Fatal("a valid proof alerted the owner")
	}
}

func TestRunnerDevice_SkewedClockIsNotRevoked(t *testing.T) {
	ctx := context.Background()
	env := newKeyedEnv(t)
	for _, at := range []time.Time{env.now.Add(-runnerProofSkew - time.Second), env.now.Add(runnerProofSkew + time.Second)} {
		if err := env.svc.AuthorizeRunner(ctx, rtClaims("rt-key", "u-alice"), env.signed(t, at)); !errors.Is(err, ErrRunnerClockSkew) {
			t.Fatalf("signed at %v: want ErrRunnerClockSkew, got %v", at, err)
		}
	}
	if _, ok := env.store.tokens["rt-key"]; !ok || len(env.notifier.got) != 0 {
		t.Fatal("a skewed clock must not revoke or alert")
	}
	// Garbage with a stale timestamp is still garbage: the signature is
	// checked first.
	stale := strconv.FormatInt(env.now.Add(-time.Hour).Unix(), 10)
	if err := env.svc.AuthorizeRunner(ctx, rtClaims("rt-key", "u-alice"), env.request(t, "v1."+stale+".AAAA")); !errors.Is(err, ErrRunnerTokenRevoked) {
		t.Fatalf("bad signature, stale time: want ErrRunnerTokenRevoked, got %v", err)
	}
	env.wantRevokedAndAlerted(t, "rt-key")
}

func TestRunnerDevice_BadProofRevokesAndAlerts(t *testing.T) {
	other := newRTDeviceKey(t, elliptic.P256())
	cases := map[string]func(e *keyedEnv) RunnerRequest{
		"missing":          func(e *keyedEnv) RunnerRequest { return e.request(t, "") },
		"wrong version":    func(e *keyedEnv) RunnerRequest { return e.request(t, "v2"+e.signed(t, e.now).Proof[2:]) },
		"too few parts":    func(e *keyedEnv) RunnerRequest { return e.request(t, "v1.123") },
		"not a number":     func(e *keyedEnv) RunnerRequest { return e.request(t, "v1.abc.AAAA") },
		"padded number":    func(e *keyedEnv) RunnerRequest { return e.request(t, "v1.0"+e.signed(t, e.now).Proof[3:]) },
		"signature base64": func(e *keyedEnv) RunnerRequest { return e.request(t, "v1.123.!!!") },
		"another key": func(e *keyedEnv) RunnerRequest {
			return e.request(t, other.proof(t, "POST", "/api/v1/agent/runner/heartbeat", e.now, "rt-key"))
		},
		"another path": func(e *keyedEnv) RunnerRequest {
			return e.request(t, e.key.proof(t, "POST", "/api/v1/agent/runner/claim", e.now, "rt-key"))
		},
		"another token": func(e *keyedEnv) RunnerRequest {
			return e.request(t, e.key.proof(t, "POST", "/api/v1/agent/runner/heartbeat", e.now, "rt-other"))
		},
		"stored key unreadable": func(e *keyedEnv) RunnerRequest {
			e.store.tokens["rt-key"].DeviceKey = "garbage"
			return e.signed(t, e.now)
		},
	}
	for name, req := range cases {
		t.Run(name, func(t *testing.T) {
			env := newKeyedEnv(t)
			if err := env.svc.AuthorizeRunner(context.Background(), rtClaims("rt-key", "u-alice"), req(env)); !errors.Is(err, ErrRunnerTokenRevoked) {
				t.Fatalf("got %v; want ErrRunnerTokenRevoked", err)
			}
			env.wantRevokedAndAlerted(t, "rt-key")
		})
	}
}

// Several requests caught at once: the conditional delete lets exactly one
// revoke and alert; the rest just read as disconnected.
func TestRunnerDevice_RevokeAlertsOnce(t *testing.T) {
	env := newKeyedEnv(t)
	env.store.fail["RevokeRunnerToken"] = store.ErrNotFound
	if err := env.svc.AuthorizeRunner(context.Background(), rtClaims("rt-key", "u-alice"), env.request(t, "")); !errors.Is(err, ErrRunnerTokenRevoked) {
		t.Fatalf("lost revoke race: want ErrRunnerTokenRevoked, got %v", err)
	}
	if len(env.notifier.got) != 0 || len(env.pub.published) != 0 {
		t.Fatal("the losing request must not alert again")
	}

	// A delete that fails is a failed check (→ 503, retried), never an alert
	// about a token that still works.
	env.store.fail["RevokeRunnerToken"] = errRTFake
	if err := env.svc.AuthorizeRunner(context.Background(), rtClaims("rt-key", "u-alice"), env.request(t, "")); !errors.Is(err, errRTFake) {
		t.Fatalf("failed revoke: want errRTFake, got %v", err)
	}
	if len(env.notifier.got) != 0 {
		t.Fatal("alerted about a revoke that failed")
	}

	// No notifier wired (tests, never production): the revoke still happens.
	env = newKeyedEnv(t)
	env.svc.SetOwnerNotifier(nil)
	if err := env.svc.AuthorizeRunner(context.Background(), rtClaims("rt-key", "u-alice"), env.request(t, "")); !errors.Is(err, ErrRunnerTokenRevoked) {
		t.Fatalf("want ErrRunnerTokenRevoked, got %v", err)
	}
	if _, ok := env.store.tokens["rt-key"]; ok {
		t.Fatal("install survived without a notifier")
	}
}

func TestRunnerDevice_RequireDeviceKey(t *testing.T) {
	ctx := context.Background()
	env := newRTEnv()
	env.seedToken("rt-old", "u-alice", env.now.Add(time.Hour))
	if err := env.svc.AuthorizeRunner(ctx, rtClaims("rt-old", "u-alice"), RunnerRequest{}); err != nil {
		t.Fatalf("keyless install while keys are optional: %v", err)
	}
	env.svc.SetRequireDeviceKey(true)
	// Every route refuses it, renew included: the runner must update and sign
	// in again.
	for _, path := range []string{"/api/v1/agent/runner/heartbeat", "/api/v1/agent/runner/renew"} {
		if err := env.svc.AuthorizeRunner(ctx, rtClaims("rt-old", "u-alice"), RunnerRequest{Method: "POST", Path: path}); !errors.Is(err, ErrRunnerUpgradeRequired) {
			t.Fatalf("%s while keys are required: want ErrRunnerUpgradeRequired, got %v", path, err)
		}
	}
	if _, ok := env.store.tokens["rt-old"]; !ok {
		t.Fatal("an old runner is told to upgrade, never revoked")
	}
}

// ------------------------------------------------------------------ last used

func TestRunnerDevice_TouchIsThrottled(t *testing.T) {
	ctx := context.Background()
	env := newRTEnv()
	env.seedToken("rt-a", "u-alice", env.now.Add(RunnerTokenTTL))
	claims := rtClaims("rt-a", "u-alice")
	call := func(ip string) {
		t.Helper()
		if err := env.svc.AuthorizeRunner(ctx, claims, RunnerRequest{IP: ip}); err != nil {
			t.Fatalf("AuthorizeRunner: %v", err)
		}
	}

	call("198.51.100.1")
	if got := env.store.tokens["rt-a"]; env.store.touches != 1 || !got.LastUsedAt.Equal(env.now) || got.LastIP != "198.51.100.1" {
		t.Fatalf("first use: touches=%d stored=%+v", env.store.touches, got)
	}
	env.now = env.now.Add(runnerTouchEvery)
	call("198.51.100.1")
	if env.store.touches != 1 {
		t.Fatalf("a request within %v from the same address wrote again (%d)", runnerTouchEvery, env.store.touches)
	}
	call("198.51.100.2")
	if env.store.touches != 2 {
		t.Fatal("a new address must be recorded right away")
	}
	env.now = env.now.Add(runnerTouchEvery + time.Second)
	call("198.51.100.2")
	if env.store.touches != 3 {
		t.Fatal("a stale stamp must be refreshed")
	}

	// Best effort: a failed write never fails the request.
	env.store.fail["TouchRunnerToken"] = errRTFake
	env.now = env.now.Add(time.Hour)
	before := env.store.tokens["rt-a"].LastUsedAt
	call("198.51.100.3")
	if got := env.store.tokens["rt-a"]; env.store.touches != 4 || got.LastIP != "198.51.100.2" || !got.LastUsedAt.Equal(before) {
		t.Fatalf("failed touch: touches=%d stored=%+v", env.store.touches, got)
	}
}

func TestRunnerDevice_ProofMessage(t *testing.T) {
	got := runnerProofMessage("post", "/api/v1/agent/runner/renew", "1700000000", "rt-1")
	want := strings.Join([]string{"ex-runner-proof/v1", "POST", "/api/v1/agent/runner/renew", "1700000000", "rt-1"}, "\n")
	if got != want {
		t.Fatalf("message = %q", got)
	}
}
