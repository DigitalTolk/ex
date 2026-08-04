package service

import (
	"context"
	"strings"
	"unicode"

	"github.com/DigitalTolk/ex/internal/model"
)

// Mattermost payload compatibility.
//
// ex speaks its own /api/v1, but the three integration *payloads* third-party
// bots actually depend on — outgoing webhooks, slash commands, and interactive
// message actions — are emitted in Mattermost's exact wire shape so an existing
// MM integration receiver works unchanged. See docs/rfc-generic-bots-mcp.md §2.
//
// Two ex concepts have no MM equivalent and are mapped here, in one place, so
// every payload agrees:
//
//   - **Teams.** ex has no teams; MM sends team_id/team_domain on every
//     integration payload. ex reports a single synthetic team (below). Receivers
//     that merely echo or ignore the field are unaffected; receivers that route
//     by team see one stable team.
//   - **Usernames.** ex users have an email and a display name, no username
//     (docs/rfc-generic-bots-mcp.md §9). MM's user_name is derived from the email
//     local part — see MMUsername. It is a best-effort label for display, NOT an
//     identifier: nothing in ex resolves a user *from* it, and it is not
//     guaranteed unique. Receivers must key on user_id.

const (
	// MMSyntheticTeamID is the team_id reported to MM-shaped receivers. It is
	// deliberately 26 lowercase alphanumerics — the shape MM's own client
	// libraries validate IDs against — so a driver that checks the field's form
	// accepts it instead of erroring on a malformed id.
	MMSyntheticTeamID = "exdefaultteam0000000000000"
	// MMSyntheticTeamDomain is the team_domain (URL slug) counterpart.
	MMSyntheticTeamDomain = "ex"
)

// MM channel_type values. MM distinguishes open/private/direct/group channels;
// ex has channels (with a visibility) and conversations (DM/group DM).
const (
	mmChannelTypeOpen    = "O"
	mmChannelTypePrivate = "P"
	mmChannelTypeDirect  = "D"
)

// MMResponseTypeEphemeral / MMResponseTypeInChannel are MM's two response_type
// values. Ephemeral means "show only to the invoking user"; in_channel means
// "post it for everyone".
const (
	MMResponseTypeEphemeral = "ephemeral"
	MMResponseTypeInChannel = "in_channel"
)

// BotContextResolver supplies the human-readable names MM-shaped payloads carry
// but ex's core message path does not hold: a channel's name/slug and a user's
// derived username/display name. Optional everywhere — when unset or when a
// lookup fails, the corresponding fields are sent empty rather than failing the
// dispatch, because an integration's *identifiers* (the ids) are what it needs
// to act; the names are cosmetic.
type BotContextResolver interface {
	// ChannelContext returns the display name and URL slug of a channel or
	// conversation, plus its MM channel_type letter.
	ChannelContext(ctx context.Context, parentID, parentType string) (name, slug, mmType string)
	// UserContext returns the MM-style username and display name for a user.
	UserContext(ctx context.Context, userID string) (username, displayName string)
}

// MMChannelTypeFor maps an ex parent type to MM's channel_type letter. A
// conversation is MM's direct channel; a channel defaults to open because ex's
// per-channel visibility lives on the Channel row, which the resolver supplies
// when it is available.
func MMChannelTypeFor(parentType string) string {
	if parentType == ParentConversation {
		return mmChannelTypeDirect
	}
	return mmChannelTypeOpen
}

// MMChannelTypeForVisibility maps an ex channel's own type to MM's letter.
func MMChannelTypeForVisibility(t model.ChannelType) string {
	if t == model.ChannelTypePrivate {
		return mmChannelTypePrivate
	}
	return mmChannelTypeOpen
}

// mmUsernameMinLen / mmUsernameMaxLen bound a derived username to MM's own
// range, so a receiver validating the field's length accepts it.
const (
	mmUsernameMinLen = 3
	mmUsernameMaxLen = 22
)

// MMUsername derives an MM-shaped username for an ex user from their email,
// falling back to the display name and then the user id. MM usernames are
// lowercase and limited to letters, digits, and ".-_", so anything else is
// folded to "-" and runs are collapsed.
//
// This is a LABEL, not an identifier — see the package note above. Two users
// with the same email local part at different domains derive the same username.
func MMUsername(email, displayName, userID string) string {
	for _, candidate := range []string{emailLocalPart(email), displayName, userID} {
		if u := sanitizeMMUsername(candidate); u != "" {
			return u
		}
	}
	return "user"
}

func emailLocalPart(email string) string {
	if at := strings.IndexByte(email, '@'); at > 0 {
		return email[:at]
	}
	return ""
}

func sanitizeMMUsername(raw string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(strings.TrimSpace(raw)) {
		switch {
		case unicode.IsLetter(r) && r < unicode.MaxASCII, unicode.IsDigit(r) && r < unicode.MaxASCII,
			r == '.', r == '-', r == '_':
			b.WriteRune(r)
			lastDash = false
		default:
			// Collapse any run of unsupported runes (spaces, accents, CJK) into a
			// single separator instead of dropping them, so "Anna Ström" reads as
			// "anna-str-m" rather than "annastrm".
			if !lastDash && b.Len() > 0 {
				b.WriteByte('-')
				lastDash = true
			}
		}
		if b.Len() >= mmUsernameMaxLen {
			break
		}
	}
	out := strings.Trim(b.String(), "-._")
	if len(out) < mmUsernameMinLen {
		return ""
	}
	return out
}

// mmContext is the resolved naming context for one MM-shaped payload. Built once
// per dispatch so the channel and user lookups happen a single time even though
// several payload fields derive from them.
type mmContext struct {
	ChannelName string
	ChannelSlug string
	ChannelType string
	UserName    string
	DisplayName string
}

// resolveMMContext looks up the cosmetic naming fields for a payload. A nil
// resolver (or any failed lookup) yields zero values plus the parent-type
// default for channel_type — never an error, per BotContextResolver's contract.
func resolveMMContext(ctx context.Context, r BotContextResolver, parentID, parentType, userID string) mmContext {
	out := mmContext{ChannelType: MMChannelTypeFor(parentType)}
	if r == nil {
		return out
	}
	name, slug, mmType := r.ChannelContext(ctx, parentID, parentType)
	out.ChannelName, out.ChannelSlug = name, slug
	if mmType != "" {
		out.ChannelType = mmType
	}
	if userID != "" {
		out.UserName, out.DisplayName = r.UserContext(ctx, userID)
	}
	return out
}
