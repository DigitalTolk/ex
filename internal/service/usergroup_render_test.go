package service

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// fakeGroupMentionResolver resolves users/channels like fakeMentionResolver
// and user groups through ResolveUserGroups.
type fakeGroupMentionResolver struct {
	fakeMentionResolver
	handles   map[string]string
	groupErr  error
	gotGroups []string
}

func (f *fakeGroupMentionResolver) ResolveUserGroups(_ context.Context, ids []string) (map[string]string, error) {
	f.gotGroups = append(f.gotGroups, ids...)
	return f.handles, f.groupErr
}

func TestServerRendererEmitsUserGroupPills(t *testing.T) {
	tree := NewMarkdownRenderer().RenderToHast("ping @[group-G1|oncall] and @[u-1|Ann]")
	group := findFirstByTag(tree, "ex-mention-usergroup")
	if group == nil || group.Properties["data-usergroup-id"] != "group-G1" || group.Properties["data-handle"] != "oncall" ||
		group.Properties["data-value"] != "@[group-G1|oncall]" {
		t.Fatalf("group pill = %+v", group)
	}
	if user := findFirstByTag(tree, "ex-mention-user"); user == nil || user.Properties["data-user-id"] != "u-1" {
		t.Fatalf("user pill = %+v", user)
	}
}

func TestRenderedUserGroupPillsShowTheCurrentHandle(t *testing.T) {
	r := &fakeGroupMentionResolver{handles: map[string]string{"group-G1": "on-call"}}
	svc := mentionService(r)
	msg := &model.Message{ID: "m-1", Body: "ping @[group-G1|oncall] and @[group-OFF|old]"}
	svc.attachRendered(context.Background(), msg)

	pill := findFirstByTag(msg.Rendered, "ex-mention-usergroup")
	if pill == nil || pill.Properties["data-handle"] != "on-call" || pill.Properties["data-value"] != "@[group-G1|on-call]" {
		t.Fatalf("group pill = %+v", pill)
	}
	// A disabled or unknown group reads as plain text.
	if p := findFirstByTag(msg.Rendered, "p"); p == nil || !hastContainsText(p, "@old") {
		t.Fatalf("disabled group not flattened to text: %+v", p)
	}
	if !reflect.DeepEqual(r.gotGroups, []string{"group-G1", "group-OFF"}) {
		t.Errorf("resolved groups = %v", r.gotGroups)
	}
	if r.calls != 0 {
		t.Errorf("user/channel lookup ran %d times for a message mentioning only groups", r.calls)
	}
}

func TestRenderedUserGroupPillsWithoutAGroupResolverBecomeText(t *testing.T) {
	// A resolver that can't resolve groups: no group pill is verified.
	svc := mentionService(&fakeMentionResolver{names: bobAndGeneral})
	msg := &model.Message{ID: "m-1", Body: "@[u-bob|Bob] and @[group-G1|oncall]"}
	svc.attachRendered(context.Background(), msg)
	if el := findFirstByTag(msg.Rendered, "ex-mention-usergroup"); el != nil {
		t.Fatalf("unverified group pill kept: %+v", el)
	}
	if el := findFirstByTag(msg.Rendered, "ex-mention-user"); el == nil {
		t.Fatal("the user pill should still resolve")
	}
}

func TestRenderedUserGroupPillsOnLookupErrorBecomeText(t *testing.T) {
	r := &fakeGroupMentionResolver{groupErr: errors.New("down")}
	r.err = errors.New("users down too")
	svc := mentionService(r)
	msg := &model.Message{ID: "m-1", Body: "@[u-bob|Bob] @[group-G1|oncall]"}
	svc.attachRendered(context.Background(), msg)
	if findFirstByTag(msg.Rendered, "ex-mention-usergroup") != nil || findFirstByTag(msg.Rendered, "ex-mention-user") != nil {
		t.Fatalf("pills kept after failed lookups: %+v", msg.Rendered)
	}
}

