//go:build integration

package service

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/redisx"
	"github.com/redis/go-redis/v9"
)

func newAudienceRedis(t *testing.T) *redis.Client {
	t.Helper()
	if !serviceRedisReady {
		t.Skip("skipping: Docker / Redis not available")
	}
	opts, err := redisx.Options("redis://" + serviceRedisAddr)
	if err != nil {
		t.Fatalf("redis options: %v", err)
	}
	rdb := redis.NewClient(opts)
	t.Cleanup(func() { _ = rdb.Close() })
	if err := rdb.FlushDB(context.Background()).Err(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	return rdb
}

// instance is one backend process: its own in-process audience cache and
// notifier, sharing the stores (DynamoDB) and Redis with the others.
type instance struct {
	notifier *NotificationService
	pub      *mockPublisher
	channels *ChannelService
	users    *UserService
}

func newInstance(rdb *redis.Client, members *mockMembershipStore, users *mockUserStore, chans *mockChannelStore) *instance {
	cache := NewAudienceCache(NewRedisAudienceGenerations(rdb))
	pub := newMockPublisher()
	n := NewNotificationService(pub, members, newMockConversationStore(), chans, users, newMockMessageStore())
	n.SetAudienceCache(cache)
	cs := NewChannelService(chans, members, users, nil, newMockCache(), newMockBroker(), pub)
	cs.SetAudienceInvalidator(cache)
	us := NewUserService(users, newMockCache(), nil, pub)
	us.SetAudienceInvalidator(cache)
	return &instance{notifier: n, pub: pub, channels: cs, users: us}
}

func (in *instance) alerts(t *testing.T, id string) map[string]bool {
	t.Helper()
	in.pub.mu.Lock()
	in.pub.published = nil
	in.pub.mu.Unlock()
	in.notifier.NotifyForMessage(context.Background(), &model.Message{ID: id, ParentID: "ch1", AuthorID: "sender", Body: "deploy finished"}, ParentChannel, nil)
	return alertedUsers(in.pub)
}

func twoInstances(t *testing.T) (*instance, *instance, *mockMembershipStore, *mockUserStore) {
	t.Helper()
	rdb := newAudienceRedis(t)
	members := newMockMembershipStore()
	users := newMockUserStore()
	chans := newMockChannelStore()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "ops", Slug: "ops", Type: model.ChannelTypePublic}
	seedAllLevel(users, "admin", "stays", "leaves")
	users.users["admin"].SystemRole = model.SystemRoleAdmin
	for _, uid := range []string{"admin", "stays", "leaves"} {
		role := model.ChannelRoleMember
		if uid == "admin" {
			role = model.ChannelRoleAdmin
		}
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid, Role: role}
	}
	return newInstance(rdb, members, users, chans), newInstance(rdb, members, users, chans), members, users
}

// The audience-cache contract across instances: B has the channel cached;
// membership changes made through A must be seen by B's very next fan-out — a
// removed member is never alerted, a newly joined one always is.
func TestAudienceCache_TwoInstances_MembershipChanges(t *testing.T) {
	a, b, _, users := twoInstances(t)
	ctx := context.Background()

	if got := b.alerts(t, "m1"); !got["stays"] || !got["leaves"] {
		t.Fatalf("warm-up alerted %v, want stays+leaves", got)
	}

	if err := a.channels.RemoveMember(ctx, "admin", "ch1", "leaves"); err != nil {
		t.Fatalf("RemoveMember: %v", err)
	}
	if got := b.alerts(t, "m2"); got["leaves"] || !got["stays"] {
		t.Fatalf("after removal B alerted %v — a removed member must never be notified", got)
	}

	seedAllLevel(users, "joins")
	if err := a.channels.Join(ctx, "joins", "ch1"); err != nil {
		t.Fatalf("Join: %v", err)
	}
	if got := b.alerts(t, "m3"); !got["joins"] {
		t.Fatalf("after the join B alerted %v — a newly joined member must always be notified", got)
	}

	seedAllLevel(users, "invited")
	if err := a.channels.AddMember(ctx, "admin", "ch1", "invited", model.ChannelRoleMember); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	if err := a.channels.Leave(ctx, "joins", "ch1"); err != nil {
		t.Fatalf("Leave: %v", err)
	}
	if got := b.alerts(t, "m4"); !got["invited"] || got["joins"] {
		t.Fatalf("after add+leave B alerted %v, want invited and not joins", got)
	}

	// Muting through A silences them on B.
	if err := a.channels.SetMute(ctx, "stays", "ch1", true); err != nil {
		t.Fatalf("SetMute: %v", err)
	}
	if got := b.alerts(t, "m5"); got["stays"] {
		t.Fatalf("after the mute B alerted %v", got)
	}
}

