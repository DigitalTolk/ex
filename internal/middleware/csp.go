package middleware

import (
	"regexp"
	"slices"
	"strings"
)

// cspHostPart matches a lower-cased host[:port] that is a CSP host-part —
// dot-separated labels of letters, digits and '-' — with an optional port.
// Only that shape is ever spliced into a policy: a Host header is
// client-supplied and could otherwise carry `;` and a directive of its own.
// An IPv6 literal is no host-part, so it never matches.
var cspHostPart = regexp.MustCompile(`^[a-z0-9-]+(\.[a-z0-9-]+)*(:[0-9]{1,5})?$`)

// cspHTTPSSource matches an https source with a host-part, the leftmost
// label optionally a wildcard: "https://*.example.com".
var cspHTTPSSource = regexp.MustCompile(`^https://(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$`)

// frameSources renders frame-src for a page that may frame one same-origin
// route (the HTML-attachment preview) and a fixed set of https origins (the
// SharePoint hosts a file preview loads from). A source expression with a
// path needs a host, and 'self' cannot carry one, so the route is listed
// under each public host of the deployment and under the host the request
// named — the page's own origin as the browser sees it. Scheme-less, so the
// page's scheme applies.
type frameSources struct {
	path     string
	hosts    []string
	external []string
}

func newFrameSources(path string, publicHosts, external []string) frameSources {
	f := frameSources{path: path}
	for _, h := range publicHosts {
		if h = strings.ToLower(h); cspHostPart.MatchString(h) && !slices.Contains(f.hosts, h) {
			f.hosts = append(f.hosts, h)
		}
	}
	for _, src := range external {
		if src = strings.ToLower(src); cspHTTPSSource.MatchString(src) && !slices.Contains(f.external, src) {
			f.external = append(f.external, src)
		}
	}
	return f
}

// forHost is frame-src's value for a request whose Host is host.
func (f frameSources) forHost(host string) string {
	var sources []string
	if f.path != "" {
		hosts := f.hosts
		if host = strings.ToLower(host); cspHostPart.MatchString(host) && !slices.Contains(hosts, host) {
			hosts = append(slices.Clip(hosts), host)
		}
		for _, h := range hosts {
			sources = append(sources, h+f.path)
		}
	}
	sources = append(sources, f.external...)
	if len(sources) == 0 {
		return "'none'"
	}
	return strings.Join(sources, " ")
}
