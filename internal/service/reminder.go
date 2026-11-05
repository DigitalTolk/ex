package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/DigitalTolk/ex/internal/store"
)

// reminderMaxHorizon caps how far in the future a reminder may be scheduled. A
// year is generous for "remind me" while rejecting obviously bogus timestamps.
const reminderMaxHorizon = 365 * 24 * time.Hour

// reminderClaimBatch bounds how many due reminders are claimed per poll
// iteration; the poller loops until a partial batch drains the queue.
const reminderClaimBatch = 100

// maxReminderPeople caps how many people one reminder may tag besides its
// owner.
const maxReminderPeople = 20

// maxReminderNote caps a reminder's note, in characters.
const maxReminderNote = 500

// The reminder bot's name and avatar emoji, on every message it posts.
const (
	reminderBotName  = "Reminder"
	reminderBotEmoji = "alarm_clock"
)

// ErrReminderTimeInvalid is returned when a reminder's fire time is not strictly
// in the future, or is further out than reminderMaxHorizon.
var ErrReminderTimeInvalid = errors.New("reminder: remind time must be in the future")

// ReminderStore is the persistence the reminder service needs.
type ReminderStore interface {
	ScheduleReminder(ctx context.Context, r *model.Reminder) error
	CancelReminder(ctx context.Context, userID, id string) (bool, error)
	GetPendingReminder(ctx context.Context, userID, id string) (*model.Reminder, error)
	RescheduleReminder(ctx context.Context, r *model.Reminder) error
	ListPendingReminders(ctx context.Context, userID string) ([]*model.Reminder, error)
	ClaimDueReminders(ctx context.Context, limit int) ([]*model.Reminder, error)
	// CancelRemindersForParent returns how many it cancelled;
	// CancelRemindersForMessages and UpdateReminderPreview return the owners
	// whose reminders they touched.
	CancelRemindersForParent(ctx context.Context, userID, parentID string) (int, error)
	CancelRemindersForMessages(ctx context.Context, messageIDs []string) ([]string, error)
	UpdateReminderPreview(ctx context.Context, messageID, preview string) ([]string, error)
	// CancelAllRemindersForUser drops every reminder a user has queued, due or
	// not, returning how many there were.
	CancelAllRemindersForUser(ctx context.Context, userID string) (int, error)
}

// ReminderOwnerLookup resolves reminder owners, so a deactivated owner's
// reminders are dropped instead of fired. Implemented by the user store.
type ReminderOwnerLookup interface {
	GetUsersByIDs(ctx context.Context, ids []string) ([]*model.User, error)
}

// ReminderMessageStore loads the source message so a reminder can carry a preview
// and be validated against an existing message.
type ReminderMessageStore interface {
	GetMessage(ctx context.Context, parentID, msgID string) (*model.Message, error)
}

// ReminderAccessChecker gates scheduling to parents the user can actually see.
type ReminderAccessChecker interface {
	CheckAccess(ctx context.Context, userID, parentID, parentType string) error
}

// ActivityAdder appends a fired reminder to the owner's activity stream.
type ActivityAdder interface {
	AddItem(ctx context.Context, userID string, item *model.ActivityItem)
}

// DirectNotifier delivers a self-targeted alert (desktop + mobile fallback).
type DirectNotifier interface {
	NotifyDirect(ctx context.Context, userID string, notif Notification)
}

// ReminderPoster posts the reminder bot's messages (MessageService).
type ReminderPoster interface {
	SendReminder(ctx context.Context, in WebhookMessageInput) (*model.Message, error)
}

// ReminderBotProvisioner creates the reminder bot's account on first use.
type ReminderBotProvisioner interface {
	EnsureBotUser(ctx context.Context, botID, displayName string) (*model.User, error)
}

// ReminderDMOpener opens the bot's DM with a reminder's owner.
type ReminderDMOpener interface {
	GetOrCreateDM(ctx context.Context, userA, userB string) (*model.Conversation, error)
}

