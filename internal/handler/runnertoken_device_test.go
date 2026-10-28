package handler

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/agents"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// hrtKey is a runner's device key, signing requests the way ex-runner does.
type hrtKey struct {
	priv *ecdsa.PrivateKey
	pub  string
}

func newHRTKey(t *testing.T) hrtKey {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return hrtKey{priv: priv, pub: base64.StdEncoding.EncodeToString(der)}
}

// proof is the X-Ex-Runner-Proof header for one request.
func (k hrtKey) proof(t *testing.T, method, path, tokenID string, at time.Time) string {
	t.Helper()
	unix := strconv.FormatInt(at.Unix(), 10)
	sum := sha256.Sum256([]byte(strings.Join([]string{"ex-runner-proof/v1", method, path, unix, tokenID}, "\n")))
	sig, err := ecdsa.SignASN1(rand.Reader, k.priv, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return "v1." + unix + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// hrtAlerts records the owner alerts NotifyDirect would deliver.
type hrtAlerts struct {
	mu  sync.Mutex
	got []service.Notification
	to  []string
}

func (a *hrtAlerts) NotifyDirect(_ context.Context, userID string, n service.Notification) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.got = append(a.got, n)
	a.to = append(a.to, userID)
}

func (e *hrtEnv) doWith(method, path, bearer, body string, header map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+bearer)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec
}

// signed sends a runner request with a fresh proof.
func (e *hrtEnv) signed(t *testing.T, key hrtKey, path, token, id, body string) *httptest.ResponseRecorder {
	t.Helper()
	return e.doWith(http.MethodPost, path, token, body, map[string]string{middleware.RunnerProofHeader: key.proof(t, http.MethodPost, path, id, time.Now())})
}

// pairWithKey pairs the way a device-key runner does: the public key rides
// the exchange.
func (e *hrtEnv) pairWithKey(t *testing.T, label string, key *agents.RunnerDeviceKey) (token, id string) {
	t.Helper()
	verifier, challenge := hrtPKCE()
	rec := e.do(http.MethodPost, "/api/v1/runner-tokens/grants", e.session(t, "u-alice"), `{"challenge":"`+challenge+`","label":"`+label+`"}`)
	hrtWant(t, rec, http.StatusCreated)
	code, _ := hrtDecode(t, rec)["code"].(string)
	body, _ := json.Marshal(map[string]any{"code": code, "verifier": verifier, "deviceKey": key})
	rec = e.do(http.MethodPost, "/api/v1/runner-tokens/exchange", "", string(body))
	hrtWant(t, rec, http.StatusOK)
	out := hrtDecode(t, rec)
	token, _ = out["token"].(string)
	id, _ = out["id"].(string)
	return token, id
}

func TestHRT_ExchangeRefusesABadDeviceKey(t *testing.T) {
	env := newHRTEnv()
	verifier, challenge := hrtPKCE()
	rec := env.do(http.MethodPost, "/api/v1/runner-tokens/grants", env.session(t, "u-alice"), `{"challenge":"`+challenge+`"}`)
	code, _ := hrtDecode(t, rec)["code"].(string)
	rec = env.do(http.MethodPost, "/api/v1/runner-tokens/exchange", "", `{"code":"`+code+`","verifier":"`+verifier+`","deviceKey":{"publicKey":"bm9wZQ==","hardware":true}}`)
	hrtWant(t, rec, http.StatusBadRequest)
	if c := hrtErrCode(t, rec); c != "invalid_device_key" {
		t.Fatalf("error code = %q, want invalid_device_key", c)
	}
}

// A keyed install works only with proofs: a signed request passes, a bare
// bearer token — what a copied credentials file gives — revokes the install
// and alerts its owner, and a skewed clock is told so without revoking.
func TestHRT_DeviceProofGuardsEveryRunnerRequest(t *testing.T) {
	env := newHRTEnv()
	alerts := &hrtAlerts{}
	env.svc.SetOwnerNotifier(alerts)
	key := newHRTKey(t)
	token, id := env.pairWithKey(t, "Alices-Mac", &agents.RunnerDeviceKey{PublicKey: key.pub, Hardware: true})
	if rec := env.store.tokens[id]; rec.DeviceKey != key.pub || !rec.DeviceKeyHardware {
		t.Fatalf("record = %+v", rec)
	}

	hrtWant(t, env.signed(t, key, "/api/v1/agent/runner/renew", token, id, "{}"), http.StatusOK)

	skewed := key.proof(t, http.MethodPost, "/api/v1/agent/runner/renew", id, time.Now().Add(-time.Hour))
	rec := env.doWith(http.MethodPost, "/api/v1/agent/runner/renew", token, "{}", map[string]string{middleware.RunnerProofHeader: skewed})
	hrtWant(t, rec, http.StatusUnauthorized)
	if c := hrtErrCode(t, rec); c != "runner_clock_skew" {
		t.Fatalf("error code = %q, want runner_clock_skew", c)
	}
	if len(alerts.got) != 0 || env.store.tokens[id] == nil {
		t.Fatal("a skewed clock must neither revoke nor alert")
	}

	rec = env.do(http.MethodPost, "/api/v1/agent/runner/revoke", token, "{}")
	hrtWant(t, rec, http.StatusUnauthorized)
	if c := hrtErrCode(t, rec); c != "runner_disconnected" {
		t.Fatalf("error code = %q, want runner_disconnected", c)
	}
	if _, ok := env.store.tokens[id]; ok {
		t.Fatal("an unsigned request on a keyed install must revoke it")
	}
	if len(alerts.got) != 1 || alerts.to[0] != "u-alice" || alerts.got[0].DeepLink != "/runners" || !strings.Contains(alerts.got[0].Body, "“Alices-Mac”") {
		t.Fatalf("alerts = %+v to %v", alerts.got, alerts.to)
	}
	// Even the real runner, with the key, is out now.
	hrtWant(t, env.signed(t, key, "/api/v1/agent/runner/renew", token, id, "{}"), http.StatusUnauthorized)
}

