package service

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

// The production image (Dockerfile) is distroless/static: there is no libc.
// github.com/gen2brain/webp links libc through purego, to look for a system
// libwebp, unless it is built with -tags=nodynamic — and a binary that links
// libc does not start there. Nothing else would notice before a deploy.
func TestProductionBuildStaysStatic(t *testing.T) {
	dockerfile, err := os.ReadFile("../../Dockerfile")
	if err != nil {
		t.Fatal(err)
	}
	text := string(dockerfile)
	start := strings.Index(text, "go build")
	end := strings.Index(text, "-o /ex ./cmd/server")
	if start < 0 || end < start {
		t.Fatal("the Dockerfile's server build was not found")
	}
	if !strings.Contains(text[start:end], "-tags=nodynamic") {
		t.Fatal("the Dockerfile builds the server without -tags=nodynamic")
	}

	deps := func(tags string) string {
		t.Helper()
		cmd := exec.Command("go", "list", "-deps", "-tags="+tags, "github.com/DigitalTolk/ex/cmd/server")
		cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS=linux", "GOARCH=amd64", "GOFLAGS=")
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("go list -tags=%s: %v", tags, err)
		}
		return string(out)
	}
	const purego = "github.com/ebitengine/purego\n"
	if strings.Contains(deps("nodynamic"), purego) {
		t.Fatal("-tags=nodynamic no longer keeps purego (and so libc) out of the server")
	}
	// The tag is what does it. If this fails, the library stopped linking
	// libc on its own and the tag (and this test) can go.
	if !strings.Contains(deps(""), purego) {
		t.Fatal("the server no longer pulls in purego without the tag")
	}
}