// ReminderInput is the client-supplied request to schedule a reminder.
type ReminderInput struct {
	MessageID   string    `json:"messageID"`
	ParentID    string    `json:"parentID"`
	ParentType  string    `json:"parentType"`
	ChannelSlug string    `json:"channelSlug"`
	RemindAt    time.Time `json:"remindAt"`
	// UserIDs are people to tag besides the owner when it comes due.
	UserIDs []string `json:"userIDs"`
	// Note is optional context, shown with the reminder.
	Note string `json:"note"`
}

// ReminderUpdate is an edit of a pending reminder: its new time, people and
// note.
type ReminderUpdate struct {
	RemindAt time.Time `json:"remindAt"`
	UserIDs  []string  `json:"userIDs"`
	Note     string    `json:"note"`
}

// ReminderService schedules per-message reminders and fires them at their due
// time into the owner's activity stream + a desktop/mobile alert.
type ReminderService struct {
	store    ReminderStore
	messages ReminderMessageStore
	access   ReminderAccessChecker
	activity ActivityAdder
	notifier DirectNotifier
	events   Publisher
	owners   ReminderOwnerLookup
	mentions MentionResolver
	poster   ReminderPoster
	bots     ReminderBotProvisioner
	dms      ReminderDMOpener
	baseURL  string
	now      func() time.Time
}

// NewReminderService builds a ReminderService. activity and notifier are wired
// after construction (SetDelivery) to avoid a constructor cycle with the
// activity/notification services.
func NewReminderService(s ReminderStore, messages ReminderMessageStore, access ReminderAccessChecker) *ReminderService {
	return &ReminderService{store: s, messages: messages, access: access, now: time.Now}
}

// SetDelivery wires the fired-reminder delivery channels.
func (s *ReminderService) SetDelivery(activity ActivityAdder, notifier DirectNotifier) {
	s.activity = activity
	s.notifier = notifier
}

// SetBot wires the reminder bot: a reminder comes due as the bot's reply to
// the message tagging its people, or as the bot's DM to its owner. baseURL
// makes the DM's link to the message absolute, so it unfurls as a preview.
func (s *ReminderService) SetBot(poster ReminderPoster, bots ReminderBotProvisioner, dms ReminderDMOpener, baseURL string) {
	s.poster = poster
	s.bots = bots
	s.dms = dms
	s.baseURL = strings.TrimRight(baseURL, "/")
}

// SetPublisher wires the reminders.changed event, so every tab and device
// keeps its pending list current.
func (s *ReminderService) SetPublisher(p Publisher) { s.events = p }

// SetOwnerLookup wires the owner check that drops a deactivated user's
// reminders when they come due — no alert, no mobile push job.
func (s *ReminderService) SetOwnerLookup(o ReminderOwnerLookup) { s.owners = o }

// SetMentionResolver names mentioned users and channels in reminder previews
// (the Activity row and the alert/push body) by their current names.
// Optional — without it mentions read as typed.
func (s *ReminderService) SetMentionResolver(r MentionResolver) { s.mentions = r }

// CancelAllForUser stops every reminder a user has queued — on deactivation,
// so nothing is left to come due for an account that can't sign in.
func (s *ReminderService) CancelAllForUser(ctx context.Context, userID string) error {
	n, err := s.store.CancelAllRemindersForUser(ctx, userID)
	if n > 0 {
		slog.InfoContext(ctx, "reminders cancelled for deactivated user", "userID", userID, "count", n)
	}
	return err
}

// changed tells userID's tabs and devices to refetch their pending reminders.
func (s *ReminderService) changed(ctx context.Context, userID string) {
	if s.events != nil {
		events.Publish(ctx, s.events, pubsub.UserChannel(userID), events.EventRemindersChanged, map[string]any{})
	}
}

// A pending reminder carries a copy of its message's text, so losing access to
// the channel, or the message being deleted or edited, has to reach it. The
// channel and message services call these hooks (as they call the activity
// ones); the Redis work runs off the request path and each touched owner is
// told. A failure is logged — the due-time checks in fire still keep a
// reminder from alerting about a message its owner can no longer see.

