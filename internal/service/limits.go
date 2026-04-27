package service

import (
	"errors"
	"regexp"
	"unicode/utf8"
)

// Hard ceilings the API enforces. Mirrored on the frontend in
// frontend/src/lib/limits.ts — keep them in sync.
const (
	// MaxMessageBodyChars caps the message body in user-perceived
	// characters (Unicode codepoints). UTF-8 is variable-width, so a
	// byte cap would penalise non-Latin scripts; a codepoint cap is
	// fair and predictable for the user.
	MaxMessageBodyChars = 4096

	// MaxAttachmentsPerMessage caps how many attachments can be bound
	// to a single message at send time. Editing follows the same cap.
	MaxAttachmentsPerMessage = 10

	// MaxChannelNameLen / MaxChannelDescriptionLen / MaxDistinctReactions
	// guard the rest of the message-adjacent surface against abuse.
	MaxChannelNameLen        = 32
	MaxChannelDescriptionLen = 255
	MaxDistinctReactions     = 16
)

// channelNamePattern is the slug-style identifier we accept for channel
// names: lowercase ASCII letters, digits, hyphen. The first character
// must be a letter or digit, hyphens may not repeat or sit at the edges.
// Mirrored loosely on the frontend; the backend is authoritative.
var channelNamePattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// ErrMessageTooLong is returned by Send/Edit when the body exceeds
// MaxMessageBodyChars in codepoints.
var ErrMessageTooLong = errors.New("message: body exceeds maximum length")

// ErrTooManyAttachments is returned by Send/Edit when more attachment
// IDs are supplied than the cap allows.
var ErrTooManyAttachments = errors.New("message: too many attachments")

// ErrTooManyReactions is returned by ToggleReaction when adding the
// emoji would push the distinct-reactions count past the cap.
var ErrTooManyReactions = errors.New("message: too many distinct reactions")

// ErrChannelNameInvalid is returned when a channel name doesn't fit the
// slug pattern (lowercase letters, digits, hyphen — no special chars,
// no leading/trailing/repeated hyphens).
var ErrChannelNameInvalid = errors.New("channel: name must be lowercase letters, digits, and hyphens")

// ErrChannelNameTooLong is returned when the name is over MaxChannelNameLen.
var ErrChannelNameTooLong = errors.New("channel: name too long")

// ErrChannelDescriptionTooLong guards the description field.
var ErrChannelDescriptionTooLong = errors.New("channel: description too long")

// ValidateMessageBody enforces the codepoint cap. Empty bodies are
// allowed here — Send checks separately that body OR attachments exist.
func ValidateMessageBody(body string) error {
	if utf8.RuneCountInString(body) > MaxMessageBodyChars {
		return ErrMessageTooLong
	}
	return nil
}

// ValidateAttachmentCount enforces the per-message attachment cap.
func ValidateAttachmentCount(n int) error {
	if n > MaxAttachmentsPerMessage {
		return ErrTooManyAttachments
	}
	return nil
}

// ValidateChannelName enforces the slug-style pattern + length cap.
func ValidateChannelName(name string) error {
	if utf8.RuneCountInString(name) > MaxChannelNameLen {
		return ErrChannelNameTooLong
	}
	if !channelNamePattern.MatchString(name) {
		return ErrChannelNameInvalid
	}
	return nil
}

// ValidateChannelDescription caps the optional description by codepoints.
func ValidateChannelDescription(desc string) error {
	if utf8.RuneCountInString(desc) > MaxChannelDescriptionLen {
		return ErrChannelDescriptionTooLong
	}
	return nil
}
