package bedrock

import (
	"context"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
)

func TestFormats(t *testing.T) {
	if f, ok := ImageFormat("image/JPEG; charset=x"); !ok || f != types.ImageFormatJpeg {
		t.Fatalf("jpeg: %v %v", f, ok)
	}
	if _, ok := ImageFormat("application/pdf"); ok {
		t.Fatal("pdf is not an image")
	}
	if f, ok := DocumentFormat("application/pdf", "x"); !ok || f != types.DocumentFormatPdf {
		t.Fatalf("pdf: %v %v", f, ok)
	}
	// A generic type falls back to the extension; an unknown one is refused.
	if f, ok := DocumentFormat("application/octet-stream", "Q3 Report.DOCX"); !ok || f != types.DocumentFormatDocx {
		t.Fatalf("docx by extension: %v %v", f, ok)
	}
	if _, ok := DocumentFormat("application/zip", "a.zip"); ok {
		t.Fatal("zip must be unsupported")
	}
	if !Supported("image/png", "") || !Supported("text/plain", "notes.txt") || Supported("video/mp4", "clip.mp4") {
		t.Fatal("Supported disagrees with the format tables")
	}
}

func TestDocumentName(t *testing.T) {
	cases := map[string]string{
		"Q3 report.pdf":           "Q3 report pdf",
		"  weird__name!!.md ":     "weird name md",
		"":                        "file",
		"***":                     "file",
		"ok-(1)[2]":               "ok-(1)[2]",
		strings.Repeat("a", 100):  strings.Repeat("a", maxDocNameLen),
		"été.txt":                 "t txt",
		"tabs\t\tand\n\nnewlines": "tabs and newlines",
	}
	for in, want := range cases {
		if got := DocumentName(in); got != want {
			t.Errorf("DocumentName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRun_AttachmentsRideTheFirstMessage(t *testing.T) {
	c := &fakeClient{outs: []*bedrockruntime.ConverseOutput{textOut(types.StopReasonEndTurn, "seen", 1, 1)}}
	_, _, err := Run(context.Background(), c, Config{
		ModelID: "anthropic.claude-x",
		Prompt:  "look at these",
		Attachments: []Attachment{
			{Name: "shot.png", ContentType: "image/png", Data: []byte("png")},
			{Name: "Spec.pdf", ContentType: "application/pdf", Data: []byte("pdf1")},
			{Name: "Spec.pdf", ContentType: "application/pdf", Data: []byte("pdf2")}, // same name: must stay unique
			{Name: "clip.mp4", ContentType: "video/mp4", Data: []byte("mp4")},        // unsupported: dropped
			{Name: "", ContentType: "text/plain", Data: []byte("txt")},
		},
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	first := c.calls[0].Messages[0].Content
	// text + image + 3 documents (+ the cache point the Claude model id adds)
	if len(first) != 6 {
		t.Fatalf("blocks = %d, want 6", len(first))
	}
	if _, ok := first[1].(*types.ContentBlockMemberImage); !ok {
		t.Fatalf("block 1 = %T, want image", first[1])
	}
	var names []string
	for _, b := range first[2:5] {
		d, ok := b.(*types.ContentBlockMemberDocument)
		if !ok {
			t.Fatalf("block = %T, want document", b)
		}
		names = append(names, aws.ToString(d.Value.Name))
	}
	if got := strings.Join(names, "|"); got != "Spec pdf|Spec pdf (2)|file" {
		t.Fatalf("document names = %q", got)
	}
}

func TestItoa(t *testing.T) {
	for n, want := range map[int]string{0: "0", 7: "7", 12: "12", 305: "305"} {
		if got := itoa(n); got != want {
			t.Errorf("itoa(%d) = %q", n, got)
		}
	}
}
