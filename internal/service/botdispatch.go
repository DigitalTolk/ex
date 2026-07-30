package service

import (
	"context"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/safe"
)

// Generic in-chat bot dispatch. A message that @mentions a registered bot (or is
// a reply in a thread that bot owns) is routed, off the send path, to the bot's
// handler; the reply is posted back as that bot. This is the platform seam that
// replaces the old hardcoded "@cliffy" path — Cliffy is now just one registered
// bot (see cmd/server wiring). External bots (outgoing webhook) will implement
// the same BotHandler role over a different transport.

// BotHandler is an in-process bot: given an event addressed to it, produce a reply.
type BotHandler interface {
	// OwnsThread reports whether a non-@mention reply in the given thread is
	// directed at this bot (i.e. the bot already spoke there).
	OwnsThread(ctx context.Context, rootMessageID string) bool
	// Handle runs one turn and returns the reply text ("" = post nothing).
	Handle(ctx context.Context, ev BotEvent) (string, error)
}

// BotEvent is a chat message addressed to a bot.
type BotEvent struct {
	BotUserID     string       // the bot this event is for (its author/user id)
	AskerID       string       // the human addressing the bot (the bot acts as them)
	ParentID      string       // channel or conversation id
	ParentType    string       // ParentChannel | ParentConversation
	Prompt        string       // the request, mention stripped
	RootMessageID string       // thread root the reply belongs under
	History       []BotMessage // prior turns in this thread, oldest-first
}

// BotMessage is one prior turn of a bot conversation.
type BotMessage struct {
	Role string // "user" | "assistant"
	Text string
}

// BotConfig registers an in-process bot with the dispatcher.
type BotConfig struct {
	UserID    string // author id its posts appear as
	Handle    string // plain-text @handle that triggers it (e.g. "cliffy")
	Username  string // display name (webhook override)
	IconEmoji string // icon emoji (webhook override)
	Handler   BotHandler
}

type registeredBot struct {
	cfg       BotConfig
	mentionRe *regexp.Regexp
}

// botReplyTimeout bounds a detached in-chat bot turn (an LLM bot can take ~10
// steps) — longer than the generic detachedTimeout for cheap bookkeeping.
const botReplyTimeout = 90 * time.Second

// botDispatchMaxConcurrent caps how many bot turns run at once. Each turn is a
// detached goroutine that can hold an LLM/HTTP call for up to botReplyTimeout, so
// without a ceiling a burst of mentions/replies would spawn unbounded goroutines
// (OOM). Beyond the cap, further events are dropped with a warning — backpressure
// over pile-up. A busy workspace can raise this; it is a safety ceiling, not a
// throughput target.
const botDispatchMaxConcurrent = 64

// botDispatchSem is the concurrency ceiling above. Package-global so the bound is
// process-wide regardless of how many MessageService instances exist.
var botDispatchSem = make(chan struct{}, botDispatchMaxConcurrent)

// bareMentionPrompt is what a bot's turn receives when it's @mentioned with no
// other text ("@bot"), so the handler still has something to act on.
const bareMentionPrompt = "Hi"

// Strip code fences / inline code / blockquotes before mention detection, so an
// "@bot" pasted inside code or a quote doesn't trigger a run.
var (
	botFenceRe  = regexp.MustCompile("(?s)```.*?```")
	botInlineRe = regexp.MustCompile("`[^`]*`")
	botQuoteRe  = regexp.MustCompile(`(?m)^\s*>.*$`)
)

// RegisterBot wires an in-process bot. Trigger: a message that @mentions the
// bot's handle (outside code/quotes), or a reply in a thread the bot owns.
func (s *MessageService) RegisterBot(cfg BotConfig) {
	if cfg.Handler == nil || cfg.UserID == "" || cfg.Handle == "" {
		return
	}
	// (^|\s)@<handle>\b, case-insensitive: standalone token, not mid-word, not an email.
	re := regexp.MustCompile(`(?i)(^|\s)@` + regexp.QuoteMeta(cfg.Handle) + `\b`)
	s.bots = append(s.bots, registeredBot{cfg: cfg, mentionRe: re})
}

// botConfigByID returns the registered in-process bot with the given user id.
func (s *MessageService) botConfigByID(userID string) (BotConfig, bool) {
	for i := range s.bots {
		if s.bots[i].cfg.UserID == userID {
			return s.bots[i].cfg, true
		}
	}
	return BotConfig{}, false
}

func botStripNonPrompt(body string) string {
	scan := botFenceRe.ReplaceAllString(body, " ")
	scan = botInlineRe.ReplaceAllString(scan, " ")
	return botQuoteRe.ReplaceAllString(scan, " ")
}

