package service

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/msgraph"
	"github.com/DigitalTolk/ex/internal/store"
)

// stubMeetingCreator records the meeting request and returns a canned result.
type stubMeetingCreator struct {
	meeting      *msgraph.OnlineMeeting
	err          error
	gotOrganizer string
	gotReq       *msgraph.OnlineMeetingRequest
}

func (s *stubMeetingCreator) CreateOnlineMeeting(_ context.Context, organizerKey string, req msgraph.OnlineMeetingRequest) (*msgraph.OnlineMeeting, error) {
	s.gotOrganizer = organizerKey
	s.gotReq = &req
	return s.meeting, s.err
}

// stubMeetingSender records the posted message call.
type stubMeetingSender struct {
	msg     *model.Message
	err     error
	gotUser string
	gotBody string
	gotType string
	gotID   string
}

func (s *stubMeetingSender) Send(_ context.Context, userID, parentID, parentType, body, parentMessageID string, _ ...string) (*model.Message, error) {
	s.gotUser, s.gotID, s.gotType, s.gotBody = userID, parentID, parentType, body
	if parentMessageID != "" {
		return nil, errors.New("commands must post top-level messages")
	}
	return s.msg, s.err
}

// stubMeetingUsers resolves organizer + attendee users from a fixed map.
type stubMeetingUsers struct {
	users       map[string]*model.User
	getErr      error
	gotBatchIDs []string
}

