package service

import (
	"errors"
	"strings"
	"testing"
)

func TestValidateMessageBody_CodepointCounting(t *testing.T) {
	// Codepoint cap, not byte cap. 4096 ASCII chars = 4096 codepoints
	// = 4096 bytes — fits. 4096 multibyte chars = 4096 codepoints —
	// also fits, even though byte length is 4×.
	if err := ValidateMessageBody(strings.Repeat("a", MaxMessageBodyChars)); err != nil {
		t.Errorf("4096 ASCII chars rejected: %v", err)
	}
	if err := ValidateMessageBody(strings.Repeat("é", MaxMessageBodyChars)); err != nil {
		t.Errorf("4096 multibyte chars rejected: %v", err)
	}
	if err := ValidateMessageBody(strings.Repeat("a", MaxMessageBodyChars+1)); !errors.Is(err, ErrMessageTooLong) {
		t.Errorf("over-cap accepted: %v", err)
	}
}

func TestValidateAttachmentCount(t *testing.T) {
	if err := ValidateAttachmentCount(MaxAttachmentsPerMessage); err != nil {
		t.Errorf("at-cap rejected: %v", err)
	}
	if err := ValidateAttachmentCount(MaxAttachmentsPerMessage + 1); !errors.Is(err, ErrTooManyAttachments) {
		t.Errorf("over-cap accepted: %v", err)
	}
}

func TestValidateChannelName_AcceptsSlugForms(t *testing.T) {
	for _, name := range []string{"general", "team-1", "engineering", "a", "feat-123"} {
		if err := ValidateChannelName(name); err != nil {
			t.Errorf("rejected valid slug %q: %v", name, err)
		}
	}
}

func TestValidateChannelName_RejectsSpecialCharsAndCasing(t *testing.T) {
	cases := []string{
		"General",        // uppercase
		"hello world",    // space
		"hi!",            // punctuation
		"-leading",       // leading hyphen
		"trailing-",      // trailing hyphen
		"double--hyphen", // repeated hyphen
		"emoji-🚀",        // non-ASCII
	}
	for _, name := range cases {
		if err := ValidateChannelName(name); !errors.Is(err, ErrChannelNameInvalid) {
			t.Errorf("accepted invalid name %q: %v", name, err)
		}
	}
}

func TestValidateChannelName_RejectsOverLength(t *testing.T) {
	long := strings.Repeat("a", MaxChannelNameLen+1)
	if err := ValidateChannelName(long); !errors.Is(err, ErrChannelNameTooLong) {
		t.Errorf("33-char name accepted: %v", err)
	}
	atCap := strings.Repeat("a", MaxChannelNameLen)
	if err := ValidateChannelName(atCap); err != nil {
		t.Errorf("32-char name rejected: %v", err)
	}
}

func TestValidateChannelDescription(t *testing.T) {
	if err := ValidateChannelDescription(strings.Repeat("a", MaxChannelDescriptionLen)); err != nil {
		t.Errorf("at-cap description rejected: %v", err)
	}
	if err := ValidateChannelDescription(strings.Repeat("a", MaxChannelDescriptionLen+1)); !errors.Is(err, ErrChannelDescriptionTooLong) {
		t.Errorf("over-cap description accepted: %v", err)
	}
	// Empty description is allowed (optional field).
	if err := ValidateChannelDescription(""); err != nil {
		t.Errorf("empty description rejected: %v", err)
	}
}
