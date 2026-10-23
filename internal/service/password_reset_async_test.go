package service

import (
	"context"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/email"
	"github.com/DigitalTolk/ex/internal/model"
)

// blockingMailer holds every Send until release is closed.
type blockingMailer struct {
	release chan struct{}
	sent    chan email.Message
}

func (m *blockingMailer) Send(_ context.Context, msg email.Message) error {
	<-m.release
	m.sent <- msg
	return nil
}

// Regression: a guest address answered only after its reset mail had gone
// out, every other address at once — a timing oracle for "is this a guest
// account". The response no longer waits for any per-account work.
func TestRequestPasswordResetAnswersBeforeTheMailIsSent(t *testing.T) {
	env := setupAuthService()
	env.svc.SetPasswordResetStore(newMockResetStore())
	mailer := &blockingMailer{release: make(chan struct{}), sent: make(chan email.Message, 1)}
	env.svc.SetMailer(mailer, "https://ex.example.com")
	guest := &model.User{ID: "u-g", Email: "guest@example.com", SystemRole: model.SystemRoleGuest, AuthProvider: model.AuthProviderGuest, PasswordHash: "h", Status: "active"}
	env.users.users[guest.ID] = guest
	env.users.emailIndex[guest.Email] = guest

	returned := make(chan error, 1)
	go func() { returned <- env.svc.RequestPasswordReset(context.Background(), "guest@example.com") }()
	select {
	case err := <-returned:
		if err != nil {
			t.Fatalf("RequestPasswordReset = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RequestPasswordReset waited for the guest's mail to be sent")
	}
	close(mailer.release)
	select {
	case msg := <-mailer.sent:
		if msg.To != "guest@example.com" {
			t.Fatalf("mail to %v, want the guest", msg.To)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the reset mail was never sent")
	}
}

// syncBackground runs detached work inline so a test can assert its effects.
func syncBackground(env *authTestEnv) { env.svc.SetBackgroundRunner(func(fn func()) { fn() }) }

// The self-service endpoint must not be a mail cannon: one mail per address
// per cooldown, whoever asks.
func TestRequestPasswordResetCooldownPerAddress(t *testing.T) {
	env := setupPasswordReset(t)
	syncBackground(env.authTestEnv)
	ctx := context.Background()
	for range 3 {
		if err := env.svc.RequestPasswordReset(ctx, "guest@example.com"); err != nil {
			t.Fatalf("RequestPasswordReset = %v", err)
		}
	}
	if n := len(env.mailer.sent); n != 1 {
		t.Fatalf("mails sent = %d, want 1 within the cooldown", n)
	}
	// The cooldown is per address — and is taken for unknown addresses too,
	// so it reveals nothing.
	if err := env.svc.RequestPasswordReset(ctx, "nobody@example.com"); err != nil {
		t.Fatalf("unknown address = %v", err)
	}
	if _, ok := env.cache.values["pwreset:cooldown:"+hashToken("nobody@example.com")]; !ok {
		t.Fatal("an unknown address must take a cooldown slot too")
	}
}

// Without a cache (or with it down) nothing is throttled — a reset never
// hinges on Redis.
func TestRequestPasswordResetWithoutCacheIsNotThrottled(t *testing.T) {
	env := setupPasswordReset(t)
	syncBackground(env.authTestEnv)
	env.svc.cache = nil
	for range 2 {
		_ = env.svc.RequestPasswordReset(context.Background(), "guest@example.com")
	}
	if n := len(env.mailer.sent); n != 2 {
		t.Fatalf("mails sent = %d, want 2 without a cooldown store", n)
	}

	env2 := setupPasswordReset(t)
	syncBackground(env2.authTestEnv)
	env2.cache.setErr = errCacheDown
	for range 2 {
		_ = env2.svc.RequestPasswordReset(context.Background(), "guest@example.com")
	}
	if n := len(env2.mailer.sent); n != 2 {
		t.Fatalf("mails sent = %d, want 2 when the cooldown can't be recorded", n)
	}
}

var errCacheDown = &cacheDownErr{}

type cacheDownErr struct{}

func (*cacheDownErr) Error() string { return "cache down" }

// The detached work outlives the request's context (the handler returns
// before it runs) but is bounded by its own timeout.
func TestRequestPasswordResetDetachesFromTheRequestContext(t *testing.T) {
	env := setupPasswordReset(t)
	var queued []func()
	env.svc.background = func(fn func()) { queued = append(queued, fn) }
	var workCtxErr error
	var hasDeadline bool
	env.svc.resets = &ctxProbeResetStore{mockResetStore: newMockResetStore(), probe: func(ctx context.Context) {
		workCtxErr = ctx.Err()
		_, hasDeadline = ctx.Deadline()
	}}
	ctx, cancel := context.WithCancel(context.Background())
	if err := env.svc.RequestPasswordReset(ctx, "guest@example.com"); err != nil {
		t.Fatalf("RequestPasswordReset = %v", err)
	}
	if len(env.mailer.sent) != 0 || len(queued) != 1 {
		t.Fatalf("work ran inline (mails=%d, queued=%d)", len(env.mailer.sent), len(queued))
	}
	cancel() // the request is over before the work runs
	queued[0]()
	if workCtxErr != nil || !hasDeadline {
		t.Fatalf("detached work ctx err=%v deadline=%v, want live and bounded", workCtxErr, hasDeadline)
	}
	if len(env.mailer.sent) != 1 {
		t.Fatalf("mails sent = %d, want 1", len(env.mailer.sent))
	}
}

type ctxProbeResetStore struct {
	*mockResetStore
	probe func(context.Context)
}

func (p *ctxProbeResetStore) MintPasswordResetTicket(ctx context.Context, tokenHash, userID string, ttl time.Duration) error {
	p.probe(ctx)
	return p.mockResetStore.MintPasswordResetTicket(ctx, tokenHash, userID, ttl)
}
