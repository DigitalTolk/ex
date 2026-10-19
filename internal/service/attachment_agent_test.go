package service

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// agentPNG is a tiny valid PNG: the upload path decodes images for real.
func agentPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

type fixedLimits struct{ ext, size bool }

func (l fixedLimits) AllowsExtension(context.Context, string) bool { return l.ext }
func (l fixedLimits) AllowsSize(context.Context, int64) bool       { return l.size }

func newAgentUploadSvc() (*AttachmentService, *mockAttachmentStore, *fakeAttachmentSigner) {
	st := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{objects: map[string][]byte{}}
	return NewAttachmentService(st, signer, nil), st, signer
}

func TestUploadForAgent_StoresVerifiesAndBindsToRun(t *testing.T) {
	svc, st, signer := newAgentUploadSvc()
	data := agentPNG(t)
	a, err := svc.UploadForAgent(context.Background(), AgentUploadParams{
		RunID: "run-1", AgentID: "u-gg", Filename: "../shots/Screen Shot.PNG", Size: int64(len(data)), Body: bytes.NewReader(data),
	})
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	if a.RunID != "run-1" || a.CreatedBy != "u-gg" || a.ContentType != "image/png" || a.Filename != "Screen Shot.PNG" {
		t.Fatalf("row = %+v", a)
	}
	if a.Width != 2 || a.Height != 2 || a.SHA256 != sha256Hex(data) {
		t.Fatalf("dimensions/hash not recorded: %+v", a)
	}
	if got := signer.objects[a.S3Key]; !bytes.Equal(got, data) {
		t.Fatal("object bytes differ")
	}
	if st.byID[a.ID].VerifiedETag == "" || a.ThumbnailS3Key == "" {
		t.Fatalf("not verified/thumbnailed: %+v", st.byID[a.ID])
	}
	// The run binding is what ForRunPost checks.
	if _, err := svc.ForRunPost(context.Background(), a.ID, "run-1", "u-gg"); err != nil {
		t.Fatalf("ForRunPost own file: %v", err)
	}
	for _, c := range [][2]string{{"run-2", "u-gg"}, {"run-1", "u-other"}, {"", "u-gg"}} {
		if _, err := svc.ForRunPost(context.Background(), a.ID, c[0], c[1]); !errors.Is(err, ErrForbidden) {
			t.Fatalf("ForRunPost(%v) = %v, want ErrForbidden", c, err)
		}
	}
	if _, err := svc.ForRunPost(context.Background(), "nope", "run-1", "u-gg"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("ForRunPost missing = %v", err)
	}
}

func TestUploadForAgent_TextFileUsesTheExtensionsType(t *testing.T) {
	svc, _, signer := newAgentUploadSvc()
	signer.objectContentType = "text/markdown"
	body := "# report\n"
	a, err := svc.UploadForAgent(context.Background(), AgentUploadParams{
		RunID: "run-1", AgentID: "u-gg", Filename: "report.md", Size: int64(len(body)), Body: strings.NewReader(body),
	})
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	if a.ContentType != "text/markdown" || a.Width != 0 {
		t.Fatalf("row = %+v", a)
	}
}

