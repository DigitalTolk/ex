package service

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/DigitalTolk/ex/internal/model"
)

// Mention pills carry an ID and the name/slug the poster typed next to it
// (`@[userID|Alice]`, `~[channelID|general]`). Only the ID is trustworthy:
// left as typed, "@[bobID|Alice]" reads "@Alice" while notifying Bob. So the
// rendered tree is rewritten with each ID's CURRENT display name / slug —
// which also keeps old messages right across renames — and a mention whose
// ID resolves to nothing degrades to the plain text that was typed.

// MentionNames maps mention IDs to what their pill shows.
type MentionNames struct {
	Users      map[string]string // user ID → current display name
	Channels   map[string]string // channel ID → current slug
	UserGroups map[string]string // enabled user-group ID → current handle
}

// MentionResolver looks up, in one batched call, every user and channel a
// batch of rendered messages mentions. Implemented by MentionDirectory.
type MentionResolver interface {
	ResolveMentions(ctx context.Context, userIDs, channelIDs []string) (MentionNames, error)
}

// UserGroupNameResolver resolves user-group mention IDs to the current
// handle of each ENABLED group; a disabled or unknown group is absent, so
// its mention renders as plain text. MentionDirectory implements it once
// SetUserGroups wires a source.
type UserGroupNameResolver interface {
	ResolveUserGroups(ctx context.Context, ids []string) (map[string]string, error)
}

// SetMentionResolver wires mention-pill resolution into every rendered
// message. Left unset (tests that don't care), pills keep the typed names.
func (s *MessageService) SetMentionResolver(r MentionResolver) { s.mentions = r }

// resolveMentionPills rewrites the mention pills of a rendered batch in
// place: one lookup for the whole batch, none when it mentions nobody. A
// failed lookup renders every mention as plain text rather than as a pill
// with an unverified name.
func (s *MessageService) resolveMentionPills(ctx context.Context, trees []*HastNode) {
	if s.mentions == nil {
		return
	}
	userIDs, channelIDs := mentionIDs(trees)
	groupIDs := mentionUserGroupIDs(trees)
	if len(userIDs) == 0 && len(channelIDs) == 0 && len(groupIDs) == 0 {
		return
	}
	names := MentionNames{}
	if len(userIDs) > 0 || len(channelIDs) > 0 {
		resolved, err := s.mentions.ResolveMentions(ctx, userIDs, channelIDs)
		if err != nil {
			slog.WarnContext(ctx, "message: resolve mention pills failed; rendering them as plain text", "error", err)
		} else {
			names = resolved
		}
	}
	names.UserGroups = resolvePillUserGroups(ctx, s.mentions, groupIDs)
	for _, t := range trees {
		applyMentionNames(t, names)
	}
}

// mentionIDs lists the distinct, non-blank user and channel IDs mentioned
// anywhere in trees, in the order they first appear.
func mentionIDs(trees []*HastNode) (userIDs, channelIDs []string) {
	seen := map[string]bool{}
	add := func(list *[]string, kind, id string) {
		if id == "" || seen[kind+id] {
			return
		}
		seen[kind+id] = true
		*list = append(*list, id)
	}
	var walk func(n *HastNode)
	walk = func(n *HastNode) {
		for _, c := range n.Children {
			switch c.TagName {
			case "ex-mention-user":
				add(&userIDs, "u", propString(c, "data-user-id"))
			case "ex-mention-channel":
				add(&channelIDs, "c", propString(c, "data-channel-id"))
			default:
				walk(c)
			}
		}
	}
	for _, t := range trees {
		walk(t)
	}
	return userIDs, channelIDs
}

