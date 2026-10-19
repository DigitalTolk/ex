package importer

import (
	"context"
	"errors"
	"fmt"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/search"
	"github.com/DigitalTolk/ex/internal/store"
)

// Removal calls undo an import. Like every importer call they write straight to
// storage: nothing is published or notified, so connected clients only see the
// change after a reload. All of them are idempotent — anything already gone
// is skipped.

// RemoveResult summarizes a removal.
type RemoveResult struct {
	Messages    int // message rows deleted
	Attachments int // attachments deleted (no message referenced them any more)
}

// ForeignMessagesError is returned when a channel or conversation holds
// messages that were not part of the import and removal was not forced.
type ForeignMessagesError struct {
	ParentID string
	Count    int
}

func (e *ForeignMessagesError) Error() string {
	return fmt.Sprintf("importer: %s has %d messages that were not imported", e.ParentID, e.Count)
}

// UserInUseError is returned when a user still has memberships or has signed
// in, and removal was not forced.
type UserInUseError struct {
	UserID        string
	Channels      int
	Conversations int
	SignedIn      bool
}

func (e *UserInUseError) Error() string {
	return fmt.Sprintf("importer: user %s is in use (%d channels, %d conversations, signed in: %v)",
		e.UserID, e.Channels, e.Conversations, e.SignedIn)
}

// RemoveMessages hard-deletes messages of one parent together with their pin
// and file index rows, their references on attachments (an attachment no
// message references any more is deleted with its stored objects), thread
// follows of removed roots and their search documents. Thread roots that lost
// replies get their thread metadata recomputed, and the parent's unread
// counter and every member's read watermark go down by the number of removed
// top-level, non-system messages (never below zero, and no watermark above the
// counter), so unread counts stay as they were.
func (im *Importer) RemoveMessages(ctx context.Context, parentID, parentType string, ids []string) (RemoveResult, error) {
	if err := validParentType(parentType); err != nil {
		return RemoveResult{}, err
	}
	msgs, err := im.messages.GetMessagesByIDs(ctx, parentID, dedupe(ids))
	if err != nil {
		return RemoveResult{}, fmt.Errorf("importer: get messages: %w", err)
	}
	res, err := im.removeMessages(ctx, parentID, msgs)
	if err != nil {
		return res, err
	}
	removed := make(map[string]bool, len(msgs))
	for _, m := range msgs {
		removed[m.ID] = true
	}
	topLevel := 0
	roots := map[string]bool{}
	for _, m := range msgs {
		if m.ParentMessageID == "" && !m.System {
			topLevel++
		}
		if m.ParentMessageID != "" && !removed[m.ParentMessageID] {
			roots[m.ParentMessageID] = true
		}
	}
	for root := range roots {
		if err := im.refreshThread(ctx, parentID, root, removed); err != nil {
			return res, err
		}
	}
	return res, im.lowerSeq(ctx, parentID, parentType, int64(topLevel))
}

// removeMessages deletes the rows and objects belonging to msgs (no counters).
func (im *Importer) removeMessages(ctx context.Context, parentID string, msgs []*model.Message) (RemoveResult, error) {
	var res RemoveResult
	if len(msgs) == 0 {
		return res, nil
	}
	removed := make(map[string]bool, len(msgs))
	var ids, pins, attIDs []string
	for _, m := range msgs {
		removed[m.ID] = true
		ids = append(ids, m.ID)
		if m.Pinned {
			pins = append(pins, m.ID)
		}
		attIDs = append(attIDs, m.AttachmentIDs...)
	}
	n, err := im.dropAttachmentRefs(ctx, msgs, dedupe(attIDs))
	res.Attachments = n
	if err != nil {
		return res, err
	}
	fileRows, err := im.parentIndex.ListFileIndex(ctx, parentID)
	if err != nil {
		return res, fmt.Errorf("importer: list files: %w", err)
	}
	var files []string
	for _, f := range fileRows {
		if removed[f.MessageID] {
			files = append(files, f.AttachmentID)
		}
	}
	if err := im.parentIndex.DeleteIndexRows(ctx, parentID, pins, files); err != nil {
		return res, fmt.Errorf("importer: delete index rows: %w", err)
	}
	var follows []*model.ThreadFollow
	for _, m := range msgs {
		if m.ParentMessageID != "" {
			continue
		}
		fs, err := im.follows.ListThreadFollows(ctx, parentID, m.ID)
		if err != nil {
			return res, fmt.Errorf("importer: list thread follows: %w", err)
		}
		follows = append(follows, fs...)
	}
	if err := im.follows.DeleteThreadFollows(ctx, follows); err != nil {
		return res, fmt.Errorf("importer: delete thread follows: %w", err)
	}
	if err := im.messages.DeleteMessages(ctx, parentID, ids); err != nil {
		return res, fmt.Errorf("importer: delete messages: %w", err)
	}
	res.Messages = len(ids)
	if im.search != nil {
		for _, id := range ids {
			if err := im.search.DeleteDoc(ctx, search.IndexMessages, id); err != nil {
				return res, fmt.Errorf("importer: unindex message: %w", err)
			}
		}
	}
	return res, nil
}