// ParentLeft cancels the pending reminders of users who can no longer read a
// channel or conversation (they left, were removed, or it was archived). One
// goroutine works through the users in turn, so archiving a large channel
// doesn't start one per member.
func (s *ReminderService) ParentLeft(ctx context.Context, userIDs []string, parentID string) {
	safe.Go(func() {
		for _, userID := range userIDs {
			s.parentLeft(ctx, userID, parentID)
		}
	})
}

func (s *ReminderService) parentLeft(ctx context.Context, userID, parentID string) {
	bg, cancel := detachedContext(ctx)
	defer cancel()
	n, err := s.store.CancelRemindersForParent(bg, userID, parentID)
	if err != nil {
		slog.WarnContext(ctx, "reminder parent cleanup failed", "userID", userID, "parentID", parentID, "error", err)
		return
	}
	if n > 0 {
		s.changed(bg, userID)
	}
}

// MessagesDeleted cancels every pending reminder about deleted messages,
// whoever set it.
func (s *ReminderService) MessagesDeleted(ctx context.Context, parentID, _ string, messageIDs []string) {
	if len(messageIDs) == 0 {
		return
	}
	s.detached(ctx, func(bg context.Context) {
		owners, err := s.store.CancelRemindersForMessages(bg, messageIDs)
		if err != nil {
			slog.WarnContext(ctx, "reminder delete sync failed", "parentID", parentID, "error", err)
			return
		}
		for _, userID := range owners {
			s.changed(bg, userID)
		}
	})
}

// MessageEdited gives every pending reminder about an edited message its new
// preview — text edited out must not live on in a reminder. The message is
// read again on the hook's own goroutine, so two quick edits whose hooks run
// out of order both write the latest text rather than the last hook winning.
// A message that is gone by then is left to the delete hook.
func (s *ReminderService) MessageEdited(ctx context.Context, msg *model.Message, _ string) {
	msgID, parentID := msg.ID, msg.ParentID
	s.detached(ctx, func(bg context.Context) {
		current, err := s.messages.GetMessage(bg, parentID, msgID)
		if err != nil || current.Deleted {
			if err != nil && !errors.Is(err, store.ErrNotFound) {
				slog.WarnContext(ctx, "reminder edit sync: message read failed", "messageID", msgID, "error", err)
			}
			return
		}
		owners, err := s.store.UpdateReminderPreview(bg, msgID, messagePreview(bg, s.mentions, current))
		if err != nil {
			slog.WarnContext(ctx, "reminder edit sync failed", "messageID", msgID, "error", err)
			return
		}
		for _, userID := range owners {
			s.changed(bg, userID)
		}
	})
}

// detached runs fn on its own goroutine with a context that outlives the
// request (bounded by detachedTimeout).
func (s *ReminderService) detached(ctx context.Context, fn func(context.Context)) {
	safe.Go(func() {
		bg, cancel := detachedContext(ctx)
		defer cancel()
		fn(bg)
	})
}

