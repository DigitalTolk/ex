package netguard

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"code.dny.dev/ssrf"
)

func TestIsPublicIP(t *testing.T) {
	for _, s := range []string{"93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"} {
		if !IsPublicIP(net.ParseIP(s)) {
			t.Errorf("IsPublicIP(%s) = false, want true", s)
		}
	}
	for _, s := range []string{
		"127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254",
		"100.64.1.1",                   // CGNAT
		"0.1.2.3",                      // "this network"
		"192.0.0.8",                    // IETF protocol assignments
		"198.18.0.1",                   // benchmarking
		"240.0.0.1", "255.255.255.255", // reserved / broadcast
		"224.0.0.1", // multicast
		"::1", "fe80::1", "fc00::1", "ff02::1", "::",
		"2002:a00:1::1",   // 6to4 wrapping 10.0.0.1
		"64:ff9b::a00:1",  // NAT64 wrapping 10.0.0.1
		"::ffff:10.0.0.1", // IPv4-mapped private
	} {
		if IsPublicIP(net.ParseIP(s)) {
			t.Errorf("IsPublicIP(%s) = true, want false", s)
		}
	}
	if IsPublicIP(net.IP{1, 2, 3}) {
		t.Error("a malformed address was admitted")
	}
}

func TestNewClient_RefusesPrivateDestinationsAtDialTime(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	defer srv.Close()

	_, err := NewClient(Options{Timeout: 5 * time.Second}).Get(srv.URL)
	if !errors.Is(err, ssrf.ErrProhibitedIP) {
		t.Fatalf("loopback dial err = %v, want ErrProhibitedIP", err)
	}
	if hits.Load() != 0 {
		t.Fatal("the private server was reached")
	}

	// A hostname resolving to loopback is refused just the same: the check
	// runs on the resolved address, not the URL.
	u, _ := url.Parse(srv.URL)
	_, err = NewClient(Options{Timeout: 5 * time.Second}).Get("http://localhost:" + u.Port())
	if !errors.Is(err, ssrf.ErrProhibitedIP) {
		t.Fatalf("localhost dial err = %v, want ErrProhibitedIP", err)
	}
}

func TestNewClient_AllowPrivateIsConsultedPerDial(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	defer srv.Close()
	var allow atomic.Bool
	client := NewClient(Options{Timeout: 5 * time.Second, DisableKeepAlives: true, AllowPrivate: allow.Load})

	if _, err := client.Get(srv.URL); err == nil {
		t.Fatal("private destination admitted while not allowed")
	}
	allow.Store(true)
	res, err := client.Get(srv.URL)
	if err != nil {
		t.Fatalf("allowed private destination: %v", err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d", res.StatusCode)
	}
}

func TestParseDomains(t *testing.T) {
	cases := []struct {
		raw, domains, ignored string
	}{
		{"", "[]", "[]"},
		{"   ", "[]", "[]"},
		{"digitaltolk.net,digitaltolk.com", "[digitaltolk.net digitaltolk.com]", "[]"},
		// How people actually type lists: spaces, semicolons, new lines, a
		// trailing comma, upper case, wildcards and trailing dots.
		{"DigitalTolk.net, *.digitaltolk.com ;.internal.example.org.,\n", "[digitaltolk.net digitaltolk.com internal.example.org]", "[]"},
		{"a-1.example.net", "[a-1.example.net]", "[]"},
		// Unusable entries are left out — never fatal, never opened.
		{"digitaltolk.net,com,10.0.0.1,exa_mple.com,-bad.com,bad-.com,a..com,::1", "[digitaltolk.net]",
			"[com 10.0.0.1 exa_mple.com -bad.com bad-.com a..com ::1]"},
	}
	for _, c := range cases {
		domains, ignored := ParseDomains(c.raw)
		if got := fmt.Sprint(domains); got != c.domains {
			t.Errorf("ParseDomains(%q) domains = %s, want %s", c.raw, got, c.domains)
		}
		if got := fmt.Sprint(ignored); got != c.ignored {
			t.Errorf("ParseDomains(%q) ignored = %s, want %s", c.raw, got, c.ignored)
		}
	}
}

func TestInDomains(t *testing.T) {
	domains := []string{"digitaltolk.net", "digitaltolk.com"}
	for host, want := range map[string]bool{
		"digitaltolk.net":             true,
		"cliffhub.digitaltolk.net":    true,
		"a.b.digitaltolk.com":         true,
		"CliffHub.DigitalTolk.NET.":   true,
		"evildigitaltolk.net":         false,
		"digitaltolk.net.example.com": false,
		"digitaltolk.org":             false,
		"10.20.1.5":                   false,
		"":                            false,
	} {
		if got := InDomains(host, domains); got != want {
			t.Errorf("InDomains(%q) = %v, want %v", host, got, want)
		}
	}
}

// withLoopbackAsInternal lets an httptest server (on 127.0.0.1) stand in for
// an internal service on a private address.
func withLoopbackAsInternal(t *testing.T) {
	t.Helper()
	prev := privateRanges
	privateRanges = append(append([]netip.Prefix{}, prev...), netip.MustParsePrefix("127.0.0.0/8"))
	t.Cleanup(func() { privateRanges = prev })
}

func TestNewClient_InternalDomainsReachPrivateAddresses(t *testing.T) {
	withLoopbackAsInternal(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	internalURL := "http://localhost:" + u.Port()
	client := NewClient(Options{
		Timeout:           5 * time.Second,
		DisableKeepAlives: true,
		InternalDomains:   func() []string { return []string{"localhost"} },
	})

	res, err := client.Get(internalURL)
	if err != nil {
		t.Fatalf("internal host refused: %v", err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d", res.StatusCode)
	}
	// The same address under another name — here the bare IP — is not an
	// internal host.
	if _, err := client.Get(srv.URL); !errors.Is(err, ssrf.ErrProhibitedIP) {
		t.Fatalf("private address of a non-internal host: err = %v, want ErrProhibitedIP", err)
	}
	// Without the domain list, nothing private is reachable.
	if _, err := NewClient(Options{Timeout: 5 * time.Second}).Get(internalURL); !errors.Is(err, ssrf.ErrProhibitedIP) {
		t.Fatalf("no internal domains: err = %v, want ErrProhibitedIP", err)
	}
}

func TestNewClient_InternalHostCannotRedirectToAnotherPrivateHost(t *testing.T) {
	withLoopbackAsInternal(t)
	var hits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	defer target.Close()
	internal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound) // 127.0.0.1: not an internal host
	}))
	defer internal.Close()
	u, _ := url.Parse(internal.URL)
	client := NewClient(Options{Timeout: 5 * time.Second, InternalDomains: func() []string { return []string{"localhost"} }})
	if _, err := client.Get("http://localhost:" + u.Port()); !errors.Is(err, ssrf.ErrProhibitedIP) {
		t.Fatalf("redirect hop to a non-internal private host: err = %v, want ErrProhibitedIP", err)
	}
	if hits.Load() != 0 {
		t.Fatal("the redirect target was reached")
	}
}