var botBracketMentionRe = regexp.MustCompile(`@\[[^\]]*\]`)

// maybeDispatchToBots routes a human message to a bot when it @mentions the bot
// (an in-process bot by its handle, or an external webhook bot by its bot_ id),
// or is a reply in a thread an in-process bot owns. Fully detached so it never
// adds send latency; never reacts to bot / webhook / system authors.
// botDetection is the synchronous routing decision for one incoming message:
// whether any registered bot is addressed and, if so, which. Pure (no I/O) so it
// stays cheap on the hot send path and is unit-testable in isolation; the async
// turn in maybeDispatchToBots acts on it.
type botDetection struct {
	dispatch      bool      // false → nothing addresses a bot; skip
	matchedStatic bool      // an in-process bot matched by @handle
	static        BotConfig // …that bot
	staticPrompt  string    // …with the mention stripped
	externalBotID string    // or an external (webhook) bot addressed by @[bot_…]
	threadReply   bool      // or a reply in an existing thread (ownership resolved later)
}

// detectBot decides, synchronously and without I/O, whether msg addresses a
// registered bot and which one.
func (s *MessageService) detectBot(msg *model.Message) botDetection {
	var d botDetection
	if msg == nil || (len(s.bots) == 0 && s.botDir == nil) {
		return d
	}
	if msg.System || msg.AuthorID == WebhookAuthorID || model.IsBotUserID(msg.AuthorID) {
		return d
	}
	// Cheap byte-scan early-out: a bot is addressed only via an "@" (mention) or
	// by replying in a bot's thread. A plain top-level human message can't match,
	// so skip all the regex/parse work below. Thread continuity is an in-process
	// concept (webhook bots don't own threads), so only pay the thread-reply path
	// when at least one in-process bot is registered — otherwise a reply in any
	// thread would needlessly spawn a turn that resolves to no owner.
	// (A finer per-thread "has a bot participated" filter is a later optimization.)
	d.threadReply = msg.ParentMessageID != "" && len(s.bots) > 0
	if !d.threadReply && strings.IndexByte(msg.Body, '@') < 0 {
		return d
	}

	scan := botStripNonPrompt(msg.Body)
	for i := range s.bots {
		if s.bots[i].mentionRe.MatchString(scan) {
			d.static = s.bots[i].cfg
			d.staticPrompt = strings.TrimSpace(s.bots[i].mentionRe.ReplaceAllString(msg.Body, "$1"))
			d.matchedStatic = true
			break
		}
	}
	// Bracket mention "@[bot_…|Name]" — the rich-mention form the composer emits
	// when a user picks a bot from autocomplete (the @handle regex above only
	// matches the plain "@handle" text form). Resolve the mentioned bot_ id
	// against registered IN-PROCESS bots first (e.g. Cliffy), then fall back to an
	// external webhook bot from the directory.
	if !d.matchedStatic && strings.Contains(msg.Body, "@["+model.BotUserIDPrefix) {
		for _, u := range ParseMentions(msg.Body).Users {
			if !model.IsBotUserID(u.UserID) {
				continue
			}
			if cfg, ok := s.botConfigByID(u.UserID); ok {
				d.static = cfg
				d.staticPrompt = strings.TrimSpace(botBracketMentionRe.ReplaceAllString(msg.Body, ""))
				d.matchedStatic = true
				break
			}
			if s.botDir != nil && d.externalBotID == "" {
				d.externalBotID = u.UserID
			}
		}
	}
	// An "@" that isn't a bot mention and isn't a bot thread → nothing to do.
	d.dispatch = d.matchedStatic || d.externalBotID != "" || d.threadReply
	return d
}

