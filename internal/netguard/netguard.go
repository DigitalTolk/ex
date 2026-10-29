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
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"syscall"
	"time"
	"unicode"

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
	// InternalDomains lets a host under these domains (the domain itself or
	// any subdomain) reach privateRanges — the internal services a
	// deployment's connectors live on. Consulted on every dial, like
	// AllowPrivate; ParseDomains builds the list.
	InternalDomains func() []string
}

// privateRanges are the private addresses an internal host may reach: only
// 10.0.0.0/8, where the AWS VPCs put the internal load balancers connectors
// sit behind (CliffHub, Sourcebot, Metabase). The rest of the private space,
// loopback, link-local (the cloud metadata endpoint) and every other
// special-purpose range stay shut for every host. A var so tests can stand a
// loopback server in for an internal one.
var privateRanges = []netip.Prefix{
	netip.MustParsePrefix("10.0.0.0/8"),
}

// ParseDomains reads a list of domains as an operator would write it,
// separated by commas, semicolons or spaces, case-insensitive, with a leading
// "*." or "." and a trailing "." tolerated and empty entries skipped. It never
// fails: an entry that is not a dotted hostname (a single label like "com",
// an IP address, stray characters) is returned in ignored and opens nothing —
// so a typo leaves those connectors blocked instead of the server down or the
// guard open.
func ParseDomains(raw string) (domains, ignored []string) {
	for _, entry := range strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ';' || unicode.IsSpace(r)
	}) {
		d := strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(strings.ToLower(entry), "*"), "."), ".")
		if !isDomain(d) {
			ignored = append(ignored, entry)
			continue
		}
		domains = append(domains, d)
	}
	return domains, ignored
}

// isDomain accepts a dotted hostname of letters, digits and hyphens — never an
// IP address or a bare top-level label.
func isDomain(d string) bool {
	if net.ParseIP(d) != nil {
		return false
	}
	labels := strings.Split(d, ".")
	if len(labels) < 2 {
		return false
	}
	for _, l := range labels {
		if l == "" || strings.HasPrefix(l, "-") || strings.HasSuffix(l, "-") {
			return false
		}
		for _, r := range l {
			if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' {
				return false
			}
		}
	}
	return true
}

// InDomains reports whether host is one of domains or a subdomain of one:
// "cliffhub.digitaltolk.net" is in "digitaltolk.net"; "evildigitaltolk.net"
// and "digitaltolk.net.example.com" are not.
func InDomains(host string, domains []string) bool {
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	for _, d := range domains {
		if host == d || strings.HasSuffix(host, "."+d) {
			return true
		}
	}
	return false
}

// NewClient returns an HTTP client that dials only public addresses (plus
// private ones for an internal host), ignores the proxy environment (a proxy
// would dial on our behalf, past the guard) and never carries a credential
// across hosts on a redirect.
func NewClient(o Options) *http.Client {
	return &http.Client{
		Timeout:       o.Timeout,
		Transport:     newTransport(o),
		CheckRedirect: checkRedirect(o.MaxRedirects),
	}
}

func newTransport(o Options) *http.Transport {
	dialer := func(ctl func(network, address string, c syscall.RawConn) error) *net.Dialer {
		return &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second, Control: ctl}
	}
	public, internal := dialer(control(o.AllowPrivate)), dialer(internalControl(o.AllowPrivate))
	return &http.Transport{
		// Proxy stays nil on purpose: http.ProxyFromEnvironment would hand
		// the connection to whatever HTTPS_PROXY names.
		Proxy: nil,
		// The host is known here, before DNS: an internal one dials with the
		// private ranges open. Every hop of a redirect dials afresh, so a hop
		// to any other host is back under the public-only guard.
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			if o.InternalDomains != nil {
				if host, _, err := net.SplitHostPort(addr); err == nil && InDomains(host, o.InternalDomains()) {
					return internal.DialContext(ctx, network, addr)
				}
			}
			return public.DialContext(ctx, network, addr)
		},
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

// internalControl is control for an internal host: an address in
// privateRanges is admitted too, but loopback, link-local and the rest of the
// special-purpose space stay refused — so DNS that answers with the metadata endpoint still
// gets nowhere.
func internalControl(allowPrivate func() bool) func(network, address string, c syscall.RawConn) error {
	public := control(allowPrivate)
	return func(network, address string, c syscall.RawConn) error {
		if ap, err := netip.ParseAddrPort(address); err == nil && inPrivateRange(ap.Addr().Unmap()) {
			return nil
		}
		return public(network, address, c)
	}
}

func inPrivateRange(addr netip.Addr) bool {
	for _, r := range privateRanges {
		if r.Contains(addr) {
			return true
		}
	}
	return false
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