func TestUploadForAgent_Rejections(t *testing.T) {
	ctx := context.Background()
	data := agentPNG(t)
	ok := func(svc *AttachmentService) AgentUploadParams {
		return AgentUploadParams{RunID: "run-1", AgentID: "u-gg", Filename: "a.png", Size: int64(len(data)), Body: bytes.NewReader(data)}
	}
	t.Run("run and agent required", func(t *testing.T) {
		svc, _, _ := newAgentUploadSvc()
		p := ok(svc)
		p.RunID = ""
		if _, err := svc.UploadForAgent(ctx, p); err == nil {
			t.Fatal("expected error")
		}
	})
	t.Run("no storage", func(t *testing.T) {
		svc := NewAttachmentService(newMockAttachmentStore(), nil, nil)
		if _, err := svc.UploadForAgent(ctx, ok(svc)); err == nil {
			t.Fatal("expected error")
		}
	})
	t.Run("type outside the allow-list", func(t *testing.T) {
		svc, _, _ := newAgentUploadSvc()
		for _, name := range []string{"run.sh", "x.svg", "a.zip", "noext", "evil.png.exe"} {
			p := ok(svc)
			p.Filename = name
			if _, err := svc.UploadForAgent(ctx, p); !errors.Is(err, ErrUnsupportedUploadType) {
				t.Fatalf("%s: %v", name, err)
			}
		}
	})
	t.Run("size bounds", func(t *testing.T) {
		svc, _, _ := newAgentUploadSvc()
		for _, size := range []int64{0, -1, model.UploadMaxBytes + 1} {
			p := ok(svc)
			p.Size = size
			if _, err := svc.UploadForAgent(ctx, p); !errors.Is(err, ErrUploadTooLarge) {
				t.Fatalf("size %d: %v", size, err)
			}
		}
	})
	t.Run("workspace limits", func(t *testing.T) {
		svc, _, _ := newAgentUploadSvc()
		svc.SetUploadLimits(fixedLimits{ext: false, size: true})
		if _, err := svc.UploadForAgent(ctx, ok(svc)); !errors.Is(err, ErrUnsupportedUploadType) {
			t.Fatalf("ext limit: %v", err)
		}
		svc.SetUploadLimits(fixedLimits{ext: true, size: false})
		if _, err := svc.UploadForAgent(ctx, ok(svc)); !errors.Is(err, ErrUploadTooLarge) {
			t.Fatalf("size limit: %v", err)
		}
	})
	t.Run("body read error", func(t *testing.T) {
		svc, _, _ := newAgentUploadSvc()
		p := ok(svc)
		p.Body = io.MultiReader(bytes.NewReader(data[:4]), errReader{})
		if _, err := svc.UploadForAgent(ctx, p); err == nil || !strings.Contains(err.Error(), "read upload") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("declared size must match", func(t *testing.T) {
		svc, _, _ := newAgentUploadSvc()
		p := ok(svc)
		p.Size = int64(len(data)) - 1 // one byte more arrives than declared
		if _, err := svc.UploadForAgent(ctx, p); err == nil || !strings.Contains(err.Error(), "size mismatch") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("bytes must be what the extension says", func(t *testing.T) {
		svc, _, _ := newAgentUploadSvc()
		p := ok(svc)
		p.Body = strings.NewReader(strings.Repeat("x", len(data)))
		if _, err := svc.UploadForAgent(ctx, p); err == nil || !strings.Contains(err.Error(), "image") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("store put fails", func(t *testing.T) {
		svc, _, signer := newAgentUploadSvc()
		signer.putErr = errors.New("s3 down")
		if _, err := svc.UploadForAgent(ctx, ok(svc)); err == nil || !strings.Contains(err.Error(), "store upload") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("row create fails and the object is discarded", func(t *testing.T) {
		svc, st, signer := newAgentUploadSvc()
		st.createErr = errors.New("dynamo down")
		if _, err := svc.UploadForAgent(ctx, ok(svc)); err == nil || !strings.Contains(err.Error(), "create") {
			t.Fatalf("err = %v", err)
		}
		if len(signer.deleted) != 1 {
			t.Fatalf("object not discarded: %v", signer.deleted)
		}
	})
	t.Run("verification fails and both object and row go", func(t *testing.T) {
		svc, st, signer := newAgentUploadSvc()
		signer.objectContentType = "image/gif" // the stored object contradicts the row
		signer.delErr = errors.New("delete down")
		st.deleteErr = errors.New("row delete down")
		if _, err := svc.UploadForAgent(ctx, ok(svc)); err == nil {
			t.Fatal("expected verification error")
		}
		if len(signer.deleted) != 1 {
			t.Fatalf("object cleanup not attempted: %v", signer.deleted)
		}
	})
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("boom") }

func TestSanitizeUploadFilename(t *testing.T) {
	long := strings.Repeat("n", 200) + ".csv"
	cases := map[string]string{
		"report.md":              "report.md",
		"../../etc/passwd":       "passwd",
		`C:\\temp\\out.csv`:      "out.csv",
		"..hidden.txt":           "hidden.txt",
		"ctl\x00\x1fchars\n.txt": "ctlchars.txt",
		"   ":                    "file",
		"":                       "file",
		".":                      "file",
		"ünïcode name.pdf":       "ünïcode name.pdf",
		long:                     strings.Repeat("n", maxUploadFilenameLen-4) + ".csv",
	}
	for in, want := range cases {
		if got := sanitizeUploadFilename(in); got != want {
			t.Errorf("sanitizeUploadFilename(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestOpenForUserAndOwner(t *testing.T) {
	ctx := context.Background()
	st := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{objects: map[string][]byte{"attachments/a1": []byte("bytes")}}
	svc := NewAttachmentService(st, signer, nil)
	st.byID["a1"] = &model.Attachment{ID: "a1", S3Key: "attachments/a1", CreatedBy: "u-bob", MessageIDs: []string{"m1"}, Size: 5}

	if _, _, err := svc.OpenForUser(ctx, "u-alice", "missing", "ch", ParentChannel, "m1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	// No access checker wired and not the owner of an unsent file: denied.
	if _, _, err := svc.OpenForUser(ctx, "u-alice", "a1", "ch", ParentChannel, "m1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("denied: %v", err)
	}
	svc.SetAccessChecker(fakeAttachmentAccessChecker{err: errors.New("dynamo blip")})
	if _, _, err := svc.OpenForUser(ctx, "u-alice", "a1", "ch", ParentChannel, "m1"); err == nil || errors.Is(err, store.ErrNotFound) {
		t.Fatalf("transient check failure must not read as denial: %v", err)
	}
	svc.SetAccessChecker(fakeAttachmentAccessChecker{})
	body, a, err := svc.OpenForUser(ctx, "u-alice", "a1", "ch", ParentChannel, "m1")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	got, _ := io.ReadAll(body)
	_ = body.Close()
	if string(got) != "bytes" || a.ID != "a1" {
		t.Fatalf("read %q / %+v", got, a)
	}
	// Storage gone or object missing.
	st.byID["a2"] = &model.Attachment{ID: "a2", S3Key: "attachments/a2", CreatedBy: "u-alice"}
	if _, _, err := svc.OpenForUser(ctx, "u-alice", "a2", "", "", ""); err == nil || !strings.Contains(err.Error(), "open object") {
		t.Fatalf("missing object: %v", err)
	}
	noStore := NewAttachmentService(st, nil, nil)
	if _, _, err := noStore.OpenForUser(ctx, "u-alice", "a2", "", "", ""); err == nil || !strings.Contains(err.Error(), "storage") {
		t.Fatalf("no storage: %v", err)
	}

	owner, refs, err := svc.AttachmentOwner(ctx, "a1")
	if err != nil || owner != "u-bob" || len(refs) != 1 {
		t.Fatalf("owner = %q %v %v", owner, refs, err)
	}
	if _, _, err := svc.AttachmentOwner(ctx, "missing"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("owner missing: %v", err)
	}
}