// dropAttachmentRefs removes the messages' references from their attachments
// and deletes attachments left without references. Returns how many were
// deleted.
func (im *Importer) dropAttachmentRefs(ctx context.Context, msgs []*model.Message, attIDs []string) (int, error) {
	if len(attIDs) == 0 {
		return 0, nil
	}
	atts, err := im.attachments.GetAttachmentsByIDs(ctx, attIDs)
	if err != nil {
		return 0, fmt.Errorf("importer: get attachments: %w", err)
	}
	exists := make(map[string]bool, len(atts))
	for _, a := range atts {
		exists[a.ID] = true
	}
	last := map[string]*model.Attachment{}
	for _, m := range msgs {
		for _, aid := range m.AttachmentIDs {
			if !exists[aid] {
				continue
			}
			a, err := im.attachments.RemoveRef(ctx, aid, m.ID)
			if err != nil {
				return 0, fmt.Errorf("importer: attachment %s: %w", aid, err)
			}
			last[aid] = a
		}
	}
	deleted := 0
	for _, aid := range attIDs {
		a, ok := last[aid]
		if !ok || len(a.MessageIDs) > 0 {
			continue
		}
		if err := im.deleteAttachment(ctx, a); err != nil {
			return deleted, err
		}
		deleted++
	}
	return deleted, nil
}

func (im *Importer) deleteAttachment(ctx context.Context, a *model.Attachment) error {
	for _, key := range []string{a.S3Key, a.ThumbnailS3Key, a.SquareThumbnailS3Key} {
		if key == "" {
			continue
		}
		if im.objects == nil {
			return ErrNoObjectStore
		}
		if err := im.objects.DeleteObject(ctx, key); err != nil {
			return fmt.Errorf("importer: delete object %s: %w", key, err)
		}
	}
	if err := im.attachments.Delete(ctx, a.ID); err != nil {
		return fmt.Errorf("importer: delete attachment: %w", err)
	}
	if im.search != nil {
		if err := im.search.DeleteDoc(ctx, search.IndexFiles, a.ID); err != nil {
			return fmt.Errorf("importer: unindex file: %w", err)
		}
	}
	return nil
}

// refreshThread recomputes a root's thread metadata from its remaining
// replies. The thread index is eventually consistent, so just-removed replies
// are filtered out explicitly.
func (im *Importer) refreshThread(ctx context.Context, parentID, rootID string, removed map[string]bool) error {
	root, err := im.messages.GetMessage(ctx, parentID, rootID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("importer: get thread root: %w", err)
	}
	all, err := im.messages.ListThreadReplies(ctx, rootID)
	if err != nil {
		return fmt.Errorf("importer: list thread replies: %w", err)
	}
	var replies []*model.Message
	for _, r := range all {
		if !removed[r.ID] {
			replies = append(replies, r)
		}
	}
	if len(replies) == 0 {
		if err := im.messages.ClearReplyMetadata(ctx, parentID, rootID); err != nil {
			return fmt.Errorf("importer: clear reply metadata: %w", err)
		}
		return nil
	}
	authors, _ := summarizeThread(root.AuthorID, replies)
	if err := im.messages.SetReplyMetadata(ctx, parentID, rootID, len(replies), replies[0].CreatedAt, authors); err != nil {
		return fmt.Errorf("importer: set reply metadata: %w", err)
	}
	return nil
}