func (s *MessageService) maybeDispatchToBots(ctx context.Context, msg *model.Message, parentType string) {
	d := s.detectBot(msg)
	if !d.dispatch {
		return
	}

	root := msg.ParentMessageID
	if root == "" {
		root = msg.ID
	}
	msgID, askerID, parentID, body := msg.ID, msg.AuthorID, msg.ParentID, msg.Body
	threadRoot := msg.ParentMessageID

	// Acquire a concurrency slot BEFORE spawning so goroutines are bounded, not
	// just their work. Non-blocking: at capacity we drop the event (a bot may
	// miss a reply under extreme load) rather than pile up goroutines — and never
	// add latency to the human send path.
	select {
	case botDispatchSem <- struct{}{}:
	default:
		slog.Warn("bot dispatch: at capacity, dropping event", "parentID", parentID, "authorID", askerID)
		return
	}

	safe.Go(func() {
		defer func() { <-botDispatchSem }()
		bg, cancel := detachedContextTimeout(ctx, botReplyTimeout)
		defer cancel()

		// Resolve which bot handles this event.
		var cfg BotConfig
		var p string
		switch {
		case d.matchedStatic:
			cfg, p = d.static, d.staticPrompt
		case d.externalBotID != "":
			t, ok := s.botDir.WebhookBot(bg, d.externalBotID)
			if !ok {
				return
			}
			cfg = BotConfig{UserID: d.externalBotID, Username: t.Name, Handler: webhookBotHandler{target: t}}
			p = strings.TrimSpace(botBracketMentionRe.ReplaceAllString(body, ""))
		default: // thread continuation → the in-process bot that owns this thread
			for i := range s.bots {
				if s.bots[i].cfg.Handler.OwnsThread(bg, threadRoot) {
					cfg = s.bots[i].cfg
					break
				}
			}
			if cfg.Handler == nil {
				return
			}
			p = strings.TrimSpace(body)
		}
		if p == "" {
			p = bareMentionPrompt
		}

		// Live "<Bot> is typing…" while the turn runs, at the same thread level.
		stop := s.botTyping(bg, cfg, parentID, parentType, threadRoot)
		reply, err := cfg.Handler.Handle(bg, BotEvent{
			BotUserID:     cfg.UserID,
			AskerID:       askerID,
			ParentID:      parentID,
			ParentType:    parentType,
			Prompt:        p,
			RootMessageID: root,
			History:       s.botThreadHistory(bg, cfg.UserID, askerID, parentID, parentType, root, msgID),
		})
		stop()
		if err != nil {
			slog.Warn("bot dispatch: handler failed", "bot", cfg.UserID, "parent", parentID, "error", err)
			reply = "Sorry — I couldn't respond just now. Please try again."
		}
		if strings.TrimSpace(reply) == "" {
			return
		}
		if _, err := s.postBotReply(bg, cfg, askerID, parentID, parentType, root, reply); err != nil {
			slog.Warn("bot dispatch: post failed", "bot", cfg.UserID, "parent", parentID, "error", err)
		}
	})
}

// postBotReply posts a bot's reply as that bot (access-checked against the asker,
// threaded under root), rendered as a bot message via the webhook overrides.
func (s *MessageService) postBotReply(ctx context.Context, cfg BotConfig, requesterID, parentID, parentType, parentMessageID, body string) (*model.Message, error) {
	if err := s.checkAccess(ctx, requesterID, parentID, parentType); err != nil {
		return nil, err
	}
	return s.SendWebhook(ctx, WebhookMessageInput{
		ParentID:        parentID,
		ParentType:      parentType,
		ParentMessageID: parentMessageID,
		AuthorID:        cfg.UserID,
		Username:        cfg.Username,
		IconEmoji:       cfg.IconEmoji,
		Body:            body,
	})
}

// botThreadHistory reads the prior turns of a bot conversation in a thread (root
// + replies) for continuity. Messages authored by the bot are "assistant";
// everything else is "user". Excludes the just-sent message; bounded.
func (s *MessageService) botThreadHistory(ctx context.Context, botUserID, userID, parentID, parentType, rootID, currentMsgID string) []BotMessage {
	if rootID == "" {
		return nil
	}
	thread, err := s.ListThreadMessages(ctx, userID, parentID, parentType, rootID)
	if err != nil {
		return nil
	}
	out := make([]BotMessage, 0, len(thread))
	for _, m := range thread {
		if m == nil || m.ID == currentMsgID || m.System {
			continue
		}
		text := strings.TrimSpace(m.Body)
		if text == "" {
			continue
		}
		role := "user"
		if m.AuthorID == botUserID {
			role = "assistant"
		}
		out = append(out, BotMessage{Role: role, Text: clampRunes(text, 1200)})
	}
	const maxTurns = 24
	if len(out) > maxTurns {
		out = out[len(out)-maxTurns:]
	}
	return out
}

func clampRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}

// botTyping broadcasts a "<Bot> is typing…" indicator and keeps it alive (the
// client indicator expires after ~6s) until the returned stop func is called.
func (s *MessageService) botTyping(ctx context.Context, cfg BotConfig, parentID, parentType, parentMessageID string) func() {
	if s.publisher == nil {
		return func() {}
	}
	emit := func() {
		payload := map[string]any{"userID": cfg.UserID, "parentID": parentID, "parentType": parentType}
		if parentMessageID != "" {
			payload["parentMessageID"] = parentMessageID
		}
		s.publishEvent(ctx, parentID, parentType, events.EventTyping, payload)
	}
	emit()
	done := make(chan struct{})
	safe.Go(func() {
		t := time.NewTicker(4 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-t.C:
				emit()
			}
		}
	})
	var once sync.Once
	return func() { once.Do(func() { close(done) }) }
}