// mentionUserGroupIDs lists the distinct user-group IDs mentioned anywhere
// in trees, in the order they first appear.
func mentionUserGroupIDs(trees []*HastNode) []string {
	var ids []string
	seen := map[string]bool{}
	var walk func(n *HastNode)
	walk = func(n *HastNode) {
		for _, c := range n.Children {
			if c.TagName != "ex-mention-usergroup" {
				walk(c)
				continue
			}
			if id := propString(c, "data-usergroup-id"); id != "" && !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
	}
	for _, t := range trees {
		walk(t)
	}
	return ids
}

// resolvePillUserGroups returns the current handle of every enabled group
// in ids. A resolver that can't resolve groups, or a failed lookup, returns
// none, so every group pill renders as plain text rather than pinging-looking
// pills for a group nobody verified.
func resolvePillUserGroups(ctx context.Context, r MentionResolver, ids []string) map[string]string {
	gr, ok := r.(UserGroupNameResolver)
	if !ok || len(ids) == 0 {
		return nil
	}
	handles, err := gr.ResolveUserGroups(ctx, ids)
	if err != nil {
		slog.WarnContext(ctx, "message: resolve user-group pills failed; rendering them as plain text", "error", err)
		return nil
	}
	return handles
}

// applyMentionNames patches n's subtree: known IDs get their current name,
// unknown ones become text, merged into the neighbouring text runs.
func applyMentionNames(n *HastNode, names MentionNames) {
	replaced := false
	for i, c := range n.Children {
		switch c.TagName {
		case "ex-mention-user":
			id := propString(c, "data-user-id")
			if name, ok := names.Users[id]; ok {
				c.Properties["data-name"] = name
				c.Properties["data-value"] = "@[" + id + "|" + name + "]"
				continue
			}
			n.Children[i] = textNode("@" + propString(c, "data-name"))
			replaced = true
		case "ex-mention-usergroup":
			id := propString(c, "data-usergroup-id")
			if handle, ok := names.UserGroups[id]; ok {
				c.Properties["data-handle"] = handle
				c.Properties["data-value"] = "@[" + id + "|" + handle + "]"
				continue
			}
			n.Children[i] = textNode("@" + propString(c, "data-handle"))
			replaced = true
		case "ex-mention-channel":
			id := propString(c, "data-channel-id")
			if slug, ok := names.Channels[id]; ok {
				c.Properties["data-slug"] = slug
				c.Properties["data-value"] = "~[" + id + "|" + slug + "]"
				continue
			}
			n.Children[i] = textNode("~" + propString(c, "data-slug"))
			replaced = true
		default:
			applyMentionNames(c, names)
		}
	}
	if replaced {
		n.Children = mergeTextRuns(n.Children)
	}
}

// mergeTextRuns joins adjacent text nodes, as appendTextChild keeps them.
func mergeTextRuns(kids []*HastNode) []*HastNode {
	out := make([]*HastNode, 0, len(kids))
	for _, k := range kids {
		if last := len(out) - 1; last >= 0 && k.Type == "text" && out[last].Type == "text" {
			out[last] = textNode(out[last].Value + k.Value)
			continue
		}
		out = append(out, k)
	}
	return out
}

// propString reads a string property of a custom ex-* element; the
// extractor only ever stores strings under the mention keys.
func propString(n *HastNode, key string) string {
	v, _ := n.Properties[key].(string)
	return v
}

// mentionUserSource is the cached batched user read (UserService.GetBatch).
type mentionUserSource interface {
	GetBatch(ctx context.Context, ids []string) ([]*model.User, error)
}

// MentionDirectory resolves mention IDs: users through the cache-first
// batched user read, channels through one BatchGetItem of their META rows.
type MentionDirectory struct {
	users      mentionUserSource
	channels   batchChannelStore
	userGroups mentionUserGroupSource
}

// mentionUserGroupSource is the cached user-group read (UserGroupService).
type mentionUserGroupSource interface {
	EnabledHandles(ctx context.Context, ids []string) (map[string]string, error)
}

// SetUserGroups lets the directory resolve user-group pills.
func (d *MentionDirectory) SetUserGroups(src mentionUserGroupSource) { d.userGroups = src }

// ResolveUserGroups returns the current handle of every enabled group in
// ids. With no source wired, it resolves none.
func (d *MentionDirectory) ResolveUserGroups(ctx context.Context, ids []string) (map[string]string, error) {
	if d.userGroups == nil || len(ids) == 0 {
		return map[string]string{}, nil
	}
	handles, err := d.userGroups.EnabledHandles(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("mention: get user groups: %w", err)
	}
	return handles, nil
}

// NewMentionDirectory builds the production MentionResolver.
func NewMentionDirectory(users mentionUserSource, channels batchChannelStore) *MentionDirectory {
	return &MentionDirectory{users: users, channels: channels}
}

// ResolveMentions returns the current display name of every user and slug of
// every channel that exists. An ID that resolves to nothing (or to a blank
// name) is simply absent, so its mention renders as text.
func (d *MentionDirectory) ResolveMentions(ctx context.Context, userIDs, channelIDs []string) (MentionNames, error) {
	out := MentionNames{Users: map[string]string{}, Channels: map[string]string{}}
	if len(userIDs) > 0 {
		users, err := d.users.GetBatch(ctx, userIDs)
		if err != nil {
			return MentionNames{}, fmt.Errorf("mention: get users: %w", err)
		}
		for _, u := range users {
			if u.DisplayName != "" {
				out.Users[u.ID] = u.DisplayName
			}
		}
	}
	if len(channelIDs) > 0 {
		channels, err := d.channels.GetChannelsByIDs(ctx, channelIDs)
		if err != nil {
			return MentionNames{}, fmt.Errorf("mention: get channels: %w", err)
		}
		for _, ch := range channels {
			if ch.Slug != "" {
				out.Channels[ch.ID] = ch.Slug
			}
		}
	}
	return out, nil
}

// hasMentions reports whether a tree holds any mention pill.
func hasMentions(n *HastNode) bool {
	trees := []*HastNode{n}
	userIDs, channelIDs := mentionIDs(trees)
	return len(userIDs) > 0 || len(channelIDs) > 0 || len(mentionUserGroupIDs(trees)) > 0
}

// cloneHast deep-copies a tree (nodes, children and property maps), so the
// copy can be patched without touching the original.
func cloneHast(n *HastNode) *HastNode {
	c := *n
	if n.Properties != nil {
		c.Properties = make(map[string]interface{}, len(n.Properties))
		for k, v := range n.Properties {
			c.Properties[k] = v
		}
	}
	if n.Children != nil {
		c.Children = make([]*HastNode, len(n.Children))
		for i, child := range n.Children {
			c.Children[i] = cloneHast(child)
		}
	}
	return &c
}
