package service

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/msgraph"
)

// teamsMeetingDuration is the scheduled length of an ad-hoc /mstmeetings
// meeting. Cosmetic — Teams meetings don't end at the scheduled time — but
// Graph requires an end.
const teamsMeetingDuration = time.Hour

// MeetingCreator is the slice of the Graph client the command needs, as an
// interface so tests stub meeting creation without HTTP.
type MeetingCreator interface {
	CreateOnlineMeeting(ctx context.Context, organizerKey string, req msgraph.OnlineMeetingRequest) (*msgraph.OnlineMeeting, error)
}

// MeetingMessageSender posts the join-link message into the chat; satisfied
// by MessageService.Send (which emits message.new and runs the normal
// notification pipeline).
type MeetingMessageSender interface {
	Send(ctx context.Context, userID, parentID, parentType, body, parentMessageID string, attachmentIDs ...string) (*model.Message, error)
}

// MeetingUserResolver resolves users for organizer/attendee data; satisfied
// by UserService (cache-first).
type MeetingUserResolver interface {
	GetByID(ctx context.Context, id string) (*model.User, error)
	GetBatch(ctx context.Context, ids []string) ([]*model.User, error)
}

// TeamsMeetingDeps declares the full dependency surface of the /mstmeetings
// command in one place (the MessageServiceDeps idiom).
type TeamsMeetingDeps struct {
	Meetings      MeetingCreator
	Sender        MeetingMessageSender
	Users         MeetingUserResolver
	Memberships   MembershipStore
	Conversations ConversationStore
	Channels      ChannelStore
}

// TeamsMeetingCommand implements /mstmeetings: it creates a Microsoft Teams
// online meeting organized by the invoking user, invites everyone in the
// current chat (channel members or conversation participants), and posts the
// join link into the chat as the invoker. Because the workspace signs in
// through Microsoft 365 already, no account linking is required — the app
// creates the meeting via Graph application permissions.
type TeamsMeetingCommand struct {
	deps TeamsMeetingDeps
}

// NewTeamsMeetingCommand builds the command from its dependency set.
func NewTeamsMeetingCommand(deps TeamsMeetingDeps) *TeamsMeetingCommand {
	return &TeamsMeetingCommand{deps: deps}
}

// Info describes the command to the composer autocomplete.
func (t *TeamsMeetingCommand) Info() CommandInfo {
	return CommandInfo{
		Name:        "mstmeetings",
		Description: "Start a Microsoft Teams meeting and share the join link here",
	}
}

// Run executes the command. Membership doubles as the access check: the
// member list (channel) or participant list (conversation) is needed for the
// invite anyway, and the invoker must appear in it.
func (t *TeamsMeetingCommand) Run(ctx context.Context, req CommandRequest) (*model.Message, error) {
	memberIDs, err := t.chatMemberIDs(ctx, req)
	if err != nil {
		return nil, err
	}

	organizer, err := t.deps.Users.GetByID(ctx, req.UserID)
	if err != nil {
		return nil, fmt.Errorf("teams meeting: resolve organizer: %w", err)
	}
	organizerKey := organizer.MSObjectID
	if organizerKey == "" {
		organizerKey = organizer.Email
	}

	now := time.Now()
	meeting, err := t.deps.Meetings.CreateOnlineMeeting(ctx, organizerKey, msgraph.OnlineMeetingRequest{
		Subject:      t.subject(ctx, req),
		StartAt:      now,
		EndAt:        now.Add(teamsMeetingDuration),
		AttendeeUPNs: t.attendeeUPNs(ctx, memberIDs, req.UserID),
	})
	if err != nil {
		return nil, fmt.Errorf("teams meeting: create: %w", err)
	}

	body := fmt.Sprintf("Started a **Teams meeting** — [Join the meeting](%s)", meeting.JoinURL)
	return t.deps.Sender.Send(ctx, req.UserID, req.ParentID, req.ParentType, body, "")
}

// chatMemberIDs returns everyone in the target chat, verifying the invoker
// belongs to it (ErrForbidden otherwise). CommandService.Run has already
// validated ParentType, so a channel/conversation split is exhaustive.
func (t *TeamsMeetingCommand) chatMemberIDs(ctx context.Context, req CommandRequest) ([]string, error) {
	if req.ParentType == ParentChannel {
		members, err := t.deps.Memberships.ListMembers(ctx, req.ParentID)
		if err != nil {
			return nil, fmt.Errorf("teams meeting: list channel members: %w", err)
		}
		ids := make([]string, 0, len(members))
		invokerIsMember := false
		for _, m := range members {
			ids = append(ids, m.UserID)
			if m.UserID == req.UserID {
				invokerIsMember = true
			}
		}
		if !invokerIsMember {
			return nil, fmt.Errorf("teams meeting: not a channel member: %w", ErrForbidden)
		}
		return ids, nil
	}

	conv, err := t.deps.Conversations.GetConversation(ctx, req.ParentID)
	if err != nil {
		return nil, fmt.Errorf("teams meeting: get conversation: %w", err)
	}
	if !slices.Contains(conv.ParticipantIDs, req.UserID) {
		return nil, fmt.Errorf("teams meeting: not a conversation participant: %w", ErrForbidden)
	}
	return conv.ParticipantIDs, nil
}

// subject names the meeting after the chat. Cosmetic, so it fails open to a
// generic subject rather than blocking the meeting on a channel read.
func (t *TeamsMeetingCommand) subject(ctx context.Context, req CommandRequest) string {
	if req.ParentType == ParentChannel {
		ch, err := t.deps.Channels.GetChannel(ctx, req.ParentID)
		if err != nil {
			slog.Warn("teams meeting: channel lookup for subject failed; using generic subject", "error", err)
			return "Teams meeting"
		}
		return "Teams meeting · ~" + ch.Slug
	}
	return "Teams meeting"
}

// attendeeUPNs maps the chat's members to invitable addresses. Best-effort by
// design: the join link lands in the chat for everyone regardless, so a
// member the batch can't resolve (or with no email) is skipped, not fatal.
// The invoker is excluded — they're the organizer.
func (t *TeamsMeetingCommand) attendeeUPNs(ctx context.Context, memberIDs []string, invokerID string) []string {
	others := make([]string, 0, len(memberIDs))
	for _, id := range memberIDs {
		if id != invokerID {
			others = append(others, id)
		}
	}
	// UserService.GetBatch is best-effort and never returns an error (failed
	// rows are dropped) — same contract the users/batch handler relies on.
	users, _ := t.deps.Users.GetBatch(ctx, others)
	upns := make([]string, 0, len(users))
	for _, u := range users {
		if u.Email != "" {
			upns = append(upns, u.Email)
		}
	}
	return upns
}