// Loopback is not a private network: even an internal host that resolves to
// it (or to the metadata endpoint) stays refused.
func TestNewClient_InternalHostNeverReachesLoopback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	client := NewClient(Options{Timeout: 5 * time.Second, InternalDomains: func() []string { return []string{"localhost"} }})
	if _, err := client.Get("http://localhost:" + u.Port()); !errors.Is(err, ssrf.ErrProhibitedIP) {
		t.Fatalf("internal host on loopback: err = %v, want ErrProhibitedIP", err)
	}
}

func TestInternalControl(t *testing.T) {
	ctl := internalControl(nil)
	if err := ctl("tcp4", "10.20.1.5:443", nil); err != nil {
		t.Errorf("private address refused: %v", err)
	}
	for _, addr := range []string{
		"169.254.169.254:80", "127.0.0.1:80", "not-an-address",
		// Private, but not where the connectors live: still refused.
		"172.16.0.1:443", "192.168.1.1:443", "100.64.0.1:443", "[fd00::1]:443",
	} {
		if err := ctl("tcp4", addr, nil); err == nil {
			t.Errorf("internal control admitted %s", addr)
		}
	}
}

func TestTransport_AddressWithoutPortUsesThePublicGuard(t *testing.T) {
	tr := newTransport(Options{InternalDomains: func() []string { return []string{"localhost"} }})
	if _, err := tr.DialContext(context.Background(), "tcp", "localhost"); err == nil {
		t.Fatal("an address without a port was dialed")
	}
}

func TestNewClient_IgnoresProxyEnvironment(t *testing.T) {
	tr, ok := NewClient(Options{}).Transport.(*http.Transport)
	if !ok {
		t.Fatal("transport is not an *http.Transport")
	}
	if tr.Proxy != nil {
		t.Fatal("transport honours the proxy environment")
	}
	if tr.DialContext == nil {
		t.Fatal("transport has no guarded dialer")
	}
}

// redirectPair is a server that redirects every request to target, plus the
// target, which records the credential headers it receives.
func redirectPair(t *testing.T) (redirector, target *httptest.Server, gotKey *atomic.Value) {
	t.Helper()
	gotKey = &atomic.Value{}
	gotKey.Store("")
	target = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey.Store(r.Header.Get("X-Api-Key"))
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(target.Close)
	redirector = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/landing", http.StatusFound)
	}))
	t.Cleanup(redirector.Close)
	return redirector, target, gotKey
}

