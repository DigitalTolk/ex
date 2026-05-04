package handler

import "testing"

func TestAttachmentDisposition(t *testing.T) {
	tests := map[string]string{
		"":                     "attachment",
		"report.pdf":           `attachment; filename="report.pdf"`,
		"bad\r\nname\".svg":    `attachment; filename="bad__name_.svg"`,
		"emoji-\U0001F600.txt": `attachment; filename="emoji-_.txt"`,
	}
	for in, want := range tests {
		if got := attachmentDisposition(in); got != want {
			t.Fatalf("attachmentDisposition(%q) = %q, want %q", in, got, want)
		}
	}
}
