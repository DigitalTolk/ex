package service

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// ------------------------------------------------------------------ fakes

var errRTFake = errors.New("rt fake failure")

type rtFakeStore struct {
	grants map[string]*model.RunnerGrant
	tokens map[string]*model.RunnerToken
	fail   map[string]error // method name → error to return
}

func newRTFakeStore() *rtFakeStore {
	return &rtFakeStore{grants: map[string]*model.RunnerGrant{}, tokens: map[string]*model.RunnerToken{}, fail: map[string]error{}}
}

func (f *rtFakeStore) PutRunnerGrant(_ context.Context, g *model.RunnerGrant) error {
	if err := f.fail["PutRunnerGrant"]; err != nil {
		return err
	}
	cp := *g
	f.grants[g.CodeHash] = &cp
	return nil
}

func (f *rtFakeStore) TakeRunnerGrant(_ context.Context, codeHash string) (*model.RunnerGrant, error) {
	if err := f.fail["TakeRunnerGrant"]; err != nil {
		return nil, err
	}
	g, ok := f.grants[codeHash]
	if !ok {
		return nil, store.ErrNotFound
	}
	delete(f.grants, codeHash)
	return g, nil
}

func (f *rtFakeStore) PutRunnerToken(_ context.Context, t *model.RunnerToken) error {
	if err := f.fail["PutRunnerToken"]; err != nil {
		return err
	}
	cp := *t
	f.tokens[t.ID] = &cp
	return nil
}

