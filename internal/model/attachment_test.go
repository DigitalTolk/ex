package model

import "testing"

// TestAttachment_IsImage covers the MIME prefix check used by the message
// renderer to decide between an inline thumbnail and a generic file chip.
func TestAttachment_IsImage(t *testing.T) {
	cases := []struct {
		name        string
		contentType string
		want        bool
	}{
		{"png is image", "image/png", true},
		{"jpeg is image", "image/jpeg", true},
		{"gif is image", "image/gif", true},
		{"svg is image", "image/svg+xml", true},
		{"webp is image", "image/webp", true},
		{"avif is image", "image/avif", true},
		{"video is not image", "video/mp4", false},
		{"audio is not image", "audio/mpeg", false},
		{"pdf is not image", "application/pdf", false},
		{"text is not image", "text/plain", false},
		{"empty content type is not image", "", false},
		{"too short to be image/", "image", false},
		{"prefix-similar but wrong", "imager/png", false}, // 6th char != "/"
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := &Attachment{ContentType: tc.contentType}
			if got := a.IsImage(); got != tc.want {
				t.Errorf("IsImage() with ContentType=%q = %v, want %v", tc.contentType, got, tc.want)
			}
		})
	}
}

// TestAttachment_IsImage_Nil verifies the nil-receiver guard so callers
// don't have to nil-check before asking. The message renderer relies on
// this when an attachment lookup misses.
func TestAttachment_IsImage_Nil(t *testing.T) {
	var a *Attachment
	if a.IsImage() {
		t.Error("nil attachment should not report as image")
	}
}