func (s *stubMeetingUsers) GetByID(_ context.Context, id string) (*model.User, error) {
	if s.getErr != nil {
		return nil, s.getErr
	}
	u, ok := s.users[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	return u, nil
}

func (s *stubMeetingUsers) GetBatch(_ context.Context, ids []string) ([]*model.User, error) {
	s.gotBatchIDs = append([]string(nil), ids...)
	out := make([]*model.User, 0, len(ids))
	for _, id := range ids {
		if u, ok := s.users[id]; ok {
			out = append(out, u)
		}
	}
	return out, nil
}

type teamsMeetingEnv struct {
	cmd           *TeamsMeetingCommand
	meetings      *stubMeetingCreator
	sender        *stubMeetingSender
	users         *stubMeetingUsers
	memberships   *mockMembershipStore
	conversations *mockConversationStore
	channels      *mockChannelStore
}

func setupTeamsMeeting() *teamsMeetingEnv {
	env := &teamsMeetingEnv{
		meetings: &stubMeetingCreator{meeting: &msgraph.OnlineMeeting{
			ID:      "meet-1",
			JoinURL: "https://teams.microsoft.com/l/meetup-join/xyz",
		}},
		sender:        &stubMeetingSender{msg: &model.Message{ID: "msg-1"}},
		users:         &stubMeetingUsers{users: map[string]*model.User{}},
		memberships:   newMockMembershipStore(),
		conversations: newMockConversationStore(),
		channels:      newMockChannelStore(),
	}
	env.cmd = NewTeamsMeetingCommand(TeamsMeetingDeps{
		Meetings:      env.meetings,
		Sender:        env.sender,
		Users:         env.users,
		Memberships:   env.memberships,
		Conversations: env.conversations,
		Channels:      env.channels,
	})
	return env
}

func (e *teamsMeetingEnv) addChannelMember(channelID, userID string) {
	e.memberships.memberships[channelID+"#"+userID] = &model.ChannelMembership{ChannelID: channelID, UserID: userID}
}

func TestTeamsMeetingInfo(t *testing.T) {
	info := setupTeamsMeeting().cmd.Info()
	if info.Name != "mstmeetings" || info.Description == "" {
		t.Errorf("Info() = %+v", info)
	}
}

func TestTeamsMeetingChannelHappyPath(t *testing.T) {
	env := setupTeamsMeeting()
	env.channels.channels["chan-1"] = &model.Channel{ID: "chan-1", Slug: "general"}
	env.addChannelMember("chan-1", "alice")
	env.addChannelMember("chan-1", "bob")
	env.addChannelMember("chan-1", "carol")
	env.users.users["alice"] = &model.User{ID: "alice", Email: "alice@example.com", MSObjectID: "oid-alice"}
	env.users.users["bob"] = &model.User{ID: "bob", Email: "bob@example.com"}
	env.users.users["carol"] = &model.User{ID: "carol"} // no email → skipped

	msg, err := env.cmd.Run(context.Background(), CommandRequest{UserID: "alice", ParentID: "chan-1", ParentType: ParentChannel})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if msg == nil || msg.ID != "msg-1" {
		t.Fatalf("msg = %+v, want the sender's message", msg)
	}

	if env.meetings.gotOrganizer != "oid-alice" {
		t.Errorf("organizer = %q, want the invoker's AAD object id", env.meetings.gotOrganizer)
	}
	if got := env.meetings.gotReq.Subject; got != "Teams meeting · ~general" {
		t.Errorf("subject = %q", got)
	}
	if got := env.meetings.gotReq.AttendeeUPNs; !slices.Equal(got, []string{"bob@example.com"}) {
		t.Errorf("attendees = %v, want bob only (invoker excluded, no-email skipped)", got)
	}
	if d := env.meetings.gotReq.EndAt.Sub(env.meetings.gotReq.StartAt); d != teamsMeetingDuration {
		t.Errorf("meeting duration = %v, want %v", d, teamsMeetingDuration)
	}
	if time.Since(env.meetings.gotReq.StartAt) > time.Minute {
		t.Errorf("meeting start %v not ~now", env.meetings.gotReq.StartAt)
	}

	if env.sender.gotUser != "alice" || env.sender.gotID != "chan-1" || env.sender.gotType != ParentChannel {
		t.Errorf("posted as %q into %s/%s", env.sender.gotUser, env.sender.gotType, env.sender.gotID)
	}
	if !strings.Contains(env.sender.gotBody, "[Join the meeting](https://teams.microsoft.com/l/meetup-join/xyz)") {
		t.Errorf("body = %q, want markdown join link", env.sender.gotBody)
	}

	// GetBatch must not have been asked for the invoker.
	if slices.Contains(env.users.gotBatchIDs, "alice") {
		t.Errorf("batch ids %v include the invoker", env.users.gotBatchIDs)
	}
}

func TestTeamsMeetingOrganizerFallsBackToEmail(t *testing.T) {
	env := setupTeamsMeeting()
	env.channels.channels["chan-1"] = &model.Channel{ID: "chan-1", Slug: "general"}
	env.addChannelMember("chan-1", "alice")
	env.users.users["alice"] = &model.User{ID: "alice", Email: "alice@example.com"}

	if _, err := env.cmd.Run(context.Background(), CommandRequest{UserID: "alice", ParentID: "chan-1", ParentType: ParentChannel}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if env.meetings.gotOrganizer != "alice@example.com" {
		t.Errorf("organizer = %q, want email fallback", env.meetings.gotOrganizer)
	}
}

func TestTeamsMeetingChannelNonMemberForbidden(t *testing.T) {
	env := setupTeamsMeeting()
	env.addChannelMember("chan-1", "bob")

	_, err := env.cmd.Run(context.Background(), CommandRequest{UserID: "alice", ParentID: "chan-1", ParentType: ParentChannel})
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}
}

func TestTeamsMeetingChannelMemberListError(t *testing.T) {
	env := setupTeamsMeeting()
	env.memberships.listMembersErr = errors.New("dynamo down")

	if _, err := env.cmd.Run(context.Background(), CommandRequest{UserID: "alice", ParentID: "chan-1", ParentType: ParentChannel}); err == nil {
		t.Fatal("expected error when the member list is unavailable")
	}
}

func TestTeamsMeetingConversationHappyPath(t *testing.T) {
	env := setupTeamsMeeting()
	env.conversations.conversations["conv-1"] = &model.Conversation{ID: "conv-1", ParticipantIDs: []string{"alice", "bob"}}
	env.users.users["alice"] = &model.User{ID: "alice", Email: "alice@example.com", MSObjectID: "oid-alice"}
	env.users.users["bob"] = &model.User{ID: "bob", Email: "bob@example.com"}

	msg, err := env.cmd.Run(context.Background(), CommandRequest{UserID: "alice", ParentID: "conv-1", ParentType: ParentConversation})
	if err != nil || msg == nil {
		t.Fatalf("Run = (%v, %v)", msg, err)
	}
	if env.meetings.gotReq.Subject != "Teams meeting" {
		t.Errorf("subject = %q, want generic conversation subject", env.meetings.gotReq.Subject)
	}
	if got := env.meetings.gotReq.AttendeeUPNs; !slices.Equal(got, []string{"bob@example.com"}) {
		t.Errorf("attendees = %v", got)
	}
	if env.sender.gotType != ParentConversation {
		t.Errorf("posted into parentType %q", env.sender.gotType)
	}
}

func TestTeamsMeetingConversationNonParticipantForbidden(t *testing.T) {
	env := setupTeamsMeeting()
	env.conversations.conversations["conv-1"] = &model.Conversation{ID: "conv-1", ParticipantIDs: []string{"bob", "carol"}}

	_, err := env.cmd.Run(context.Background(), CommandRequest{UserID: "alice", ParentID: "conv-1", ParentType: ParentConversation})
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}
}

