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
	Users    map[string]string // user ID → current display name
	Channels map[string]string // channel ID → current slug
}

// MentionResolver looks up, in one batched call, every user and channel a
// batch of rendered messages mentions. Implemented by MentionDirectory.
type MentionResolver interface {
	ResolveMentions(ctx context.Context, userIDs, channelIDs []string) (MentionNames, error)
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
	if len(userIDs) == 0 && len(channelIDs) == 0 {
		return
	}
	names, err := s.mentions.ResolveMentions(ctx, userIDs, channelIDs)
	if err != nil {
		slog.WarnContext(ctx, "message: resolve mention pills failed; rendering them as plain text", "error", err)
		names = MentionNames{}
	}
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
	users    mentionUserSource
	channels batchChannelStore
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
	userIDs, channelIDs := mentionIDs([]*HastNode{n})
	return len(userIDs) > 0 || len(channelIDs) > 0
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