// Schedule validates and persists a reminder for userID.
func (s *ReminderService) Schedule(ctx context.Context, userID string, in ReminderInput) (*model.Reminder, error) {
	if in.MessageID == "" || in.ParentID == "" {
		return nil, apperr.Invalid("reminder: message and parent required")
	}
	if in.ParentType != ParentChannel && in.ParentType != ParentConversation {
		return nil, apperr.Invalid("reminder: invalid parent type")
	}
	now := s.now()
	if err := s.checkRemindAt(in.RemindAt); err != nil {
		return nil, err
	}
	note, err := reminderNote(in.Note)
	if err != nil {
		return nil, err
	}
	if err := s.access.CheckAccess(ctx, userID, in.ParentID, in.ParentType); err != nil {
		return nil, err
	}
	people, err := s.people(ctx, userID, in.ParentID, in.ParentType, in.UserIDs)
	if err != nil {
		return nil, err
	}
	msg, err := s.messages.GetMessage(ctx, in.ParentID, in.MessageID)
	if err != nil {
		return nil, fmt.Errorf("reminder: message: %w", err)
	}
	// A message deleted while the menu was open: say so now (404) rather than
	// confirm a reminder that would be dropped silently when it comes due.
	if msg.Deleted {
		return nil, fmt.Errorf("reminder: message deleted: %w", store.ErrNotFound)
	}
	r := &model.Reminder{
		ID:         store.NewID(),
		UserID:     userID,
		MessageID:  in.MessageID,
		ParentID:   in.ParentID,
		ParentType: in.ParentType,
		// The thread root comes from the stored message, not the client: a
		// reply only renders inside its thread, so the deep link needs it.
		ParentMessageID: msg.ParentMessageID,
		ChannelSlug:     in.ChannelSlug,
		MessagePreview:  messagePreview(ctx, s.mentions, msg),
		UserIDs:         people,
		Note:            note,
		RemindAt:        in.RemindAt,
		CreatedAt:       now,
	}
	if err := s.store.ScheduleReminder(ctx, r); err != nil {
		return nil, err
	}
	s.changed(ctx, userID)
	return r, nil
}

// checkRemindAt accepts a fire time strictly in the future, within
// reminderMaxHorizon.
func (s *ReminderService) checkRemindAt(at time.Time) error {
	now := s.now()
	if !at.After(now) || at.After(now.Add(reminderMaxHorizon)) {
		return ErrReminderTimeInvalid
	}
	return nil
}

// reminderNote tidies a reminder's note: trimmed, and at most
// maxReminderNote characters.
func reminderNote(note string) (string, error) {
	note = strings.TrimSpace(note)
	if utf8.RuneCountInString(note) > maxReminderNote {
		return "", apperr.Invalid("reminder: a note is at most %d characters", maxReminderNote)
	}
	return note, nil
}