func (f *rtFakeStore) GetRunnerToken(_ context.Context, id string) (*model.RunnerToken, error) {
	if err := f.fail["GetRunnerToken"]; err != nil {
		return nil, err
	}
	t, ok := f.tokens[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *t
	return &cp, nil
}

func (f *rtFakeStore) SetRunnerTokenExpiry(_ context.Context, id string, expiresAt time.Time) error {
	if err := f.fail["SetRunnerTokenExpiry"]; err != nil {
		return err
	}
	t, ok := f.tokens[id]
	if !ok {
		return store.ErrNotFound
	}
	t.ExpiresAt = expiresAt
	return nil
}

func (f *rtFakeStore) ListRunnerTokens(_ context.Context, userID string) ([]*model.RunnerToken, error) {
	if err := f.fail["ListRunnerTokens"]; err != nil {
		return nil, err
	}
	var out []*model.RunnerToken
	for _, t := range f.tokens {
		if t.UserID == userID {
			cp := *t
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (f *rtFakeStore) DeleteRunnerToken(_ context.Context, id string) error {
	if err := f.fail["DeleteRunnerToken"]; err != nil {
		return err
	}
	delete(f.tokens, id)
	return nil
}

func (f *rtFakeStore) DeleteAllRunnerTokensForUser(_ context.Context, userID string) error {
	if err := f.fail["DeleteAllRunnerTokensForUser"]; err != nil {
		return err
	}
	for id, t := range f.tokens {
		if t.UserID == userID {
			delete(f.tokens, id)
		}
	}
	return nil
}

type rtFakeUsers struct {
	users map[string]*model.User
	err   error
}

func (u *rtFakeUsers) GetByID(_ context.Context, id string) (*model.User, error) {
	if u.err != nil {
		return nil, u.err
	}
	user, ok := u.users[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	return user, nil
}

type rtFakeMinter struct{ err error }

func (m *rtFakeMinter) GenerateRunnerToken(user *model.User, tokenID string, expiresAt time.Time) (string, error) {
	if m.err != nil {
		return "", m.err
	}
	return "jwt:" + user.ID + ":" + tokenID + ":" + expiresAt.UTC().Format(time.RFC3339), nil
}

type rtEnv struct {
	svc    *RunnerTokenService
	store  *rtFakeStore
	users  *rtFakeUsers
	minter *rtFakeMinter
	now    time.Time
}

func newRTEnv() *rtEnv {
	env := &rtEnv{
		store: newRTFakeStore(),
		users: &rtFakeUsers{users: map[string]*model.User{
			"u-alice": {ID: "u-alice", DisplayName: "Alice", Status: "active"},
			"u-gone":  {ID: "u-gone", DisplayName: "Gone", Status: "deactivated"},
			"a-gg":    {ID: "a-gg", DisplayName: "gg", Kind: model.UserKindAgent},
		}},
		minter: &rtFakeMinter{},
		now:    time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC),
	}
	env.svc = NewRunnerTokenService(env.store, env.users, env.minter)
	env.svc.now = func() time.Time { return env.now }
	n := 0
	env.svc.newID = func() string { n++; return "rt-" + string(rune('0'+n)) }
	return env
}

// rtPKCE returns a valid verifier and its S256 challenge.
func rtPKCE(seed string) (verifier, challenge string) {
	verifier = strings.Repeat(seed, 43)[:43]
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:])
}

// grant runs CreateGrant for alice and returns the code + verifier.
func (e *rtEnv) grant(t *testing.T, label string) (code, verifier string) {
	t.Helper()
	verifier, challenge := rtPKCE("v")
	code, _, err := e.svc.CreateGrant(context.Background(), "u-alice", challenge, label)
	if err != nil {
		t.Fatalf("CreateGrant: %v", err)
	}
	return code, verifier
}

// ------------------------------------------------------------------ CreateGrant

func TestRunnerToken_CreateGrant(t *testing.T) {
	ctx := context.Background()
	env := newRTEnv()
	_, challenge := rtPKCE("v")

	if _, _, err := env.svc.CreateGrant(ctx, "u-alice", "not-a-challenge", "mac"); !errors.Is(err, ErrValidation) {
		t.Fatalf("bad challenge: want ErrValidation, got %v", err)
	}
	if _, _, err := env.svc.CreateGrant(ctx, "u-ghost", challenge, "mac"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown user: want wrapped ErrNotFound, got %v", err)
	}
	for _, uid := range []string{"a-gg", "u-gone"} {
		if _, _, err := env.svc.CreateGrant(ctx, uid, challenge, "mac"); !errors.Is(err, ErrForbidden) {
			t.Fatalf("%s: want ErrForbidden, got %v", uid, err)
		}
	}

	env.store.fail["PutRunnerGrant"] = errRTFake
	if _, _, err := env.svc.CreateGrant(ctx, "u-alice", challenge, "mac"); !errors.Is(err, errRTFake) {
		t.Fatalf("store failure: want errRTFake, got %v", err)
	}
	delete(env.store.fail, "PutRunnerGrant")

	orig := randRead
	randRead = func([]byte) (int, error) { return 0, errRTFake }
	_, _, err := env.svc.CreateGrant(ctx, "u-alice", challenge, "mac")
	randRead = orig
	if !errors.Is(err, errRTFake) {
		t.Fatalf("entropy failure: want errRTFake, got %v", err)
	}

	code, exp, err := env.svc.CreateGrant(ctx, "u-alice", challenge, "  Alice's\tMac\n ")
	if err != nil {
		t.Fatalf("CreateGrant: %v", err)
	}
	if !exp.Equal(env.now.Add(runnerGrantTTL)) {
		t.Fatalf("grant expiry = %v", exp)
	}
	g := env.store.grants[hashRunnerCode(code)]
	if g == nil || g.UserID != "u-alice" || g.Challenge != challenge || g.Label != "Alice's Mac" {
		t.Fatalf("stored grant = %+v (must be keyed by the code's hash, never the code)", g)
	}
	if _, raw := env.store.grants[code]; raw {
		t.Fatal("grant stored under the raw code")
	}
}

func TestRunnerToken_CleanLabel(t *testing.T) {
	if got := cleanRunnerLabel("a\x00b \u200b\t c\u202e"); got != "a b c" {
		t.Fatalf("control/space/format handling: %q", got)
	}
	if got := cleanRunnerLabel(" \t\n"); got != "Unnamed computer" {
		t.Fatalf("empty: %q", got)
	}
	long := strings.Repeat("é", 70)
	if got := cleanRunnerLabel(long); len([]rune(got)) != runnerLabelMax {
		t.Fatalf("long label: %d runes", len([]rune(got)))
	}
}

// ------------------------------------------------------------------ Exchange

func TestRunnerToken_ExchangeIssuesOnceAndRecords(t *testing.T) {
	ctx := context.Background()
	env := newRTEnv()
	code, verifier := env.grant(t, "mac")

	issued, err := env.svc.Exchange(ctx, code, verifier)
	if err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	wantExp := env.now.Add(RunnerTokenTTL)
	if issued.ID != "rt-1" || issued.Label != "mac" || issued.UserName != "Alice" || !issued.ExpiresAt.Equal(wantExp) {
		t.Fatalf("issued = %+v", issued)
	}
	if issued.Token != "jwt:u-alice:rt-1:"+wantExp.Format(time.RFC3339) {
		t.Fatalf("token not minted for the recorded id/expiry: %q", issued.Token)
	}
	rec := env.store.tokens["rt-1"]
	if rec == nil || rec.UserID != "u-alice" || rec.Label != "mac" || !rec.CreatedAt.Equal(env.now) || !rec.ExpiresAt.Equal(wantExp) {
		t.Fatalf("record = %+v", rec)
	}
	if _, err := env.svc.Exchange(ctx, code, verifier); !errors.Is(err, ErrRunnerGrantInvalid) {
		t.Fatalf("second redemption: want ErrRunnerGrantInvalid, got %v", err)
	}
}

func TestRunnerToken_ExchangeRefusals(t *testing.T) {
	ctx := context.Background()
	verifier, _ := rtPKCE("v")

	t.Run("malformed input", func(t *testing.T) {
		env := newRTEnv()
		for _, c := range [][2]string{{"", verifier}, {"code", "short"}, {"code", strings.Repeat("!", 50)}} {
			if _, err := env.svc.Exchange(ctx, c[0], c[1]); !errors.Is(err, ErrRunnerGrantInvalid) {
				t.Fatalf("%q/%q: want ErrRunnerGrantInvalid, got %v", c[0], c[1], err)
			}
		}
	})
	t.Run("unknown code", func(t *testing.T) {
		env := newRTEnv()
		if _, err := env.svc.Exchange(ctx, "nope", verifier); !errors.Is(err, ErrRunnerGrantInvalid) {
			t.Fatalf("want ErrRunnerGrantInvalid, got %v", err)
		}
	})
	t.Run("store failure", func(t *testing.T) {
		env := newRTEnv()
		env.store.fail["TakeRunnerGrant"] = errRTFake
		if _, err := env.svc.Exchange(ctx, "code", verifier); !errors.Is(err, errRTFake) {
			t.Fatalf("want errRTFake, got %v", err)
		}
	})
	t.Run("expired grant", func(t *testing.T) {
		env := newRTEnv()
		code, v := env.grant(t, "mac")
		env.now = env.now.Add(runnerGrantTTL)
		if _, err := env.svc.Exchange(ctx, code, v); !errors.Is(err, ErrRunnerGrantInvalid) {
			t.Fatalf("want ErrRunnerGrantInvalid, got %v", err)
		}
	})
	t.Run("wrong verifier burns the code", func(t *testing.T) {
		env := newRTEnv()
		code, v := env.grant(t, "mac")
		wrong, _ := rtPKCE("w")
		if _, err := env.svc.Exchange(ctx, code, wrong); !errors.Is(err, ErrRunnerGrantInvalid) {
			t.Fatalf("want ErrRunnerGrantInvalid, got %v", err)
		}
		if _, err := env.svc.Exchange(ctx, code, v); !errors.Is(err, ErrRunnerGrantInvalid) {
			t.Fatalf("code must be spent after a wrong verifier, got %v", err)
		}
	})
	t.Run("owner vanished, failed lookup, deactivated", func(t *testing.T) {
		env := newRTEnv()
		code, v := env.grant(t, "mac")
		delete(env.users.users, "u-alice")
		if _, err := env.svc.Exchange(ctx, code, v); !errors.Is(err, ErrRunnerGrantInvalid) {
			t.Fatalf("vanished owner: want ErrRunnerGrantInvalid, got %v", err)
		}

		env = newRTEnv()
		code, v = env.grant(t, "mac")
		env.users.err = errRTFake
		if _, err := env.svc.Exchange(ctx, code, v); !errors.Is(err, errRTFake) {
			t.Fatalf("lookup failure: want errRTFake, got %v", err)
		}

		env = newRTEnv()
		code, v = env.grant(t, "mac")
		env.users.users["u-alice"].Status = "deactivated"
		if _, err := env.svc.Exchange(ctx, code, v); !errors.Is(err, ErrRunnerGrantInvalid) {
			t.Fatalf("deactivated: want ErrRunnerGrantInvalid, got %v", err)
		}
	})
	t.Run("mint and record failures", func(t *testing.T) {
		env := newRTEnv()
		code, v := env.grant(t, "mac")
		env.minter.err = errRTFake
		if _, err := env.svc.Exchange(ctx, code, v); !errors.Is(err, errRTFake) {
			t.Fatalf("mint: want errRTFake, got %v", err)
		}

		env = newRTEnv()
		code, v = env.grant(t, "mac")
		env.store.fail["PutRunnerToken"] = errRTFake
		if _, err := env.svc.Exchange(ctx, code, v); !errors.Is(err, errRTFake) {
			t.Fatalf("record: want errRTFake, got %v", err)
		}
	})
}

// ------------------------------------------------------------------ check, renew

func (e *rtEnv) seedToken(id, userID string, expiresAt time.Time) {
	e.store.tokens[id] = &model.RunnerToken{ID: id, UserID: userID, Label: "mac", CreatedAt: e.now, ExpiresAt: expiresAt}
}

func rtClaims(id, userID string) *model.TokenClaims {
	c := &model.TokenClaims{UserID: userID, Scope: model.TokenScopeRunner}
	c.ID = id
	return c
}

func TestRunnerToken_Active(t *testing.T) {
	ctx := context.Background()
	env := newRTEnv()
	env.seedToken("rt-live", "u-alice", env.now.Add(time.Hour))
	env.seedToken("rt-old", "u-alice", env.now)

	cases := []struct {
		name   string
		claims *model.TokenClaims
		want   bool
	}{
		{"no jti (pre-revocation token)", rtClaims("", "u-alice"), false},
		{"revoked", rtClaims("rt-missing", "u-alice"), false},
		{"someone else's id", rtClaims("rt-live", "u-bob"), false},
		{"expired record", rtClaims("rt-old", "u-alice"), false},
		{"live", rtClaims("rt-live", "u-alice"), true},
	}
	for _, c := range cases {
		got, err := env.svc.RunnerTokenActive(ctx, c.claims)
		if err != nil || got != c.want {
			t.Errorf("%s: got %v, %v; want %v", c.name, got, err, c.want)
		}
	}
	env.store.fail["GetRunnerToken"] = errRTFake
	if _, err := env.svc.RunnerTokenActive(ctx, rtClaims("rt-live", "u-alice")); !errors.Is(err, errRTFake) {
		t.Fatalf("store failure must surface (→ 503), got %v", err)
	}
}

func TestRunnerToken_Renew(t *testing.T) {
	ctx := context.Background()
	live := rtClaims("rt-live", "u-alice")

	t.Run("extends the same install", func(t *testing.T) {
		env := newRTEnv()
		env.seedToken("rt-live", "u-alice", env.now.Add(48*time.Hour))
		issued, err := env.svc.Renew(ctx, live)
		if err != nil {
			t.Fatalf("Renew: %v", err)
		}
		want := env.now.Add(RunnerTokenTTL)
		if issued.ID != "rt-live" || !issued.ExpiresAt.Equal(want) || !env.store.tokens["rt-live"].ExpiresAt.Equal(want) {
			t.Fatalf("renewal = %+v, record = %+v", issued, env.store.tokens["rt-live"])
		}
		if issued.Token != "jwt:u-alice:rt-live:"+want.Format(time.RFC3339) {
			t.Fatalf("token = %q", issued.Token)
		}
	})
	t.Run("refusals and failures", func(t *testing.T) {
		env := newRTEnv()
		if _, err := env.svc.Renew(ctx, live); !errors.Is(err, ErrRunnerTokenRevoked) {
			t.Fatalf("revoked: want ErrRunnerTokenRevoked, got %v", err)
		}
		env.store.fail["GetRunnerToken"] = errRTFake
		if _, err := env.svc.Renew(ctx, live); !errors.Is(err, errRTFake) {
			t.Fatalf("check failure: want errRTFake, got %v", err)
		}
		delete(env.store.fail, "GetRunnerToken")

		env.seedToken("rt-live", "u-alice", env.now.Add(time.Hour))
		env.users.err = errRTFake
		if _, err := env.svc.Renew(ctx, live); !errors.Is(err, errRTFake) {
			t.Fatalf("user lookup: want errRTFake, got %v", err)
		}
		env.users.err = nil

		env.users.users["u-alice"].Status = "deactivated"
		if _, err := env.svc.Renew(ctx, live); !errors.Is(err, ErrRunnerTokenRevoked) {
			t.Fatalf("deactivated: want ErrRunnerTokenRevoked, got %v", err)
		}
		env.users.users["u-alice"].Status = "active"

		env.store.fail["SetRunnerTokenExpiry"] = store.ErrNotFound
		if _, err := env.svc.Renew(ctx, live); !errors.Is(err, ErrRunnerTokenRevoked) {
			t.Fatalf("revoked mid-renewal: want ErrRunnerTokenRevoked, got %v", err)
		}
		env.store.fail["SetRunnerTokenExpiry"] = errRTFake
		if _, err := env.svc.Renew(ctx, live); !errors.Is(err, errRTFake) {
			t.Fatalf("store failure: want errRTFake, got %v", err)
		}
		delete(env.store.fail, "SetRunnerTokenExpiry")

		env.minter.err = errRTFake
		if _, err := env.svc.Renew(ctx, live); !errors.Is(err, errRTFake) {
			t.Fatalf("mint failure: want errRTFake, got %v", err)
		}
	})
}

// ------------------------------------------------------------------ list, revoke

func TestRunnerToken_ListNewestFirstWithoutExpired(t *testing.T) {
	ctx := context.Background()
	env := newRTEnv()
	env.store.tokens["a"] = &model.RunnerToken{ID: "a", UserID: "u-alice", CreatedAt: env.now.Add(-2 * time.Hour), ExpiresAt: env.now.Add(time.Hour)}
	env.store.tokens["b"] = &model.RunnerToken{ID: "b", UserID: "u-alice", CreatedAt: env.now.Add(-time.Hour), ExpiresAt: env.now.Add(time.Hour)}
	env.store.tokens["dead"] = &model.RunnerToken{ID: "dead", UserID: "u-alice", CreatedAt: env.now, ExpiresAt: env.now}
	env.store.tokens["bob"] = &model.RunnerToken{ID: "bob", UserID: "u-bob", CreatedAt: env.now, ExpiresAt: env.now.Add(time.Hour)}

	got, err := env.svc.List(ctx, "u-alice")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 2 || got[0].ID != "b" || got[1].ID != "a" {
		t.Fatalf("List = %+v", got)
	}
	env.store.fail["ListRunnerTokens"] = errRTFake
	if _, err := env.svc.List(ctx, "u-alice"); !errors.Is(err, errRTFake) {
		t.Fatalf("want errRTFake, got %v", err)
	}
}

func TestRunnerToken_RevokeOwnOnly(t *testing.T) {
	ctx := context.Background()
	env := newRTEnv()
	env.seedToken("rt-a", "u-alice", env.now.Add(time.Hour))
	env.seedToken("rt-b", "u-bob", env.now.Add(time.Hour))

	if err := env.svc.Revoke(ctx, "u-alice", "rt-b"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("someone else's install must read as not found, got %v", err)
	}
	if _, ok := env.store.tokens["rt-b"]; !ok {
		t.Fatal("another user's install was revoked")
	}
	if err := env.svc.Revoke(ctx, "u-alice", "rt-missing"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing: want ErrNotFound, got %v", err)
	}
	env.store.fail["DeleteRunnerToken"] = errRTFake
	if err := env.svc.Revoke(ctx, "u-alice", "rt-a"); !errors.Is(err, errRTFake) {
		t.Fatalf("delete failure: want errRTFake, got %v", err)
	}
	delete(env.store.fail, "DeleteRunnerToken")
	if err := env.svc.Revoke(ctx, "u-alice", "rt-a"); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if _, ok := env.store.tokens["rt-a"]; ok {
		t.Fatal("install not revoked")
	}
	env.store.fail["GetRunnerToken"] = errRTFake
	if err := env.svc.Revoke(ctx, "u-alice", "rt-a"); !errors.Is(err, errRTFake) {
		t.Fatalf("lookup failure: want errRTFake, got %v", err)
	}
}

func TestRunnerToken_RevokeSelfAndAll(t *testing.T) {
	ctx := context.Background()
	env := newRTEnv()
	env.seedToken("rt-1", "u-alice", env.now.Add(time.Hour))
	env.seedToken("rt-2", "u-alice", env.now.Add(time.Hour))
	env.seedToken("rt-3", "u-bob", env.now.Add(time.Hour))

	if err := env.svc.RevokeSelf(ctx, rtClaims("rt-1", "u-alice")); err != nil {
		t.Fatalf("RevokeSelf: %v", err)
	}
	if err := env.svc.RevokeAllForUser(ctx, "u-alice"); err != nil {
		t.Fatalf("RevokeAllForUser: %v", err)
	}
	if len(env.store.tokens) != 1 || env.store.tokens["rt-3"] == nil {
		t.Fatalf("remaining = %v", env.store.tokens)
	}
	env.store.fail["DeleteRunnerToken"] = errRTFake
	env.store.fail["DeleteAllRunnerTokensForUser"] = errRTFake
	if err := env.svc.RevokeSelf(ctx, rtClaims("rt-3", "u-bob")); !errors.Is(err, errRTFake) {
		t.Fatalf("RevokeSelf failure: %v", err)
	}
	if err := env.svc.RevokeAllForUser(ctx, "u-bob"); !errors.Is(err, errRTFake) {
		t.Fatalf("RevokeAllForUser failure: %v", err)
	}
}

// ------------------------------------------------------------------ account lifecycle

type rtFakeRevoker struct {
	revoked []string
	err     error
}

func (r *rtFakeRevoker) RevokeAllForUser(_ context.Context, userID string) error {
	r.revoked = append(r.revoked, userID)
	return r.err
}

func TestUserService_Deactivate_DisconnectsRunners(t *testing.T) {
	users := newMockUserStore()
	svc := NewUserService(users, nil, nil, &mockPublisher{})
	revoker := &rtFakeRevoker{}
	svc.SetRunnerRevoker(revoker)
	users.users["u-r"] = &model.User{ID: "u-r", SystemRole: model.SystemRoleGuest, AuthProvider: model.AuthProviderGuest, Status: "active"}

	if _, err := svc.SetStatus(context.Background(), "u-r", false); err != nil {
		t.Fatalf("reactivate no-op: %v", err)
	}
	if len(revoker.revoked) != 0 {
		t.Fatal("reactivation must not touch runners")
	}
	if _, err := svc.SetStatus(context.Background(), "u-r", true); err != nil {
		t.Fatalf("deactivate: %v", err)
	}
	if len(revoker.revoked) != 1 || revoker.revoked[0] != "u-r" {
		t.Fatalf("revoked = %v", revoker.revoked)
	}
}

func TestResetPassword_DisconnectsRunnersEvenIfThatFails(t *testing.T) {
	for _, revokeErr := range []error{nil, errRTFake} {
		env := setupPasswordReset(t)
		revoker := &rtFakeRevoker{err: revokeErr}
		env.svc.SetRunnerRevoker(revoker)
		env.resets.tickets[hashToken("tok")] = "u-guest"
		if err := env.svc.ResetPassword(context.Background(), "tok", "long-enough-password"); err != nil {
			t.Fatalf("ResetPassword (revoke err %v) = %v", revokeErr, err)
		}
		if len(revoker.revoked) != 1 || revoker.revoked[0] != "u-guest" {
			t.Fatalf("revoked = %v", revoker.revoked)
		}
	}
}
