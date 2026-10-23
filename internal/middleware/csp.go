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

// frameSources renders frame-src for a page that may frame exactly one
// same-origin route (the HTML-attachment preview). A source expression with
// a path needs a host, and 'self' cannot carry one, so the route is listed
// under each public host of the deployment and under the host the request
// named — the page's own origin as the browser sees it. Scheme-less, so the
// page's scheme applies.
type frameSources struct {
	path  string
	hosts []string
}

func newFrameSources(path string, publicHosts []string) frameSources {
	f := frameSources{path: path}
	for _, h := range publicHosts {
		if h = strings.ToLower(h); cspHostPart.MatchString(h) && !slices.Contains(f.hosts, h) {
			f.hosts = append(f.hosts, h)
		}
	}
	return f
}

// forHost is frame-src's value for a request whose Host is host.
func (f frameSources) forHost(host string) string {
	if f.path == "" {
		return "'none'"
	}
	hosts := f.hosts
	if host = strings.ToLower(host); cspHostPart.MatchString(host) && !slices.Contains(hosts, host) {
		hosts = append(slices.Clip(hosts), host)
	}
	if len(hosts) == 0 {
		return "'none'"
	}
	sources := make([]string, len(hosts))
	for i, h := range hosts {
		sources[i] = h + f.path
	}
	return strings.Join(sources, " ")
}