// Account-level settings (levels, keywords) changed through A are used by B.
func TestAudienceCache_TwoInstances_SettingsChanges(t *testing.T) {
	a, b, _, _ := twoInstances(t)
	ctx := context.Background()

	if got := b.alerts(t, "m1"); !got["stays"] {
		t.Fatalf("warm-up alerted %v, want stays", got)
	}
	// "stays" drops to mentions + keywords, with the keyword "deploy".
	if _, err := a.users.SetNotificationSettings(ctx, "stays", model.NotificationSettings{
		DesktopLevel: model.NotificationLevelMentions, MobileLevel: model.MobileNotificationDefault, Keywords: []string{"rollback"},
	}); err != nil {
		t.Fatalf("SetNotificationSettings: %v", err)
	}
	if got := b.alerts(t, "m2"); got["stays"] {
		t.Fatalf("after dropping to mentions B alerted %v", got)
	}
	if _, err := a.users.SetNotificationSettings(ctx, "stays", model.NotificationSettings{
		DesktopLevel: model.NotificationLevelMentions, MobileLevel: model.MobileNotificationDefault, Keywords: []string{"deploy"},
	}); err != nil {
		t.Fatalf("SetNotificationSettings: %v", err)
	}
	if got := b.alerts(t, "m3"); !got["stays"] {
		t.Fatalf("after adding the keyword B alerted %v — the keyword alert was missed", got)
	}
}

func TestRedisAudienceGenerations(t *testing.T) {
	rdb := newAudienceRedis(t)
	ctx := context.Background()
	g := NewRedisAudienceGenerations(rdb)

	first, err := g.Generations(ctx, []string{"audgen:ch:x", "audgen:u:y"})
	if err != nil || first[0] == "" || first[1] == "" {
		t.Fatalf("seed = %v, %v", first, err)
	}
	again, err := g.Generations(ctx, []string{"audgen:ch:x", "audgen:u:y"})
	if err != nil || again[0] != first[0] || again[1] != first[1] {
		t.Fatalf("generations moved without a bump: %v → %v (%v)", first, again, err)
	}
	if ttl := rdb.TTL(ctx, "audgen:ch:x").Val(); ttl <= 0 {
		t.Fatalf("seeded key TTL = %v, want a bounded TTL", ttl)
	}
	if err := g.Bump(ctx, "audgen:ch:x"); err != nil {
		t.Fatalf("Bump: %v", err)
	}
	bumped, _ := g.Generations(ctx, []string{"audgen:ch:x", "audgen:u:y"})
	if bumped[0] == first[0] || bumped[1] != first[1] {
		t.Fatalf("after bumping x: %v → %v, want only x moved", first, bumped)
	}

	// A key lost (Redis restart, eviction) comes back with a value no cache
	// entry carries, rather than restarting at a predictable one.
	if err := rdb.Del(ctx, "audgen:ch:x").Err(); err != nil {
		t.Fatalf("del: %v", err)
	}
	reseeded, _ := g.Generations(ctx, []string{"audgen:ch:x"})
	if reseeded[0] == bumped[0] || reseeded[0] == first[0] {
		t.Fatalf("a lost key re-seeded to a previous value %q", reseeded[0])
	}
}

// failCmds fails the named commands (pipelined or not) on a real client.
type failCmds struct{ names map[string]bool }

func (f failCmds) DialHook(next redis.DialHook) redis.DialHook { return next }
func (f failCmds) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		if f.names[strings.ToLower(cmd.Name())] {
			return errors.New("injected " + cmd.Name() + " failure")
		}
		return next(ctx, cmd)
	}
}
func (f failCmds) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []redis.Cmder) error {
		for _, c := range cmds {
			if f.names[strings.ToLower(c.Name())] {
				return errors.New("injected " + c.Name() + " failure")
			}
		}
		return next(ctx, cmds)
	}
}

func TestRedisAudienceGenerations_Failures(t *testing.T) {
	ctx := context.Background()
	rdb := newAudienceRedis(t)

	mgetFails := redis.NewClient(rdb.Options())
	t.Cleanup(func() { _ = mgetFails.Close() })
	mgetFails.AddHook(failCmds{names: map[string]bool{"mget": true}})
	if _, err := NewRedisAudienceGenerations(mgetFails).Generations(ctx, []string{"k"}); err == nil {
		t.Fatal("MGET failure not reported")
	}

	seedFails := redis.NewClient(rdb.Options())
	t.Cleanup(func() { _ = seedFails.Close() })
	seedFails.AddHook(failCmds{names: map[string]bool{"setnx": true, "set": true}})
	if _, err := NewRedisAudienceGenerations(seedFails).Generations(ctx, []string{"fresh-key"}); err == nil {
		t.Fatal("seed failure not reported")
	}

	// A closed port: bumps fail and are reported.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	dead := redis.NewClient(&redis.Options{Addr: addr, MaxRetries: -1})
	t.Cleanup(func() { _ = dead.Close() })
	if err := NewRedisAudienceGenerations(dead).Bump(ctx, "k"); err == nil {
		t.Fatal("bump against a dead Redis reported no error")
	}
}
