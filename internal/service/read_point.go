package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/oklog/ulid/v2"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// readPointLookahead / readPointLookaheadPages bound the "is anything counted
// after the read point?" probe. Thread replies share the message range and
// interleave by ID, so the probe pages past them — up to a bound, beyond
// which it can't prove "caught up" and keeps the anchor's own seq.
const (
	readPointLookahead      = 25
	readPointLookaheadPages = 3
)

// readPointSettleWindow: a read only jumps to the parent's CURRENT seq once
// the newest seq was claimed at least this long ago. Within it, a send may
// have claimed its seq but not yet written its message — catching up to that
// seq would mark a message read before it exists.
const readPointSettleWindow = 5 * time.Second

// seqSettled reports whether the parent's newest seq (claimed at lastSeqAt)
// is old enough to catch up to. Rows from before lastSeqAt was recorded are
// settled by definition.
func seqSettled(lastSeqAt, now time.Time) bool {
	return lastSeqAt.IsZero() || now.Sub(lastSeqAt) >= readPointSettleWindow
}

// resolveReadPoint turns a mark-read request into the (seq, msgID) read point
// to store for a parent whose MessageSeq is currentSeq. Callers must have
// checked the reader's access first — this looks messages up.
//
//   - No upToMsgID ("I've read everything"): the current seq, watermarked with
//     a message-ID-space timestamp (store.ReadWatermarkID) since the newest
//     message's ID isn't known here. Also the fallback when no message store
//     is wired.
//   - upToMsgID: the seq that message claimed when it was sent, so messages
//     after it stay unread. It must be a well-formed ID of a top-level message
//     of this parent — anything else is rejected rather than stored (the
//     forward-only guard would otherwise pin a bogus watermark).
//
// When no counted message follows the read point (and the newest seq has
// settled — see readPointSettleWindow), the reader has seen everything and
// the CURRENT seq is stored instead of the message's own:
// a seq claimed by a send whose create then failed, or an inversion where a
// concurrent send's seq landed on an earlier-sorting ID, would otherwise
// leave a phantom unread that no read-up-to could ever clear. A message
// without a Seq (sent before Seq existed) anchors just below the next counted
// message's seq, or at the current seq when nothing counted follows.
func resolveReadPoint(ctx context.Context, messages MessageStore, parentID string, currentSeq int64, settled bool, upToMsgID string, now time.Time) (int64, string, error) {
	if upToMsgID == "" || messages == nil {
		return currentSeq, store.ReadWatermarkID(now), nil
	}
	if _, err := ulid.ParseStrict(upToMsgID); err != nil {
		return 0, "", fmt.Errorf("%w: malformed upToMessageID", ErrValidation)
	}
	msg, err := messages.GetMessage(ctx, parentID, upToMsgID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return 0, "", fmt.Errorf("%w: upToMessageID is not a message of this parent", ErrValidation)
		}
		return 0, "", fmt.Errorf("read point: get message: %w", err)
	}
	if msg.ParentMessageID != "" {
		return 0, "", fmt.Errorf("%w: a thread reply cannot be a read point", ErrValidation)
	}

	// The earliest counted message after the read point, if any. (IDs are
	// re-checked: the cursor bound is the store's contract, but the guard keeps
	// this correct against any store that returns it inclusive.)
	var nextID string
	var nextSeq int64
	cursor, hasMore := msg.ID, true
	for page := 0; page < readPointLookaheadPages && hasMore && nextID == ""; page++ {
		var later []*model.Message
		later, hasMore, err = messages.ListMessagesAfter(ctx, parentID, cursor, readPointLookahead)
		if err != nil {
			return 0, "", fmt.Errorf("read point: list later messages: %w", err)
		}
		for _, m := range later {
			if m.ID > cursor {
				cursor = m.ID
			}
			if m.ID <= msg.ID || m.ParentMessageID != "" || m.System {
				continue
			}
			if nextID == "" || m.ID < nextID {
				nextID, nextSeq = m.ID, m.Seq
			}
		}
	}
	caughtUp := nextID == "" && !hasMore

	seq := msg.Seq
	switch {
	case caughtUp && (settled || seq == 0):
		// Seen everything: the current seq clears any phantom. (A seq above
		// the — eventually consistent — parent read is the fresher value; a
		// pre-Seq anchor has nothing better even while unsettled.)
		seq = max(seq, currentSeq)
	case seq == 0 && nextSeq > 0:
		seq = nextSeq - 1
	case seq == 0:
		// Pre-Seq anchor with nothing to bound it: best effort.
		seq = currentSeq
	}
	return seq, msg.ID, nil
}