func TestTeamsMeetingConversationLoadError(t *testing.T) {
	env := setupTeamsMeeting()
	env.conversations.getErr = errors.New("dynamo down")

	if _, err := env.cmd.Run(context.Background(), CommandRequest{UserID: "alice", ParentID: "conv-1", ParentType: ParentConversation}); err == nil {
		t.Fatal("expected error when the conversation is unavailable")
	}
}

func TestTeamsMeetingOrganizerResolutionError(t *testing.T) {
	env := setupTeamsMeeting()
	env.addChannelMember("chan-1", "alice")
	env.users.getErr = errors.New("store down")

	if _, err := env.cmd.Run(context.Background(), CommandRequest{UserID: "alice", ParentID: "chan-1", ParentType: ParentChannel}); err == nil || !strings.Contains(err.Error(), "resolve organizer") {
		t.Fatalf("err = %v, want resolve organizer error", err)
	}
}

func TestTeamsMeetingGraphFailure(t *testing.T) {
	env := setupTeamsMeeting()
	env.channels.channels["chan-1"] = &model.Channel{ID: "chan-1", Slug: "general"}
	env.addChannelMember("chan-1", "alice")
	env.users.users["alice"] = &model.User{ID: "alice", Email: "alice@example.com"}
	env.meetings.meeting = nil
	env.meetings.err = errors.New("graph 403")

	if _, err := env.cmd.Run(context.Background(), CommandRequest{UserID: "alice", ParentID: "chan-1", ParentType: ParentChannel}); err == nil || !strings.Contains(err.Error(), "teams meeting: create") {
		t.Fatalf("err = %v, want meeting-create error", err)
	}
	if env.sender.gotUser != "" {
		t.Error("no message must be posted when the meeting was not created")
	}
}

func TestTeamsMeetingSubjectFallsBackWhenChannelReadFails(t *testing.T) {
	env := setupTeamsMeeting()
	env.channels.getErr = errors.New("dynamo down")
	env.addChannelMember("chan-1", "alice")
	env.users.users["alice"] = &model.User{ID: "alice", Email: "alice@example.com"}

	if _, err := env.cmd.Run(context.Background(), CommandRequest{UserID: "alice", ParentID: "chan-1", ParentType: ParentChannel}); err != nil {
		t.Fatalf("Run: %v (subject lookup must fail open)", err)
	}
	if env.meetings.gotReq.Subject != "Teams meeting" {
		t.Errorf("subject = %q, want generic fallback", env.meetings.gotReq.Subject)
	}
}
