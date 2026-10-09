// Notification presentation: titles, display names, body previews and
// attachment summaries — how an alert reads, never whether it fires.
// Split out of notification.go (2026-08-12).

package service

import (
	"context"
	"strings"

	"github.com/DigitalTolk/ex/internal/model"
)

// parentDisplayName resolves a human-readable name for the parent (channel
// or conversation) used in notification titles. Returns an empty string on
// error — title formatting handles that.
func (s *NotificationService) parentDisplayName(ctx context.Context, parentID, parentType string) string {
	switch parentType {
	case ParentChannel:
		if s.channels == nil {
			return parentID
		}
		if s.nameCache != nil {
			if v, ok := s.nameCache.GetName(ctx, "chan:"+parentID); ok {
				return v
			}
		}
		ch, err := s.channels.GetChannel(ctx, parentID)
		if err != nil || ch == nil {
			return parentID
		}
		// Slug is what URLs use, but Name reads more naturally in titles.
		name := ch.Name
		if ch.Slug != "" {
			name = ch.Slug
		}
		if s.nameCache != nil {
			s.nameCache.SetName(ctx, "chan:"+parentID, name)
		}
		return name
	case ParentConversation:
		// A group conversation has a name worth putting in the title; a 1:1
		// DM has none and the title says "a direct message" instead.
		if s.conv == nil {
			return ""
		}
		if s.nameCache != nil {
			if v, ok := s.nameCache.GetName(ctx, "conv:"+parentID); ok {
				return v
			}
		}
		c, err := s.conv.GetConversation(ctx, parentID)
		if err != nil || c == nil {
			return ""
		}
		if s.nameCache != nil {
			s.nameCache.SetName(ctx, "conv:"+parentID, c.Name)
		}
		return c.Name
	}
	return ""
}

// parentLabel is how a title names where something happened: "~slug" for a
// channel, the group's name for a named conversation, and "" for a 1:1 DM.
func parentLabel(parentType, parentName string) string {
	if parentType == ParentChannel {
		return "~" + parentName
	}
	return parentName
}

func (s *NotificationService) userDisplayName(ctx context.Context, userID string) string {
	if s.users == nil {
		return userID
	}
	if s.nameCache != nil {
		if v, ok := s.nameCache.GetName(ctx, "user:"+userID); ok {
			return v
		}
	}
	u, err := s.users.GetUser(ctx, userID)
	if err != nil || u == nil {
		return userID
	}
	name := u.DisplayName
	if name == "" {
		name = u.Email
	}
	if s.nameCache != nil {
		s.nameCache.SetName(ctx, "user:"+userID, name)
	}
	return name
}

// titleFor and bodyFor lay a notification out the way Mattermost does, so a
// banner reads the same in both apps: the TITLE is where it happened — "~slug"
// for a channel, the group's name, or the sender for a 1:1 DM — prefixed with
// "Reply in" for a thread reply; the BODY is "who: what" (just "what" in a DM,
// whose title already names the sender). No app name in front.
func titleFor(kind NotificationKind, parentType, parentName, authorName string) string {
	where := parentLabel(parentType, parentName)
	switch kind {
	case NotificationKindThreadReply:
		if where != "" {
			return "Reply in " + where
		}
		return "Reply from " + authorName
	case NotificationKindMessage, NotificationKindMention:
		if where != "" {
			return where
		}
		return authorName
	default:
		return authorName
	}
}

// Thread replies use the same shape as every other banner — WHERE on top,
// "who: what" below — with the thread, in its channel or group, as the place:
//
//	Thread in ~sandbox: <first words of the root…>
//	<name>: <the reply>
//
// A 1:1 DM has no place to name, so it is just "Thread: …". The root snippet
// is cut at a word boundary; the deep link opens the thread.
func threadReplyTitle(parentType, parentName, rootPreview string) string {
	const max = 48
	root := strings.TrimSpace(rootPreview)
	if runes := []rune(root); len(runes) > max {
		cut := string(runes[:max])
		if i := strings.LastIndex(cut, " "); i > max/2 {
			cut = cut[:i]
		}
		root = strings.TrimRight(cut, " ,.;:") + "…"
	}
	title := "Thread"
	if where := parentLabel(parentType, parentName); where != "" {
		title += " in " + where
	}
	if root == "" {
		return title
	}
	return title + ": " + root
}

