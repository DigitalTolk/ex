package service

import (
	"context"
	"log/slog"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/limits"
	"github.com/DigitalTolk/ex/internal/model"
)

// Typed handles. Someone who types "@oncall" instead of picking the group
// from the autocomplete still pings it: on send (and edit) a bare "@handle"
// that names an enabled group is stored as the group's "@[group-…|oncall]"
// token, so every reader sees one canonical form.

// typedHandlePattern finds a bare "@word". The leading guard keeps it out of
// email addresses ("ops@oncall"), paths and URLs ("x.com/@oncall") and
// mention tokens ("@[").
var typedHandlePattern = regexp.MustCompile(`(^|[^\w@/:.\-\[])@([A-Za-z0-9][A-Za-z0-9._-]*)`)

// Spans a typed handle is never converted inside, beyond code and existing
// mention tokens: a markdown link's destination and an <autolink>.
var (
	linkDestinationPattern = regexp.MustCompile(`\]\([^)]*\)`)
	autolinkPattern        = regexp.MustCompile(`<[^>\s]+>`)
)

// maxTypedHandleLookups bounds the handles one message looks up.
const maxTypedHandleLookups = 20

// typedHandle is one candidate: the handle (lowercase) and the byte span of
// "@handle" it replaces.
type typedHandle struct {
	start, end int
	handle     string
}

// protectedSpans lists the byte ranges of body a typed handle is never
// converted inside.
func protectedSpans(body string) [][]int {
	var spans [][]int
	for _, re := range []*regexp.Regexp{fencedCodePattern, inlineCodePattern, channelMentionRE, bareURLRE, linkDestinationPattern, autolinkPattern} {
		spans = append(spans, re.FindAllStringIndex(body, -1)...)
	}
	for _, t := range ScanMentions(body) {
		spans = append(spans, []int{t.Start, t.End})
	}
	return spans
}

func insideSpan(spans [][]int, pos int) bool {
	return slices.ContainsFunc(spans, func(s []int) bool { return pos >= s[0] && pos < s[1] })
}

// typedHandles finds the bare "@word" candidates outside protected spans. A
// word with trailing '.', '-' or '_' ("ping @oncall.") is offered both whole
// and trimmed, whole first.
func typedHandles(body string) []typedHandle {
	if !strings.Contains(body, "@") {
		return nil
	}
	spans := protectedSpans(body)
	var out []typedHandle
	for _, m := range typedHandlePattern.FindAllStringSubmatchIndex(body, -1) {
		at := m[4] - 1
		if insideSpan(spans, at) {
			continue
		}
		word := strings.ToLower(body[m[4]:m[5]])
		if reservedUserGroupHandles[word] {
			continue
		}
		out = append(out, typedHandle{start: at, end: m[5], handle: word})
		// The word starts with a letter or digit, so trimming never empties it.
		if trimmed := strings.TrimRight(word, "._-"); trimmed != word {
			out = append(out, typedHandle{start: at, end: at + 1 + len(trimmed), handle: trimmed})
		}
	}
	return out
}

// CanonicalizeMentions rewrites every bare "@handle" in body that names an
// enabled group into the group's mention token. Guests' messages are left
// alone (guests can't mention groups), and so is a body the tokens would push
// past the length cap. A failed lookup leaves the body as typed: the message
// still sends.
func (s *UserGroupService) CanonicalizeMentions(ctx context.Context, authorID, body string) string {
	candidates := typedHandles(body)
	if len(candidates) == 0 {
		return body
	}
	var handles []string
	for _, c := range candidates {
		if !slices.Contains(handles, c.handle) && len(handles) < maxTypedHandleLookups {
			handles = append(handles, c.handle)
		}
	}
	if guest, err := s.isGuest(ctx, authorID); err != nil || guest {
		if err != nil {
			slog.WarnContext(ctx, "user group: typed handles left as text", "error", err)
		}
		return body
	}
	groups, err := s.handleGroups(ctx, handles)
	if err != nil {
		slog.WarnContext(ctx, "user group: typed handles left as text", "error", err)
		return body
	}
	out := rewriteTypedHandles(body, candidates, groups)
	if utf8.RuneCountInString(out) > limits.MaxMessageBodyChars {
		return body
	}
	return out
}

// rewriteTypedHandles replaces each candidate whose handle resolved, the
// whole word winning over its trimmed form at the same position.
func rewriteTypedHandles(body string, candidates []typedHandle, groups map[string]*model.UserGroupDetail) string {
	var b strings.Builder
	cursor := 0
	for _, c := range candidates {
		g, ok := groups[c.handle]
		if !ok || c.start < cursor {
			continue
		}
		b.WriteString(body[cursor:c.start])
		b.WriteString("@[" + g.ID + "|" + g.Handle + "]")
		cursor = c.end
	}
	b.WriteString(body[cursor:])
	return b.String()
}