func TestMentionDirectoryResolvesUserGroups(t *testing.T) {
	d := NewMentionDirectory(&fakeMentionUsers{}, &fakeMentionChannels{})
	if got, err := d.ResolveUserGroups(context.Background(), []string{"group-G1"}); err != nil || len(got) != 0 {
		t.Fatalf("unwired ResolveUserGroups = %v, %v; want nothing", got, err)
	}
	f := newUserGroupFixture()
	g := f.create(t, "oncall")
	d.SetUserGroups(f.svc)
	got, err := d.ResolveUserGroups(context.Background(), []string{g.ID, "group-unknown"})
	if err != nil || !reflect.DeepEqual(got, map[string]string{g.ID: "oncall"}) {
		t.Fatalf("ResolveUserGroups = %v, %v", got, err)
	}
	if got, err := d.ResolveUserGroups(context.Background(), nil); err != nil || len(got) != 0 {
		t.Fatalf("ResolveUserGroups(nil) = %v, %v", got, err)
	}
	f.copies.drop() // not in the shared copy: read from the store
	f.store.batchErr = errors.New("boom")
	if _, err := d.ResolveUserGroups(context.Background(), []string{g.ID}); err == nil {
		t.Fatal("ResolveUserGroups swallowed a lookup error")
	}
}

func TestHasMentionsCountsUserGroups(t *testing.T) {
	tree := NewMarkdownRenderer().RenderToHast("only @[group-G1|oncall]")
	if !hasMentions(tree) {
		t.Fatal("a tree holding only a group pill reads as mention-free: its pill would never be verified")
	}
}

func TestFlattenMentionsShowsCurrentGroupHandles(t *testing.T) {
	names := MentionNames{UserGroups: map[string]string{"group-G1": "on-call"}}
	got := flattenMentions("@[group-G1|oncall] and @[group-OFF|old]", names)
	if want := "@on-call and @old"; got != want {
		t.Fatalf("flattenMentions = %q, want %q", got, want)
	}
	users, _ := textMentionIDs("@[group-G1|oncall] @[u-1|Ann]")
	if !reflect.DeepEqual(users, []string{"u-1"}) {
		t.Fatalf("user ids = %v, want the group left out of the user lookup", users)
	}
	if ids := textUserGroupIDs("@[group-G1|a] @[group-G1|b]", "@[group-G2|c] @[u-1|x]"); !reflect.DeepEqual(ids, []string{"group-G1", "group-G2"}) {
		t.Fatalf("group ids = %v", ids)
	}
}

func TestLookupMentionNamesResolvesGroupHandles(t *testing.T) {
	ctx := context.Background()
	r := &fakeGroupMentionResolver{handles: map[string]string{"group-G1": "oncall"}}
	r.names = MentionNames{Users: map[string]string{"u-1": "Ann"}}
	names := lookupMentionNames(ctx, r, "@[u-1|x] @[group-G1|y]")
	if names.Users["u-1"] != "Ann" || names.UserGroups["group-G1"] != "oncall" {
		t.Fatalf("names = %+v", names)
	}

	// Only groups: no user/channel lookup.
	only := &fakeGroupMentionResolver{handles: map[string]string{"group-G1": "oncall"}}
	if names := lookupMentionNames(ctx, only, "@[group-G1|y]"); names.UserGroups["group-G1"] != "oncall" || only.calls != 0 {
		t.Fatalf("group-only names = %+v (user lookups %d)", names, only.calls)
	}

	// A failed group lookup keeps the user names; a resolver without group
	// support resolves none.
	failing := &fakeGroupMentionResolver{groupErr: errors.New("down")}
	failing.names = MentionNames{Users: map[string]string{"u-1": "Ann"}}
	if names := lookupMentionNames(ctx, failing, "@[u-1|x] @[group-G1|y]"); names.Users["u-1"] != "Ann" || names.UserGroups != nil {
		t.Fatalf("names after a group failure = %+v", names)
	}
	plain := &fakeMentionResolver{names: MentionNames{Users: map[string]string{"u-1": "Ann"}}}
	if names := lookupMentionNames(ctx, plain, "@[u-1|x] @[group-G1|y]"); names.UserGroups != nil {
		t.Fatalf("plain resolver names = %+v", names)
	}

	// A failed user lookup reads everything as typed.
	userFail := &fakeGroupMentionResolver{handles: map[string]string{"group-G1": "oncall"}}
	userFail.err = errors.New("down")
	if names := lookupMentionNames(ctx, userFail, "@[u-1|x] @[group-G1|y]"); names.Users != nil || names.UserGroups != nil {
		t.Fatalf("names after a user failure = %+v", names)
	}
}

// hastContainsText reports whether any text node under n contains s.
func hastContainsText(n *HastNode, s string) bool {
	if n.Type == "text" && strings.Contains(n.Value, s) {
		return true
	}
	for _, c := range n.Children {
		if hastContainsText(c, s) {
			return true
		}
	}
	return false
}