func bodyFor(parentType, parentName, authorName, body string) string {
	if parentLabel(parentType, parentName) == "" {
		return body
	}
	if body == "" {
		return authorName
	}
	return authorName + ": " + body
}

// previewBody clamps a message body to a sane length for a notification
// preview and strips newlines so the OS-level popup renders on one line.
// Mentions in their wire form `@[userID|DisplayName]` are flattened to
// `@DisplayName` so the popup reads "Alice mentioned: hi @Bob" rather
// than "hi @[U-2|Bob]".
// notificationBody is the text used for a push/notification preview. It
// prefers the message body, but for an attachments-only message (e.g. an
// incoming webhook posting a rich attachment with no text) it falls back
// to the first attachment's fallback summary — the field Mattermost
// defines for exactly this purpose.
func notificationBody(msg *model.Message) string {
	if msg.Body != "" {
		return msg.Body
	}
	for _, a := range msg.MessageAttachments {
		if s := attachmentSummary(a); s != "" {
			return s
		}
	}
	return ""
}

// attachmentSummary produces the notification-preview text for a rich
// (webhook) attachment. `fallback` is the field Slack/Mattermost define for
// exactly this — a plain-text summary — so it wins when present. But many
// webhook senders omit it (CI/deploy bots that only set title/text/fields),
// which left the popup empty. So when there's no fallback we synthesize a
// readable summary from the visible fields, mirroring what the attachment
// renders, rather than show a near-empty notification.
func attachmentSummary(a model.MessageAttachment) string {
	if s := strings.TrimSpace(a.Fallback); s != "" {
		return s
	}
	var parts []string
	addPart := func(s string) {
		if s = strings.TrimSpace(s); s != "" {
			parts = append(parts, s)
		}
	}
	addPart(a.Pretext)
	addPart(a.Title)
	addPart(a.Text)
	for _, f := range a.Fields {
		title, value := strings.TrimSpace(f.Title), strings.TrimSpace(f.Value)
		switch {
		case title != "" && value != "":
			addPart(title + ": " + value)
		case value != "":
			addPart(value)
		default:
			addPart(title)
		}
	}
	if len(parts) > 0 {
		return strings.Join(parts, " — ")
	}
	// Last resort: chrome-only fields, so the popup still says *something*
	// rather than arriving blank.
	if s := strings.TrimSpace(a.Footer); s != "" {
		return s
	}
	return strings.TrimSpace(a.AuthorName)
}

func previewBody(body string) string {
	const max = 140
	body = userMentionPattern.ReplaceAllString(body, "@$2")
	body = channelMentionRE.ReplaceAllString(body, "~$2")
	body = renderEmojiShortcodes(body)
	body = strings.ReplaceAll(body, "\n", " ")
	// Rune-aware clamp: byte-slicing would split a multi-byte emoji glyph into
	// invalid UTF-8.
	if runes := []rune(body); len(runes) > max {
		return string(runes[:max-1]) + "…"
	}
	return body
}

// renderEmojiShortcodes replaces known emoji shortcodes with their unicode
// glyph so a popup shows 😄 rather than ":smile:". The toned form is handled
// first so the bare matcher can't eat part of it; a toned shortcode renders as
// the base glyph (the skin-tone modifier is dropped in the flat preview).
// Unknown/custom shortcodes pass through unchanged — there is no glyph to show.
func renderEmojiShortcodes(body string) string {
	body = emojiTonedRE.ReplaceAllStringFunc(body, func(s string) string {
		m := emojiTonedRE.FindStringSubmatch(s)
		if g, ok := emojiShortcodeToUnicode[strings.ToLower(m[1])]; ok {
			return g
		}
		return s
	})
	return emojiBareRE.ReplaceAllStringFunc(body, func(s string) string {
		m := emojiBareRE.FindStringSubmatch(s)
		if g, ok := emojiShortcodeToUnicode[strings.ToLower(m[1])]; ok {
			return g
		}
		return s
	})
}