func allowAll() bool { return true }

func TestCheckRedirect_RefusesCredentialedCrossHostHop(t *testing.T) {
	redirector, _, gotKey := redirectPair(t)
	client := NewClient(Options{Timeout: 5 * time.Second, AllowPrivate: allowAll})

	req, _ := http.NewRequest(http.MethodGet, redirector.URL, nil)
	req.Header.Set("X-Api-Key", "secret")
	_, err := client.Do(req)
	if !errors.Is(err, ErrCredentialedRedirect) {
		t.Fatalf("err = %v, want ErrCredentialedRedirect", err)
	}
	if got := gotKey.Load().(string); got != "" {
		t.Fatalf("the credential reached the other host: %q", got)
	}

	// Credentials in the URL itself count too.
	u, _ := url.Parse(redirector.URL)
	u.User = url.UserPassword("u", "p")
	if _, err := client.Get(u.String()); !errors.Is(err, ErrCredentialedRedirect) {
		t.Fatalf("userinfo err = %v, want ErrCredentialedRedirect", err)
	}
}

func TestCheckRedirect_FollowsUncredentialedCrossHostHop(t *testing.T) {
	redirector, _, _ := redirectPair(t)
	client := NewClient(Options{Timeout: 5 * time.Second, AllowPrivate: allowAll})
	req, _ := http.NewRequest(http.MethodGet, redirector.URL, nil)
	req.Header.Set("Accept", "text/html")
	req.Header.Set("User-Agent", "test")
	res, err := client.Do(req)
	if err != nil {
		t.Fatalf("plain redirect refused: %v", err)
	}
	_ = res.Body.Close()
	if !strings.HasSuffix(res.Request.URL.Path, "/landing") {
		t.Fatalf("landed on %s", res.Request.URL)
	}
}

func TestCheckRedirect_FollowsCredentialedSameHostHop(t *testing.T) {
	var gotKey atomic.Value
	gotKey.Store("")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/start" {
			http.Redirect(w, r, "/landing", http.StatusFound)
			return
		}
		gotKey.Store(r.Header.Get("X-Api-Key"))
	}))
	defer srv.Close()
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/start", nil)
	req.Header.Set("X-Api-Key", "secret")
	res, err := NewClient(Options{Timeout: 5 * time.Second, AllowPrivate: allowAll}).Do(req)
	if err != nil {
		t.Fatalf("same-host redirect refused: %v", err)
	}
	_ = res.Body.Close()
	if gotKey.Load().(string) != "secret" {
		t.Fatal("same-host hop lost its credential")
	}
}

func TestCheckRedirect_RefusesReplayedBodyToAnotherHost(t *testing.T) {
	var gotBody atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		if r.ContentLength > 0 {
			gotBody.Store(true)
		}
	}))
	defer target.Close()
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirector.Close()
	req, _ := http.NewRequest(http.MethodPost, redirector.URL, strings.NewReader(`{"password":"p"}`))
	req.Header.Set("Content-Type", "application/json")
	_, err := NewClient(Options{Timeout: 5 * time.Second, AllowPrivate: allowAll}).Do(req)
	if !errors.Is(err, ErrCredentialedRedirect) {
		t.Fatalf("err = %v, want ErrCredentialedRedirect", err)
	}
	if gotBody.Load() {
		t.Fatal("the body was replayed to another host")
	}
}

func TestCheckRedirect_Limits(t *testing.T) {
	loop := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/again", http.StatusFound)
	}))
	defer loop.Close()
	for _, max := range []int{0, 2} {
		_, err := NewClient(Options{Timeout: 5 * time.Second, MaxRedirects: max, AllowPrivate: allowAll}).Get(loop.URL)
		if !errors.Is(err, ErrTooManyRedirects) {
			t.Fatalf("max %d: err = %v, want ErrTooManyRedirects", max, err)
		}
	}
}

func TestSameOrigin(t *testing.T) {
	parse := func(s string) *url.URL {
		u, err := url.Parse(s)
		if err != nil {
			t.Fatal(err)
		}
		return u
	}
	for _, tc := range []struct {
		from, to string
		want     bool
	}{
		{"https://a.example/x", "https://A.example/y", true},
		{"http://a.example/x", "https://a.example/y", true},
		{"https://a.example/x", "http://a.example/y", false},
		{"https://a.example/x", "https://a.example:8443/y", false},
		{"https://a.example/x", "https://b.example/y", false},
	} {
		if got := sameOrigin(parse(tc.from), parse(tc.to)); got != tc.want {
			t.Errorf("sameOrigin(%s, %s) = %v, want %v", tc.from, tc.to, got, tc.want)
		}
	}
}