// lowerSeq takes n off the parent's unread counter and every member's read
// watermark, clamped so neither goes below zero and no watermark ends above
// the counter.
func (im *Importer) lowerSeq(ctx context.Context, parentID, parentType string, n int64) error {
	if n <= 0 {
		return nil
	}
	var seq int64
	var members []string
	var seqs map[string]int64
	var err error
	if parentType == ParentChannel {
		ch, gerr := im.channels.GetChannel(ctx, parentID)
		if gerr != nil {
			return fmt.Errorf("importer: get channel: %w", gerr)
		}
		ms, lerr := im.memberships.ListMembers(ctx, parentID)
		if lerr != nil {
			return fmt.Errorf("importer: list members: %w", lerr)
		}
		for _, m := range ms {
			members = append(members, m.UserID)
		}
		seq = ch.MessageSeq
		seqs, err = im.memberships.LastReadSeqs(ctx, parentID, members)
	} else {
		conv, gerr := im.conversations.GetConversation(ctx, parentID)
		if gerr != nil {
			return fmt.Errorf("importer: get conversation: %w", gerr)
		}
		seq, members = conv.MessageSeq, conv.ParticipantIDs
		seqs, err = im.conversations.LastReadSeqs(ctx, parentID, members)
	}
	if err != nil {
		return fmt.Errorf("importer: read state: %w", err)
	}
	drop := min(n, seq)
	newSeq := seq - drop
	if drop > 0 {
		if parentType == ParentChannel {
			_, err = im.channels.AddMessageSeq(ctx, parentID, -drop)
		} else {
			_, err = im.conversations.AddMessageSeq(ctx, parentID, -drop)
		}
		if err != nil {
			return fmt.Errorf("importer: lower message seq: %w", err)
		}
	}
	for _, uid := range members {
		cur, ok := seqs[uid]
		if !ok {
			continue
		}
		target := min(max(cur-n, 0), newSeq)
		if target == cur {
			continue
		}
		if parentType == ParentChannel {
			err = im.memberships.AddChannelLastRead(ctx, parentID, uid, target-cur)
		} else {
			err = im.conversations.AddConversationLastRead(ctx, parentID, uid, target-cur)
		}
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("importer: member %s read state: %w", uid, err)
		}
	}
	return nil
}

// foreign counts messages not in the imported set.
func foreign(msgs []*model.Message, imported []string) int {
	ok := make(map[string]bool, len(imported))
	for _, id := range imported {
		ok[id] = true
	}
	n := 0
	for _, m := range msgs {
		if !ok[m.ID] {
			n++
		}
	}
	return n
}

// RemoveChannelSpec names a channel to remove. ImportedMessageIDs are the
// messages the import wrote; any other message in the channel makes the call
// fail with ForeignMessagesError unless Force is set.
type RemoveChannelSpec struct {
	ChannelID          string
	ImportedMessageIDs []string
	Force              bool
}

// RemoveChannel deletes a channel the import created: all its messages (as
// RemoveMessages, without counter updates), memberships on both sides, its
// slug lock, everything else in its partition and its search document.
func (im *Importer) RemoveChannel(ctx context.Context, spec RemoveChannelSpec) (RemoveResult, error) {
	ch, err := im.channels.GetChannel(ctx, spec.ChannelID)
	if errors.Is(err, store.ErrNotFound) {
		return RemoveResult{}, nil
	}
	if err != nil {
		return RemoveResult{}, fmt.Errorf("importer: get channel: %w", err)
	}
	msgs, err := im.allMessages(ctx, ch.ID)
	if err != nil {
		return RemoveResult{}, err
	}
	if n := foreign(msgs, spec.ImportedMessageIDs); n > 0 && !spec.Force {
		return RemoveResult{}, &ForeignMessagesError{ParentID: ch.ID, Count: n}
	}
	res, err := im.removeMessages(ctx, ch.ID, msgs)
	if err != nil {
		return res, err
	}
	members, err := im.memberships.ListMembers(ctx, ch.ID)
	if err != nil {
		return res, fmt.Errorf("importer: list members: %w", err)
	}
	for _, m := range members {
		if err := im.memberships.RemoveMember(ctx, ch.ID, m.UserID); err != nil {
			return res, fmt.Errorf("importer: remove member: %w", err)
		}
	}
	if err := im.channels.DeleteChannel(ctx, ch); err != nil {
		return res, fmt.Errorf("importer: delete channel: %w", err)
	}
	if im.search != nil {
		if err := im.search.DeleteDoc(ctx, search.IndexChannels, ch.ID); err != nil {
			return res, fmt.Errorf("importer: unindex channel: %w", err)
		}
	}
	return res, nil
}

