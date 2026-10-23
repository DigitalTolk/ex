// Package netguard is the one outbound-HTTP policy for requests whose
// destination someone other than the operator chose: link unfurls and their
// preview images (any user), connector calls, the connector-provider sync and
// the server engine's tool calls (admin- or provider-supplied URLs that carry
// a user's credential).
//
// The guard runs at dial time, on the address actually being connected to, so
// it also covers redirects and DNS rebinding — a URL-string check alone cannot.
// The deny list is code.dny.dev/ssrf's: the IANA IPv4/IPv6 special-purpose
// registries (loopback, RFC 1918, CGNAT, link-local metadata, benchmarking,
// reserved, 6to4, NAT64, …), not a hand-kept list of the ones we remembered.
package netguard

import (
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"syscall"
	"time"

	"code.dny.dev/ssrf"
)

// guardian admits only globally routable destinations, on any port: a
// connector or a pasted link may well live on :8443.
var guardian = ssrf.New(ssrf.WithAnyPort())

// DefaultMaxRedirects bounds a redirect chain when Options.MaxRedirects is 0.
const DefaultMaxRedirects = 5

var (
	// ErrTooManyRedirects stops a redirect chain at Options.MaxRedirects.
	ErrTooManyRedirects = errors.New("netguard: too many redirects")
	// ErrCredentialedRedirect refuses to follow a redirect that would carry a
	// credential (a header, URL userinfo or a replayed body) to another host.
	// Go's client strips Authorization and Cookie on such a hop but forwards
	// every other header — a connector's X-Api-Key included — and replays the
	// body of a 307/308.
	ErrCredentialedRedirect = errors.New("netguard: refusing to carry credentials to another host on redirect")
)

// IsPublicIP reports whether ip is a destination the guard admits.
func IsPublicIP(ip net.IP) bool {
	addr, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	return guardian.SafeAddr(addr.Unmap()) == nil
}

// Options configures NewClient.
type Options struct {
	// Timeout bounds a whole request, redirects and body included.
	Timeout time.Duration
	// MaxRedirects caps the redirect chain (0 → DefaultMaxRedirects).
	MaxRedirects int
	// DisableKeepAlives opens a fresh connection per request.
	DisableKeepAlives bool
	// AllowPrivate, when it reports true, admits every destination — a
	// development workspace whose connector runs on the same machine. It is
	// consulted on every dial, so flipping the setting needs no new client.
	AllowPrivate func() bool
}

// NewClient returns an HTTP client that dials only public addresses, ignores
// the proxy environment (a proxy would dial on our behalf, past the guard) and
// never carries a credential across hosts on a redirect.
func NewClient(o Options) *http.Client {
	return &http.Client{
		Timeout:       o.Timeout,
		Transport:     newTransport(o),
		CheckRedirect: checkRedirect(o.MaxRedirects),
	}
}

func newTransport(o Options) *http.Transport {
	dialer := &net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
		Control:   control(o.AllowPrivate),
	}
	return &http.Transport{
		// Proxy stays nil on purpose: http.ProxyFromEnvironment would hand
		// the connection to whatever HTTPS_PROXY names.
		Proxy:                 nil,
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
		DisableKeepAlives:     o.DisableKeepAlives,
	}
}

// control is the dialer hook: it sees the resolved address being connected
// to, after DNS and on every redirect hop.
func control(allowPrivate func() bool) func(network, address string, c syscall.RawConn) error {
	return func(network, address string, c syscall.RawConn) error {
		if allowPrivate != nil && allowPrivate() {
			return nil
		}
		return guardian.Safe(network, address, c)
	}
}

// benignHeaders are the request headers that never carry a credential. Any
// other header on the original request (Authorization, Cookie, X-Api-Key, a
// connector's custom auth header, …) makes it a credentialed request.
var benignHeaders = map[string]bool{
	"Accept":          true,
	"Accept-Encoding": true,
	"Accept-Language": true,
	"Cache-Control":   true,
	"Content-Length":  true,
	"Content-Type":    true,
	"User-Agent":      true,
}

func checkRedirect(maxRedirects int) func(req *http.Request, via []*http.Request) error {
	if maxRedirects <= 0 {
		maxRedirects = DefaultMaxRedirects
	}
	return func(req *http.Request, via []*http.Request) error {
		if len(via) >= maxRedirects {
			return ErrTooManyRedirects
		}
		first := via[0]
		if (carriesCredentials(first) || resendsBody(req)) && !sameOrigin(first.URL, req.URL) {
			return ErrCredentialedRedirect
		}
		return nil
	}
}

// resendsBody reports whether a redirect hop replays the request body (a 307
// or 308): a password grant carries its credential there, not in a header.
func resendsBody(r *http.Request) bool {
	return r.Body != nil && r.Body != http.NoBody
}

func carriesCredentials(r *http.Request) bool {
	if r.URL.User != nil {
		return true
	}
	for name := range r.Header {
		if !benignHeaders[http.CanonicalHeaderKey(name)] {
			return true
		}
	}
	return false
}

// sameOrigin allows a hop to the same host and port, keeping or upgrading
// (http → https) the scheme — never downgrading a credential to plain HTTP.
func sameOrigin(from, to *url.URL) bool {
	if !strings.EqualFold(from.Host, to.Host) {
		return false
	}
	return from.Scheme == to.Scheme || (from.Scheme == "http" && to.Scheme == "https")
}
