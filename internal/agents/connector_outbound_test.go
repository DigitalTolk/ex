package agents

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

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

// Being under a connector domain opens private networks only: a connector host
// that resolves to loopback (or the metadata endpoint) stays refused.
func TestOutboundClients_ConnectorDomainNeverOpensLoopback(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	defer srv.Close()
	prevDev, prevDomains := allowPrivateConnectorTargets, connectorDomains
	t.Cleanup(func() { allowPrivateConnectorTargets, connectorDomains = prevDev, prevDomains })
	allowPrivateConnectorTargets = false
	AllowConnectorDomains([]string{"localhost"})
	port := srv.URL[strings.LastIndex(srv.URL, ":")+1:]
	for name, client := range outboundClients() {
		if _, err := client.Get("http://localhost:" + port); !errors.Is(err, ssrf.ErrProhibitedIP) {
			t.Errorf("%s: connector-domain host on loopback: err = %v, want ErrProhibitedIP", name, err)
		}
	}
	if hits.Load() != 0 {
		t.Fatal("loopback was reached")
	}
}

func TestConfigureConnectorDomains_LogsWhatItIgnoresAndNeverFails(t *testing.T) {
	prev := connectorDomains
	t.Cleanup(func() { connectorDomains = prev })
	var buf bytes.Buffer
	prevLog := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prevLog) })

	ConfigureConnectorDomains(context.Background(), "digitaltolk.net, *.DigitalTolk.com,com,10.0.0.0/8")
	if got := fmt.Sprint(connectorDomains); got != "[digitaltolk.net digitaltolk.com]" {
		t.Fatalf("connectorDomains = %s", got)
	}
	out := buf.String()
	for _, want := range []string{"entry=com", "entry=10.0.0.0/8", "level=ERROR", "domains=digitaltolk.net,digitaltolk.com"} {
		if !strings.Contains(out, want) {
			t.Errorf("log lacks %q:\n%s", want, out)
		}
	}

	buf.Reset()
	ConfigureConnectorDomains(context.Background(), "")
	if connectorDomains != nil || buf.Len() != 0 {
		t.Fatalf("unset setting: domains=%v log=%q, want none and silence", connectorDomains, buf.String())
	}
}

// The bridged workspace tools call this process's own run-tool API on
// loopback. With the guard as production has it (this package's tests relax
// it by default), they must still get through — they don't share the
// connector client, which refuses loopback.
func TestServerEngine_BridgedToolsReachTheRunAPIOnLoopback(t *testing.T) {
	prevDev, prevDomains := allowPrivateConnectorTargets, connectorDomains
	t.Cleanup(func() { allowPrivateConnectorTargets, connectorDomains = prevDev, prevDomains })
	allowPrivateConnectorTargets, connectorDomains = false, nil

	var gotAuth atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth.Store(r.Header.Get("Authorization"))
		_, _ = w.Write([]byte(`{"text":"~general"}`))
	}))
	defer srv.Close()
	fx := newOrchFixture(t)
	e := NewServerEngine(fx.orch, nil, nil)
	e.SetRunAPIBase(srv.URL)
	tools, _, err := e.buildTools(context.Background(), untrustedServerRun(t, fx), "run-tok", func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	if out, isErr := toolByName(t, tools, "list_channels").Call(context.Background(), json.RawMessage(`{}`)); isErr || out != "~general" {
		t.Fatalf("bridged tool on loopback: %v %q", isErr, out)
	}
	if got, _ := gotAuth.Load().(string); got != "Bearer run-tok" {
		t.Fatalf("Authorization = %q", got)
	}
	// The connector client of the same engine still refuses loopback.
	if _, err := e.http.Get(srv.URL); !errors.Is(err, ssrf.ErrProhibitedIP) {
		t.Fatalf("connector client on loopback: err = %v, want ErrProhibitedIP", err)
	}
}

// The run token never leaves this process's listener: the run-API client
// follows no redirect.
func TestRunAPIClient_FollowsNoRedirect(t *testing.T) {
	var leaked atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { leaked.Add(1) }))
	defer other.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
	}))
	defer srv.Close()
	client := runAPIClient(5 * time.Second)
	req, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
	req.Header.Set("Authorization", "Bearer run-tok")
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusTemporaryRedirect || leaked.Load() != 0 {
		t.Fatalf("status %d, redirect target hits %d: want the redirect returned, not followed", res.StatusCode, leaked.Load())
	}
	if tr, ok := client.Transport.(*http.Transport); !ok || tr.Proxy != nil {
		t.Fatalf("transport %T honours the proxy environment", client.Transport)
	}
}