// With device keys required, a keyless install is refused on every runner
// route, renew included: the runner must update and sign in again.
func TestHRT_KeylessInstallMustSignInAgain(t *testing.T) {
	env := newHRTEnv()
	env.svc.SetRequireDeviceKey(true)
	token, id := env.pair(t, "u-alice", "mac")

	for _, path := range []string{"/api/v1/agent/runner/revoke", "/api/v1/agent/runner/renew"} {
		rec := env.do(http.MethodPost, path, token, "{}")
		hrtWant(t, rec, http.StatusUnauthorized)
		if c := hrtErrCode(t, rec); c != "runner_upgrade_required" {
			t.Fatalf("%s: error code = %q, want runner_upgrade_required", path, c)
		}
		if !strings.Contains(rec.Body.String(), "update ex-runner, then run ex-runner login again") {
			t.Fatalf("%s: message must say what to do: %s", path, rec.Body.String())
		}
	}
	if env.store.tokens[id] == nil {
		t.Fatal("an old runner is told to upgrade, never revoked")
	}
}

// The Runners page shows when and from where each computer was last used and
// what it is locked to — never the key itself.
func TestHRT_ListShowsLastUseAndKey(t *testing.T) {
	env := newHRTEnv()
	key := newHRTKey(t)
	hwToken, hw := env.pairWithKey(t, "hw", &agents.RunnerDeviceKey{PublicKey: key.pub, Hardware: true})
	_, sw := env.pairWithKey(t, "sw", &agents.RunnerDeviceKey{PublicKey: key.pub})
	_, none := env.pair(t, "u-alice", "none")
	hrtWant(t, env.signed(t, key, "/api/v1/agent/runner/renew", hwToken, hw, "{}"), http.StatusOK)

	rec := env.do(http.MethodGet, "/api/v1/runner-tokens", env.session(t, "u-alice"), "")
	hrtWant(t, rec, http.StatusOK)
	if strings.Contains(rec.Body.String(), key.pub) {
		t.Fatal("the device key leaked into the list")
	}
	var body struct {
		Runners []map[string]any `json:"runners"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	byID := map[string]map[string]any{}
	for _, r := range body.Runners {
		byID[r["id"].(string)] = r
	}
	if r := byID[hw]; r["deviceKey"] != "hardware" || r["lastIP"] != "192.0.2.1" || r["lastUsedAt"] == nil {
		t.Errorf("hardware install = %v", r)
	}
	if r := byID[sw]; r["deviceKey"] != "software" || r["lastUsedAt"] != nil || r["lastIP"] != nil {
		t.Errorf("software install = %v", r)
	}
	if r, ok := byID[none]["deviceKey"]; !ok || r != "" {
		t.Errorf("keyless install = %v", byID[none])
	}
}

// The checker answers every refusal with the error table's status and code,
// and passes anything unmapped through as a failed check.
func TestHRT_CheckerMapsRefusals(t *testing.T) {
	env := newHRTEnv()
	env.seedTokenForChecker()
	c := env.h.Checker()
	claims := &model.TokenClaims{UserID: "u-alice", Scope: model.TokenScopeRunner}
	claims.ID = "rt-gone"
	err := c.CheckRunner(context.Background(), claims, middleware.RunnerRequest{})
	var refusal *middleware.RunnerRefusal
	if !errors.As(err, &refusal) || refusal.Status != http.StatusUnauthorized || refusal.Code != "runner_disconnected" || refusal.Message != agents.ErrRunnerTokenRevoked.Error() {
		t.Fatalf("revoked install: %#v", err)
	}
	claims.ID = "rt-ok"
	if err := c.CheckRunner(context.Background(), claims, middleware.RunnerRequest{}); err != nil {
		t.Fatalf("live install: %v", err)
	}
}

func (e *hrtEnv) seedTokenForChecker() {
	e.store.tokens["rt-ok"] = &model.RunnerToken{ID: "rt-ok", UserID: "u-alice", Label: "mac", CreatedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour)}
}
