package storage

import (
	"mime"
	"strings"
)

// octetStream is what a type that cannot be parsed is served as.
const octetStream = "application/octet-stream"

// ServedContentType turns a stored Content-Type (client-declared on upload,
// or taken from an upstream response) into the one value an object may be
// served with, and reports whether it may render inline.
//
// A browser reads a Content-Type header as a comma list and takes the last
// type it understands, so "image/png, text/html" renders as HTML. The value is
// therefore parsed as ONE media type: anything that does not parse is served
// as application/octet-stream and never inline, and a scriptable type (HTML,
// SVG, any XML) is never inline either.
func ServedContentType(raw string) (contentType string, inline bool) {
	mediaType, params, err := mime.ParseMediaType(raw)
	if err != nil {
		return octetStream, false
	}
	// FormatMediaType writes back anything ParseMediaType accepted (non-ASCII
	// parameter values come out RFC 2231-encoded), canonically lower-cased.
	return mime.FormatMediaType(mediaType, params), !scriptableMediaType(mediaType)
}

// scriptableMediaType reports whether a (lower-case, parameterless) media type
// can carry executable markup.
func scriptableMediaType(mediaType string) bool {
	switch mediaType {
	case "text/html", "application/xhtml+xml", "image/svg+xml", "application/xml", "text/xml":
		return true
	}
	return strings.HasSuffix(mediaType, "+xml")
}
