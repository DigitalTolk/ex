package store

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/oklog/ulid/v2"
	"golang.org/x/sync/errgroup"
)

// Backfill of the thread-participation index for threads rooted before
// replies wrote follow rows: every participant of such a thread gets a follow
// row, and the root is flagged ParticipantsIndexed, so the thread shows on
// its participants' /threads lists and its replies find their audience in the
// follow rows (`migrate thread-participants`).

// ThreadReplies is one thread found by ScanThreadReplies.
type ThreadReplies struct {
	ParentID string
	RootID   string
	// AuthorIDs are the distinct reply authors.
	AuthorIDs   []string
	LastReplyAt time.Time
}

// ScanThreadReplies reads every reply in the GSI1 thread index, segments of
// the index in parallel, projecting only each reply's keys, author and time.
// It returns the threads whose root is older than before (by the root ID's
// ULID time; an ID that isn't a ULID counts as old), and how many replies it
// read.
func (s *MessageStoreImpl) ScanThreadReplies(ctx context.Context, before time.Time, segments int) ([]*ThreadReplies, int, error) {
	segments = max(segments, 1)
	filt := expression.Name("GSI1PK").BeginsWith(threadGSI1PK(""))
	proj := expression.NamesList(expression.Name("PK"), expression.Name("GSI1PK"), expression.Name("authorID"), expression.Name("createdAt"))
	expr := mustExpr(expression.NewBuilder().WithFilter(filt).WithProjection(proj).Build())
	var (
		mu      sync.Mutex
		threads = map[string]*ThreadReplies{}
		replies atomic.Int64
	)
	g, gctx := errgroup.WithContext(ctx)
	for seg := range segments {
		g.Go(func() error {
			pages := dynamodb.NewScanPaginator(s.Client, &dynamodb.ScanInput{
				TableName:                 aws.String(s.Table),
				IndexName:                 aws.String("GSI1"),
				FilterExpression:          expr.Filter(),
				ProjectionExpression:      expr.Projection(),
				ExpressionAttributeNames:  expr.Names(),
				ExpressionAttributeValues: expr.Values(),
				Segment:                   aws.Int32(int32(seg)),
				TotalSegments:             aws.Int32(int32(segments)),
			})
			local := map[string]*ThreadReplies{}
			for pages.HasMorePages() {
				page, err := pages.NextPage(gctx)
				if err != nil {
					return fmt.Errorf("store: scan thread replies: %w", err)
				}
				for _, item := range page.Items {
					var row struct {
						PK        string    `dynamodbav:"PK"`
						GSI1PK    string    `dynamodbav:"GSI1PK"`
						AuthorID  string    `dynamodbav:"authorID"`
						CreatedAt time.Time `dynamodbav:"createdAt"`
					}
					if err := attributevalue.UnmarshalMap(item, &row); err != nil {
						return fmt.Errorf("store: unmarshal thread reply: %w", err)
					}
					replies.Add(1)
					rootID := strings.TrimPrefix(row.GSI1PK, threadGSI1PK(""))
					if rootedBefore(rootID, before) {
						addThreadReply(local, strings.TrimPrefix(row.PK, parentPK("")), rootID, row.AuthorID, row.CreatedAt)
					}
				}
			}
			mu.Lock()
			defer mu.Unlock()
			for _, t := range local {
				for _, uid := range t.AuthorIDs {
					addThreadReply(threads, t.ParentID, t.RootID, uid, t.LastReplyAt)
				}
			}
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return nil, int(replies.Load()), err
	}
	out := make([]*ThreadReplies, 0, len(threads))
	for _, t := range threads {
		out = append(out, t)
	}
	return out, int(replies.Load()), nil
}

// rootedBefore reports whether the root ID's ULID time is before cut-off.
func rootedBefore(rootID string, cutoff time.Time) bool {
	id, err := ulid.ParseStrict(rootID)
	return err != nil || ulid.Time(id.Time()).Before(cutoff)
}

// addThreadReply folds one reply into its thread's entry.
func addThreadReply(threads map[string]*ThreadReplies, parentID, rootID, authorID string, at time.Time) {
	key := parentID + "#" + rootID
	t := threads[key]
	if t == nil {
		t = &ThreadReplies{ParentID: parentID, RootID: rootID}
		threads[key] = t
	}
	if !slices.Contains(t.AuthorIDs, authorID) {
		t.AuthorIDs = append(t.AuthorIDs, authorID)
	}
	if at.After(t.LastReplyAt) {
		t.LastReplyAt = at
	}
}

// ParentTypes reports each ID's parent type: SidebarItemChannel or
// SidebarItemConversation. IDs that are neither are absent. A group
// conversation converted to a channel keeps its ID and is a channel.
func ParentTypes(ctx context.Context, db *DB, ids []string) (map[string]string, error) {
	keys := make([]map[string]types.AttributeValue, 0, 2*len(ids))
	for _, id := range ids {
		keys = append(keys, compositeKey(channelPK(id), metaSK()), compositeKey(convPK(id), metaSK()))
	}
	rows, err := batchGetOf[struct {
		PK string `dynamodbav:"PK"`
	}](ctx, db, keys, types.KeysAndAttributes{ProjectionExpression: aws.String("PK")}, "parents")
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(ids))
	for _, r := range rows {
		if id, ok := strings.CutPrefix(r.PK, channelPK("")); ok {
			out[id] = SidebarItemChannel
		} else if id := strings.TrimPrefix(r.PK, convPK("")); out[id] == "" {
			out[id] = SidebarItemConversation
		}
	}
	return out, nil
}

// ThreadParticipantsResult counts one BackfillThreadParticipants call.
type ThreadParticipantsResult struct {
	// Indexed roots were flagged (in a dry run: would be).
	Indexed        int
	AlreadyIndexed int
	// FollowsWritten counts the missing follow rows written (in a dry run:
	// that would be).
	FollowsWritten int
	// RootsSkipped were missing or deleted: left as they are.
	RootsSkipped int
}

// BackfillThreadParticipants makes every participant of threads (all of one
// parent, of parentType) a follower — the root author and each reply author,
// ignore excepted — unless they already have a follow row (a deliberate
// unfollow included), dated by the thread's latest reply. Then it flags the
// root ParticipantsIndexed. A root is flagged only once all its rows are
// written; a missing or deleted root is left alone, so its replies keep the
// legacy read. dryRun counts without writing. Idempotent: flagged roots are
// skipped and rows are written only where absent, so a failed run is re-run.
func BackfillThreadParticipants(ctx context.Context, db *DB, parentID, parentType string, threads []*ThreadReplies, ignore []string, dryRun bool) (ThreadParticipantsResult, error) {
	var res ThreadParticipantsResult
	messages, follows := NewMessageStore(db), NewThreadFollowStore(db)
	ids := make([]string, len(threads))
	for i, t := range threads {
		ids[i] = t.RootID
	}
	roots, err := messages.GetMessagesByIDs(ctx, parentID, ids)
	if err != nil {
		return res, err
	}
	byID := make(map[string]*model.Message, len(roots))
	for _, r := range roots {
		byID[r.ID] = r
	}
	type pending struct {
		thread *ThreadReplies
		root   *model.Message
		users  []string
	}
	var work []pending
	var keys []map[string]types.AttributeValue
	for _, t := range threads {
		root := byID[t.RootID]
		switch {
		case root == nil || root.Deleted:
			res.RootsSkipped++
			continue
		case root.ParticipantsIndexed:
			res.AlreadyIndexed++
			continue
		}
		users := threadParticipants(root.AuthorID, t.AuthorIDs, ignore)
		work = append(work, pending{thread: t, root: root, users: users})
		for _, uid := range users {
			keys = append(keys, compositeKey(userPK(uid), threadFollowSK(parentID, t.RootID)))
		}
	}
	existing, err := batchGetOf[threadFollowItem](ctx, db, keys, types.KeysAndAttributes{}, "thread follows")
	if err != nil {
		return res, err
	}
	have := make(map[string]bool, len(existing))
	for _, f := range existing {
		have[f.UserID+"#"+f.ThreadRootID] = true
	}
	now := time.Now()
	for _, w := range work {
		at := w.thread.LastReplyAt
		if w.root.LastReplyAt != nil && w.root.LastReplyAt.After(at) {
			at = *w.root.LastReplyAt
		}
		for _, uid := range w.users {
			if have[uid+"#"+w.root.ID] {
				continue
			}
			res.FollowsWritten++
			if dryRun {
				continue
			}
			if err := follows.SetThreadFollowIfAbsent(ctx, &model.ThreadFollow{
				UserID: uid, ParentID: parentID, ParentType: parentType, ThreadRootID: w.root.ID,
				Following: true, UpdatedAt: now, LastActivityAt: &at,
			}); err != nil {
				return res, err
			}
		}
		if !dryRun {
			if err := messages.MarkThreadParticipantsIndexed(ctx, parentID, w.root.ID); err != nil {
				if errors.Is(err, ErrNotFound) {
					res.RootsSkipped++
					continue
				}
				return res, err
			}
		}
		res.Indexed++
	}
	return res, nil
}

// threadParticipants is the root author and the reply authors, each once,
// without empty IDs and the ignored ones (machine authors).
func threadParticipants(rootAuthorID string, replyAuthorIDs, ignore []string) []string {
	var out []string
	for _, uid := range append([]string{rootAuthorID}, replyAuthorIDs...) {
		if uid != "" && !slices.Contains(ignore, uid) && !slices.Contains(out, uid) {
			out = append(out, uid)
		}
	}
	return out
}
