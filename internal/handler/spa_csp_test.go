package handler

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"
	"testing/fstest"

	"golang.org/x/net/html"

	ex "github.com/DigitalTolk/ex"
)

func cspHash(script string) string {
	sum := sha256.Sum256([]byte(script))
	return "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
}

func TestInlineScriptHashes(t *testing.T) {
	page := "<!doctype html><html><head>" +
		"<script>var a = 1;</script>" +
		// External: its own URL is checked against 'self', not a hash.
		`<script type="module" crossorigin src="/assets/index.js"></script>` +
		`<SCRIPT TYPE="text/javascript">b()</SCRIPT>` +
		// The same script twice needs one hash.
		"<script>var a = 1;</script>" +
		"<script></script>" +
		"</head><body>" +
		// The parser hands scripts over with CRLF/CR normalized to LF, and
		// the browser hashes what it parsed.
		"<script>x()\r\ny()\rz()</script>" +
		"<p>&lt;script&gt;not a script&lt;/script&gt;</p>" +
		"</body></html>"
	got := inlineScriptHashes([]byte(page))
	want := []string{cspHash("var a = 1;"), cspHash("b()"), cspHash(""), cspHash("x()\ny()\nz()")}
	if !slices.Equal(got, want) {
		t.Fatalf("hashes = %v, want %v", got, want)
	}
	if got := inlineScriptHashes([]byte("<html><body>no scripts</body></html>")); got != nil {
		t.Fatalf("hashes = %v, want none", got)
	}
}

// pageInlineScripts parses a served page the way a browser does and returns
// the text of every inline <script>.
func pageInlineScripts(t *testing.T, page []byte) []string {
	t.Helper()
	doc, err := html.Parse(bytes.NewReader(page))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	var scripts []string
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "script" &&
			!slices.ContainsFunc(n.Attr, func(a html.Attribute) bool { return a.Key == "src" }) {
			var text strings.Builder
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				text.WriteString(c.Data)
			}
			scripts = append(scripts, text.String())
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	return scripts
}

// assertServedPageScriptsHashed serves index through the real router and
// checks the policy allows exactly the page's inline scripts.
func assertServedPageScriptsHashed(t *testing.T, index []byte) {
	t.Helper()
	router := NewRouter(&Deps{
		Auth: &AuthHandler{}, User: &UserHandler{}, Channel: &ChannelHandler{},
		Conversation: &ConversationHandler{}, WS: &WSHandler{},
		JWT: setupJWTManager(), AppVersion: "test", AllowOrigins: []string{"*"},
		FrontendFS:     fstest.MapFS{"index.html": &fstest.MapFile{Data: index}},
		SentryFrontend: SentryFrontendConfig{DSN: testDSN, ReplaySessionSampleRate: 0.5},
	})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	scripts := pageInlineScripts(t, rec.Body.Bytes())
	if len(scripts) == 0 {
		t.Fatal("the page has no inline scripts; nothing to check")
	}
	var scriptSrc string
	for _, part := range strings.Split(rec.Header().Get("Content-Security-Policy"), ";") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(part), "script-src "); ok {
			scriptSrc = v
		}
	}
	sources := strings.Fields(scriptSrc)
	if slices.Contains(sources, "'unsafe-inline'") {
		t.Fatalf("script-src allows any inline script: %q", scriptSrc)
	}
	var want []string
	for _, s := range scripts {
		if h := cspHash(s); !slices.Contains(want, h) {
			want = append(want, h)
		}
	}
	got := slices.DeleteFunc(slices.Clone(sources), func(s string) bool { return !strings.HasPrefix(s, "'sha256-") })
	if !slices.Equal(got, want) {
		t.Fatalf("script-src hashes = %v, want one per inline script %v", got, want)
	}
	// The deployment's own additions survive next to the hashes.
	if sources[0] != "'self'" || !slices.Contains(sources, sentryReplayCDN) {
		t.Fatalf("script-src = %q", scriptSrc)
	}
}

// The repository's index.html: Vite copies its inline scripts into the
// build verbatim, so this runs on every checkout, built or not.
func TestRouterCSPHashesEveryInlineScriptOfIndexHTML(t *testing.T) {
	index, err := os.ReadFile("../../index.html")
	if err != nil {
		t.Fatalf("read index.html: %v", err)
	}
	assertServedPageScriptsHashed(t, index)
}

// The page the binary actually embeds, once the frontend has been built.
func TestRouterCSPHashesEveryInlineScriptOfTheEmbeddedBuild(t *testing.T) {
	index, err := fs.ReadFile(ex.FrontendFS, "dist/index.html")
	if err != nil {
		t.Skip("frontend not built (dist/index.html missing); the source index.html is covered above")
	}
	assertServedPageScriptsHashed(t, index)
}
