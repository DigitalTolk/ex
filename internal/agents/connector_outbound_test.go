package agents

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"code.dny.dev/ssrf"

	"github.com/DigitalTolk/ex/internal/netguard"
)

// The connector, connector-provider and server-engine clients send a user's
// credential to an admin- or provider-supplied URL. validateOutboundURL only
// sees the URL string, so the clients themselves must refuse a private
// destination at dial time, ignore the proxy environment, and never carry the
// credential across hosts on a redirect.

func outboundClients() map[string]*http.Client {
	return map[string]*http.Client{
		"connectors":    NewConnectorService(nil).http,
		"server engine": NewServerEngine(nil, nil, nil).http,
	}
}

func TestOutboundClients_RefusePrivateDestinationsAtDialTime(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	defer srv.Close()
	prev := allowPrivateConnectorTargets
	t.Cleanup(func() { allowPrivateConnectorTargets = prev })

	for name, client := range outboundClients() {
		allowPrivateConnectorTargets = false
		if _, err := client.Get(srv.URL); !errors.Is(err, ssrf.ErrProhibitedIP) {
			t.Errorf("%s: loopback dial err = %v, want ErrProhibitedIP", name, err)
		}
		// A development workspace opts into private targets; the dial
		// guard follows the same switch.
		allowPrivateConnectorTargets = true
		res, err := client.Get(srv.URL)
		if err != nil {
			t.Errorf("%s: dev-mode private target refused: %v", name, err)
			continue
		}
		_ = res.Body.Close()
	}
	if got := hits.Load(); got != int32(len(outboundClients())) {
		t.Fatalf("private server hits = %d, want only the dev-mode calls", got)
	}
}

func TestOutboundClients_IgnoreProxyEnvironment(t *testing.T) {
	for name, client := range outboundClients() {
		tr, ok := client.Transport.(*http.Transport)
		if !ok || tr.Proxy != nil {
			t.Errorf("%s: transport %T honours the proxy environment", name, client.Transport)
		}
	}
}

func TestOutboundClients_NeverCarryCredentialsAcrossHosts(t *testing.T) {
	var leaked atomic.Value
	leaked.Store("")
	other := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		leaked.Store(r.Header.Get("X-Api-Key"))
	}))
	defer other.Close()
	evil := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/steal", http.StatusFound)
	}))
	defer evil.Close()

	for name, client := range outboundClients() {
		req, _ := http.NewRequest(http.MethodGet, evil.URL, nil)
		req.Header.Set("X-Api-Key", "user-secret")
		if _, err := client.Do(req); !errors.Is(err, netguard.ErrCredentialedRedirect) {
			t.Errorf("%s: err = %v, want ErrCredentialedRedirect", name, err)
		}
	}
	if got := leaked.Load().(string); strings.Contains(got, "user-secret") {
		t.Fatal("the credential reached another host")
	}
}

func TestValidateOutboundURL_RefusesSpecialPurposeRanges(t *testing.T) {
	prev := allowPrivateConnectorTargets
	allowPrivateConnectorTargets = false
	t.Cleanup(func() { allowPrivateConnectorTargets = prev })
	for _, u := range []string{
		"https://0.0.0.1/x", "https://192.0.0.8/x", "https://198.18.0.1/x",
		"https://240.0.0.1/x", "https://100.64.0.1/x", "https://[2002:a00:1::1]/x",
		"https://[64:ff9b::a00:1]/x",
	} {
		if err := validateOutboundURL(u); err == nil {
			t.Errorf("validateOutboundURL(%s) admitted a special-purpose address", u)
		}
	}
	if err := validateOutboundURL("https://93.184.216.34/x"); err != nil {
		t.Errorf("public literal refused: %v", err)
	}
}