// people vets the people a reminder will tag: each once, never the owner, at
// most maxReminderPeople, and each an active person (no bot, and no agent,
// whom a mention would set to work) who can open the chat — a tag they could
// not follow would only puzzle them.
func (s *ReminderService) people(ctx context.Context, ownerID, parentID, parentType string, ids []string) ([]string, error) {
	seen := map[string]bool{ownerID: true}
	var out []string
	for _, id := range ids {
		if id = strings.TrimSpace(id); id != "" && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	if len(out) == 0 {
		return nil, nil
	}
	if len(out) > maxReminderPeople {
		return nil, apperr.Invalid("reminder: at most %d people", maxReminderPeople)
	}
	users, err := s.owners.GetUsersByIDs(ctx, out)
	if err != nil {
		return nil, fmt.Errorf("reminder: people: %w", err)
	}
	byID := make(map[string]*model.User, len(users))
	for _, u := range users {
		byID[u.ID] = u
	}
	for _, id := range out {
		u := byID[id]
		if u == nil || u.IsBot || u.IsAgent() || u.Status == "deactivated" {
			return nil, apperr.Invalid("reminder: only active people can be added")
		}
		if err := s.access.CheckAccess(ctx, id, parentID, parentType); err != nil {
			if errors.Is(err, ErrForbidden) {
				return nil, apperr.Invalid("reminder: %s can't open this conversation", u.DisplayName)
			}
			return nil, err
		}
	}
	return out, nil
}

// Update changes a pending reminder's time, people and note. Returns
// store.ErrNotFound when the user has no such pending reminder (it fired, was
// cancelled, or isn't theirs).
func (s *ReminderService) Update(ctx context.Context, userID, id string, in ReminderUpdate) (*model.Reminder, error) {
	if err := s.checkRemindAt(in.RemindAt); err != nil {
		return nil, err
	}
	note, err := reminderNote(in.Note)
	if err != nil {
		return nil, err
	}
	r, err := s.store.GetPendingReminder(ctx, userID, id)
	if err != nil {
		return nil, err
	}
	people, err := s.people(ctx, userID, r.ParentID, r.ParentType, in.UserIDs)
	if err != nil {
		return nil, err
	}
	r.RemindAt = in.RemindAt
	r.UserIDs = people
	r.Note = note
	if err := s.store.RescheduleReminder(ctx, r); err != nil {
		return nil, err
	}
	s.changed(ctx, userID)
	return r, nil
}

// ListPending returns the user's not-yet-fired reminders, minus any whose
// chat the user can no longer open. Leaving a channel cancels its reminders,
// but that cleanup is best-effort (see ParentLeft), so the list applies the
// same access rule the firing path does rather than trust it. A lookup
// failure keeps the reminder, like fire: never hide an alert over a blip.
func (s *ReminderService) ListPending(ctx context.Context, userID string) ([]*model.Reminder, error) {
	all, err := s.store.ListPendingReminders(ctx, userID)
	if err != nil {
		return nil, err
	}
	// One check per chat, not per reminder.
	forbidden := map[string]bool{}
	visible := all[:0]
	for _, r := range all {
		key := r.ParentType + ":" + r.ParentID
		if _, seen := forbidden[key]; !seen {
			forbidden[key] = errors.Is(s.access.CheckAccess(ctx, userID, r.ParentID, r.ParentType), ErrForbidden)
		}
		if !forbidden[key] {
			visible = append(visible, r)
		}
	}
	return visible, nil
}

// Cancel removes a pending reminder. Returns store.ErrNotFound when there is no
// such pending reminder for the user.
func (s *ReminderService) Cancel(ctx context.Context, userID, id string) error {
	ok, err := s.store.CancelReminder(ctx, userID, id)
	if err != nil {
		return err
	}
	if !ok {
		return store.ErrNotFound
	}
	s.changed(ctx, userID)
	return nil
}

// ProcessDue claims and fires every reminder due at or before now. Returns the
// number claimed (a reminder its owner can no longer open, or whose owner was
// deactivated, is claimed but not delivered). Safe to call concurrently across
// instances — claiming is atomic.
//
// Every owner whose reminder left the queue is told their pending list
// changed, whether it fired or was dropped — an open Activity panel would
// otherwise keep listing it as scheduled.
func (s *ReminderService) ProcessDue(ctx context.Context) (int, error) {
	claimed := 0
	for {
		due, err := s.store.ClaimDueReminders(ctx, reminderClaimBatch)
		if err != nil {
			return claimed, fmt.Errorf("reminder: claim due: %w", err)
		}
		deactivated := s.deactivatedOwners(ctx, due)
		owners := map[string]bool{}
		for _, r := range due {
			claimed++
			if deactivated[r.UserID] {
				slog.InfoContext(ctx, "reminder dropped: owner deactivated", "userID", r.UserID, "reminderID", r.ID)
				continue
			}
			s.fire(ctx, r)
			owners[r.UserID] = true
		}
		for userID := range owners {
			s.changed(ctx, userID)
		}
		if len(due) < reminderClaimBatch {
			return claimed, nil
		}
	}
}

// deactivatedOwners reports which of a batch's owners are deactivated, in one
// batched lookup. A failed lookup reports none — the reminders fire, since a
// lost reminder is worse than one sent to an account that can't read it.
func (s *ReminderService) deactivatedOwners(ctx context.Context, due []*model.Reminder) map[string]bool {
	if s.owners == nil || len(due) == 0 {
		return nil
	}
	seen := map[string]bool{}
	ids := make([]string, 0, len(due))
	for _, r := range due {
		if !seen[r.UserID] {
			seen[r.UserID] = true
			ids = append(ids, r.UserID)
		}
	}
	users, err := s.owners.GetUsersByIDs(ctx, ids)
	if err != nil {
		slog.WarnContext(ctx, "reminder owner lookup failed", "error", err)
		return nil
	}
	out := map[string]bool{}
	for _, u := range users {
		if u.Status == "deactivated" {
			out[u.ID] = true
		}
	}
	return out
}

// fire delivers a claimed reminder as the reminder bot's post (see post), or,
// when that can't be posted, privately: an activity-stream entry plus a
// desktop + mobile alert.
func (s *ReminderService) fire(ctx context.Context, r *model.Reminder) {
	// The owner may have left the channel, been removed from it, or seen it
	// archived since setting this: the alert would link to a page they can
	// no longer open. Only a definitive denial drops it — a failed check
	// still fires, since a lost reminder is worse than a dead link.
	if err := s.access.CheckAccess(ctx, r.UserID, r.ParentID, r.ParentType); errors.Is(err, ErrForbidden) {
		slog.InfoContext(ctx, "reminder dropped: owner no longer has access", "userID", r.UserID, "parentID", r.ParentID)
		return
	}
	// The message as it is now: one deleted since drops the reminder, an
	// edited one fires with its current text. This also covers reminders the
	// delete/edit sync never reached (set before the message index existed, or
	// its run failed). A failed read fires with the stored preview — a lost
	// reminder is worse than a stale one.
	msg, err := s.messages.GetMessage(ctx, r.ParentID, r.MessageID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && msg.Deleted) {
		slog.InfoContext(ctx, "reminder dropped: message deleted", "userID", r.UserID, "messageID", r.MessageID)
		return
	}
	if err == nil {
		r.MessagePreview = messagePreview(ctx, s.mentions, msg)
	}
	if err := s.post(ctx, r); err != nil {
		// A lost reminder is worse than a quiet one: alert the owner privately.
		slog.WarnContext(ctx, "reminder post failed; alerting the owner privately", "userID", r.UserID, "reminderID", r.ID, "error", err)
		s.firePrivate(ctx, r)
		return
	}
	slog.InfoContext(ctx, "reminder fired", "userID", r.UserID, "messageID", r.MessageID, "people", len(r.UserIDs))
}

// errReminderBotUnwired keeps a service without the bot on the private path.
var errReminderBotUnwired = errors.New("reminder: bot not wired")

// post delivers a reminder as the reminder bot. With people added, the bot
// replies to the message tagging the owner and every one of them who can
// still open the chat; without, it DMs the owner a link to the message.
func (s *ReminderService) post(ctx context.Context, r *model.Reminder) error {
	if s.poster == nil {
		return errReminderBotUnwired
	}
	if len(r.UserIDs) == 0 {
		return s.dmOwner(ctx, r)
	}
	root := r.ParentMessageID
	if root == "" {
		root = r.MessageID
	}
	reminder := "Reminder"
	if r.ParentMessageID != "" {
		// A reply in a long thread: point at the very message.
		reminder = s.messageLink(r, reminder)
	}
	body := "⏰ " + reminder + " for " + s.mentionList(ctx, r) + withNote(r.Note)
	_, err := s.poster.SendReminder(ctx, WebhookMessageInput{
		ParentID:        r.ParentID,
		ParentType:      r.ParentType,
		Body:            body,
		Username:        reminderBotName,
		IconEmoji:       reminderBotEmoji,
		ParentMessageID: root,
	})
	return err
}

// dmOwner sends a personal reminder as the bot's DM: a link to the message,
// which unfurls as its preview.
func (s *ReminderService) dmOwner(ctx context.Context, r *model.Reminder) error {
	bot, err := s.bots.EnsureBotUser(ctx, ReminderBotUserID(), reminderBotName)
	if err != nil {
		return fmt.Errorf("reminder: bot: %w", err)
	}
	conv, err := s.dms.GetOrCreateDM(ctx, bot.ID, r.UserID)
	if err != nil {
		return fmt.Errorf("reminder: open DM: %w", err)
	}
	body := "⏰ You asked me to remind you about " + s.messageLink(r, "this message")
	if r.Note != "" {
		body = "⏰ " + s.messageLink(r, "Reminder") + withNote(r.Note)
	}
	_, err = s.poster.SendReminder(ctx, WebhookMessageInput{
		ParentID:   conv.ID,
		ParentType: ParentConversation,
		AuthorID:   bot.ID,
		Body:       body,
		Username:   reminderBotName,
		IconEmoji:  reminderBotEmoji,
	})
	return err
}

// mentionList tags the owner, then each added person still active and able to
// open the chat. A failed lookup tags everyone: a stray tag beats a lost one.
func (s *ReminderService) mentionList(ctx context.Context, r *model.Reminder) string {
	ids := append([]string{r.UserID}, r.UserIDs...)
	names := map[string]string{}
	inactive := map[string]bool{}
	if users, err := s.owners.GetUsersByIDs(ctx, ids); err == nil {
		for _, u := range users {
			names[u.ID] = u.DisplayName
			inactive[u.ID] = u.Status == "deactivated"
		}
	}
	tags := make([]string, 0, len(ids))
	for i, id := range ids {
		if i > 0 && (inactive[id] || errors.Is(s.access.CheckAccess(ctx, id, r.ParentID, r.ParentType), ErrForbidden)) {
			continue
		}
		tags = append(tags, reminderMention(id, names[id]))
	}
	return strings.Join(tags, " ")
}

// withNote puts a reminder's note after its opening words, as what the
// reminder is ("Reminder: bring the numbers"); nothing without one.
func withNote(note string) string {
	if note == "" {
		return ""
	}
	return ": " + note
}

// reminderMention writes the "@[id|Name]" mention, its name kept clear of
// the brackets and bar the syntax uses.
func reminderMention(id, name string) string {
	name = strings.TrimSpace(strings.NewReplacer("[", "", "]", "", "|", "").Replace(name))
	if name == "" {
		name = id
	}
	return "@[" + id + "|" + name + "]"
}

// messageLink is text linked to the reminded message: the link still shows
// the message's preview card under the post, without its raw address in the
// text.
func (s *ReminderService) messageLink(r *model.Reminder, text string) string {
	return "[" + text + "](" + s.baseURL + reminderDeepLink(r) + ")"
}

// firePrivate is the reminder as only its owner sees it: an activity-stream
// entry plus a desktop + mobile alert.
func (s *ReminderService) firePrivate(ctx context.Context, r *model.Reminder) {
	now := s.now()
	if s.activity != nil {
		s.activity.AddItem(ctx, r.UserID, &model.ActivityItem{
			ID:              store.NewID(),
			Type:            model.ActivityReminder,
			CreatedAt:       now,
			MessageID:       r.MessageID,
			ParentID:        r.ParentID,
			ParentType:      r.ParentType,
			ParentMessageID: r.ParentMessageID,
			ChannelSlug:     r.ChannelSlug,
			MessagePreview:  r.MessagePreview,
		})
	}
	if s.notifier != nil {
		body := r.MessagePreview
		if body == "" {
			body = "You asked to be reminded about a message."
		}
		if r.Note != "" {
			body = r.Note + "\n" + body
		}
		s.notifier.NotifyDirect(ctx, r.UserID, Notification{
			Kind:       NotificationKindReminder,
			Title:      "Reminder",
			Body:       body,
			DeepLink:   reminderDeepLink(r),
			ParentID:   r.ParentID,
			ParentType: r.ParentType,
			MessageID:  r.MessageID,
			// Keyed by the reminder, not the message: the user may have been
			// alerted about this message minutes ago (or reminded of it
			// before), and a message-keyed alert would be deduped on desktop
			// and its mobile push dropped as a duplicate.
			AlertID:   r.ID,
			CreatedAt: now,
		})
	}
}

// reminderDeepLink builds the in-app URL the alert/activity row links to, matching
// the client's routes (buildChannelHref / buildConversationHref): channels by
// slug, conversations by id, a thread reply opening its thread via ?thread=,
// all anchored to the message via the #msg- hash.
func reminderDeepLink(r *model.Reminder) string {
	path := "/channel/" + r.ChannelSlug
	switch {
	case r.ParentType == ParentConversation:
		path = "/conversation/" + r.ParentID
	case r.ChannelSlug == "":
		path = "/channel/" + r.ParentID
	}
	if r.ParentMessageID != "" {
		path += "?thread=" + url.QueryEscape(r.ParentMessageID)
	}
	return path + "#msg-" + r.MessageID
}