// RemoveConversationSpec names a conversation to remove; see RemoveChannelSpec.
type RemoveConversationSpec struct {
	ConversationID     string
	ImportedMessageIDs []string
	Force              bool
}

// RemoveConversation deletes a conversation the import created: its messages
// (as RemoveMessages, without counter updates), its metadata and member rows,
// and every participant's sidebar row.
func (im *Importer) RemoveConversation(ctx context.Context, spec RemoveConversationSpec) (RemoveResult, error) {
	conv, err := im.conversations.GetConversation(ctx, spec.ConversationID)
	if errors.Is(err, store.ErrNotFound) {
		return RemoveResult{}, nil
	}
	if err != nil {
		return RemoveResult{}, fmt.Errorf("importer: get conversation: %w", err)
	}
	msgs, err := im.allMessages(ctx, conv.ID)
	if err != nil {
		return RemoveResult{}, err
	}
	if n := foreign(msgs, spec.ImportedMessageIDs); n > 0 && !spec.Force {
		return RemoveResult{}, &ForeignMessagesError{ParentID: conv.ID, Count: n}
	}
	res, err := im.removeMessages(ctx, conv.ID, msgs)
	if err != nil {
		return res, err
	}
	if err := im.conversations.DeleteConversation(ctx, conv); err != nil {
		return res, fmt.Errorf("importer: delete conversation: %w", err)
	}
	return res, nil
}

// RemoveMembers removes users from a channel (both membership rows). Users who
// aren't members are skipped.
func (im *Importer) RemoveMembers(ctx context.Context, channelID string, userIDs []string) error {
	for _, uid := range dedupe(userIDs) {
		if err := im.memberships.RemoveMember(ctx, channelID, uid); err != nil {
			return fmt.Errorf("importer: remove member %s: %w", uid, err)
		}
	}
	return nil
}

// RemoveUserSpec names a user to remove. Without Force the call refuses a user
// who still belongs to any channel or conversation, or who has signed in.
type RemoveUserSpec struct {
	UserID string
	Force  bool
}

// RemoveUser deletes a user the import created: profile, email index, search
// document and cached record. Memberships are not touched — remove them first
// (Force only skips the in-use check).
func (im *Importer) RemoveUser(ctx context.Context, spec RemoveUserSpec) error {
	u, err := im.users.GetUser(ctx, spec.UserID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("importer: get user: %w", err)
	}
	if !spec.Force {
		chans, err := im.memberships.ListUserChannels(ctx, u.ID)
		if err != nil {
			return fmt.Errorf("importer: list user channels: %w", err)
		}
		convs, err := im.conversations.ListUserConversations(ctx, u.ID)
		if err != nil {
			return fmt.Errorf("importer: list user conversations: %w", err)
		}
		if len(chans) > 0 || len(convs) > 0 || u.LastSeenAt != nil {
			return &UserInUseError{UserID: u.ID, Channels: len(chans), Conversations: len(convs), SignedIn: u.LastSeenAt != nil}
		}
	}
	if err := im.users.DeleteUser(ctx, u); err != nil {
		return fmt.Errorf("importer: delete user: %w", err)
	}
	if im.search != nil {
		if err := im.search.DeleteDoc(ctx, search.IndexUsers, u.ID); err != nil {
			return fmt.Errorf("importer: unindex user: %w", err)
		}
	}
	return im.InvalidateUsers(ctx, []string{u.ID})
}
