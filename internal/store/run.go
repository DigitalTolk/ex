package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// ErrStaleRun is returned by conditional run transitions when the row no
// longer matches the state the caller observed — someone else moved it.
var ErrStaleRun = errors.New("store: run state changed concurrently")

// RunStore persists runs, their append-only event timelines, digests, and
// the per-owner claim queue.
type RunStore struct {
	*DB
}

// NewRunStore returns a RunStore backed by the shared DB.
func NewRunStore(db *DB) *RunStore { return &RunStore{DB: db} }

type runItem struct {
	PK     string `dynamodbav:"PK"`
	SK     string `dynamodbav:"SK"`
	GSI1PK string `dynamodbav:"GSI1PK"`
	GSI1SK string `dynamodbav:"GSI1SK"`
	// GSI2 keys are present only while the run is non-terminal — they form
	// the ACTIVE_RUNS liveness index the reconciler sweeps. Cleared on
	// terminal transition so finished runs cost the index nothing.
	GSI2PK string `dynamodbav:"GSI2PK,omitempty"`
	GSI2SK string `dynamodbav:"GSI2SK,omitempty"`
	model.Run
}

// runqItem is one pending claim-queue row. Deliberately minimal: the claim
// long-poll reads this partition constantly and needs only the run id — the
// agent and the creation time were written but never read, and both are on the
// run row (the SK's ULID already orders by creation).
type runqItem struct {
	PK    string `dynamodbav:"PK"`
	SK    string `dynamodbav:"SK"`
	RunID string `dynamodbav:"runID"`
}

// CreateRun writes the run META row and its claim-queue row in one
// transaction — a run that exists is always either claimable or already
// past claiming, never half-registered.
func (s *RunStore) CreateRun(ctx context.Context, run *model.Run) error {
	if run.ID == "" || run.OwnerID == "" {
		return errors.New("store: run id and owner required")
	}
	item := runItem{
		PK:     runPK(run.ID),
		SK:     metaSK(),
		GSI1PK: runParentGSI1PK(run.ParentID),
		GSI1SK: runGSI1SK(run.ID),
		GSI2PK: activeRunsGSI2PK(),
		GSI2SK: activeRunGSI2SK(run.Deadline, run.ID),
		Run:    *run,
	}
	runAV := mustAttrs(attributevalue.MarshalMap(item))
	qAV := mustAttrs(attributevalue.MarshalMap(runqItem{
		PK:    runqPK(run.OwnerID),
		SK:    runqSK(run.ID),
		RunID: run.ID,
	}))
	_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{Put: &types.Put{
				TableName:           aws.String(s.Table),
				Item:                runAV,
				ConditionExpression: aws.String("attribute_not_exists(PK)"),
			}},
			{Put: &types.Put{
				TableName: aws.String(s.Table),
				Item:      qAV,
			}},
		},
	})
	if err != nil {
		if isTransactionCancelledWithCondition(err) {
			return ErrAlreadyExists
		}
		return fmt.Errorf("store: create run: %w", err)
	}
	return nil
}

// GetRun fetches one run by ID.
func (s *RunStore) GetRun(ctx context.Context, runID string) (*model.Run, error) {
	item, err := getItem[runItem](ctx, s.DB, runPK(runID), metaSK(), "run")
	if err != nil {
		return nil, err
	}
	return &item.Run, nil
}

// UpdateRun rewrites a run row conditioned on the state the caller last
// observed (optimistic concurrency: two writers racing a transition — say a
// runner completing while the reconciler fails on deadline — resolve to
// exactly one winner). Terminal runs drop out of the ACTIVE_RUNS index.
func (s *RunStore) UpdateRun(ctx context.Context, run *model.Run, expectState model.RunState) error {
	item := runItem{
		PK:     runPK(run.ID),
		SK:     metaSK(),
		GSI1PK: runParentGSI1PK(run.ParentID),
		GSI1SK: runGSI1SK(run.ID),
		Run:    *run,
	}
	if !run.State.Terminal() {
		item.GSI2PK = activeRunsGSI2PK()
		item.GSI2SK = activeRunGSI2SK(run.Deadline, run.ID)
	}
	av := mustAttrs(attributevalue.MarshalMap(item))
	cond := expression.Name("state").Equal(expression.Value(string(expectState)))
	expr := mustExpr(expression.NewBuilder().WithCondition(cond).Build())
	_, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:                 aws.String(s.Table),
		Item:                      av,
		ConditionExpression:       expr.Condition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrStaleRun
		}
		return fmt.Errorf("store: update run: %w", err)
	}
	return nil
}

// RenewRunLease extends ONLY the lease + updatedAt of a non-terminal run,
// leaving every other field untouched. Heartbeats fire every ~15s; rewriting
// the whole row from the heartbeat's stale read (as UpdateRun does) would
// clobber concurrent counter updates — most visibly reverting Spend.Posts,
// which then makes CompleteRun re-post the final answer. This surgical partial
// update touches no counter and no GSI key (GSI2SK encodes the deadline, not
// the lease), so it can never lose a sibling field. A terminal or reassigned
// run fails the condition and returns ErrStaleRun — the heartbeat caller reads
// that as "stop tracking it."
func (s *RunStore) RenewRunLease(ctx context.Context, runID, runnerID string, lease time.Time) error {
	upd := expression.Set(expression.Name("leaseExpiresAt"), expression.Value(lease)).
		Set(expression.Name("updatedAt"), expression.Value(time.Now().UTC()))
	cond := expression.Name("runnerID").Equal(expression.Value(runnerID)).And(runNotTerminal())
	expr := mustExpr(expression.NewBuilder().WithUpdate(upd).WithCondition(cond).Build())
	_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.Table),
		Key:                       compositeKey(runPK(runID), metaSK()),
		UpdateExpression:          expr.Update(),
		ConditionExpression:       expr.Condition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrStaleRun
		}
		return fmt.Errorf("store: renew run lease: %w", err)
	}
	return nil
}

// runNotTerminal is the shared "this run is still live" condition used by
// every surgical (partial-update) writer, so they can never resurrect a run
// that finished between the caller's read and its write.
func runNotTerminal() expression.ConditionBuilder {
	return expression.Name("state").NotEqual(expression.Value(string(model.RunStateCompleted))).
		And(expression.Name("state").NotEqual(expression.Value(string(model.RunStateFailed)))).
		And(expression.Name("state").NotEqual(expression.Value(string(model.RunStateCanceled))))
}

// RunSpendDelta is one runner batch's contribution to a run's ledger, plus the
// liveness facts the batch proves.
type RunSpendDelta struct {
	Turns        int
	InputTokens  int64
	OutputTokens int64
	// LastRunnerSeq is the highest runner sequence counted so far. Persisted so
	// a batch retried after a lost HTTP response contributes nothing twice.
	LastRunnerSeq int64
	// State, when set, moves the run (acknowledged → running on the first
	// state event).
	State model.RunState
	// Deadline, when non-zero, is the extended rolling deadline (its GSI2 sort
	// key moves with it so the sweep sees the extension).
	Deadline time.Time
	// Lease, when non-zero, renews the runner lease.
	Lease time.Time
}

// AddRunSpend applies a batch's spend with ATOMIC ADDs rather than the
// whole-row rewrite UpdateRun performs, and returns the run as it stands after
// the write.
//
// UpdateRun conditions only on state, so two writers that observe the same
// state — an event batch and a concurrent post-count bump — both pass and the
// last one wins, silently reverting the other's counter (a reverted
// Spend.Posts makes CompleteRun re-post the final answer as a duplicate).
// ADD is applied by DynamoDB to the committed value, so no writer can lose
// another's increment, and the caller enforces limits against the returned
// (committed) totals instead of its own arithmetic.
func (s *RunStore) AddRunSpend(ctx context.Context, runID, runnerID string, d RunSpendDelta) (*model.Run, error) {
	upd := expression.
		Add(expression.Name("spend.turns"), expression.Value(d.Turns)).
		Add(expression.Name("spend.inputTokens"), expression.Value(d.InputTokens)).
		Add(expression.Name("spend.outputTokens"), expression.Value(d.OutputTokens)).
		Set(expression.Name("lastRunnerSeq"), expression.Value(d.LastRunnerSeq)).
		Set(expression.Name("updatedAt"), expression.Value(time.Now().UTC()))
	if d.State != "" {
		upd = upd.Set(expression.Name("state"), expression.Value(string(d.State)))
	}
	if !d.Deadline.IsZero() {
		upd = upd.Set(expression.Name("deadline"), expression.Value(d.Deadline)).
			Set(expression.Name("GSI2SK"), expression.Value(activeRunGSI2SK(d.Deadline, runID)))
	}
	if !d.Lease.IsZero() {
		upd = upd.Set(expression.Name("leaseExpiresAt"), expression.Value(d.Lease))
	}
	cond := expression.Name("runnerID").Equal(expression.Value(runnerID)).And(runNotTerminal())
	return s.updateRunReturning(ctx, runID, upd, cond, "add run spend")
}

// AddRunPosts increments the run's post counter atomically and returns the
// committed run — the counterpart to AddRunSpend for the post_message tool, so
// a post bump and an in-flight event batch can no longer clobber each other.
func (s *RunStore) AddRunPosts(ctx context.Context, runID string, delta int) (*model.Run, error) {
	upd := expression.Add(expression.Name("spend.posts"), expression.Value(delta)).
		Set(expression.Name("updatedAt"), expression.Value(time.Now().UTC()))
	return s.updateRunReturning(ctx, runID, upd, runNotTerminal(), "add run posts")
}

// updateRunReturning runs one conditional partial update and returns the whole
// row as committed. A failed condition means the run went terminal or moved to
// another runner — ErrStaleRun, the signal every caller already understands.
func (s *RunStore) updateRunReturning(ctx context.Context, runID string, upd expression.UpdateBuilder, cond expression.ConditionBuilder, what string) (*model.Run, error) {
	expr := mustExpr(expression.NewBuilder().WithUpdate(upd).WithCondition(cond).Build())
	out, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.Table),
		Key:                       compositeKey(runPK(runID), metaSK()),
		UpdateExpression:          expr.Update(),
		ConditionExpression:       expr.Condition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		ReturnValues:              types.ReturnValueAllNew,
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return nil, ErrStaleRun
		}
		return nil, fmt.Errorf("store: %s: %w", what, err)
	}
	var item runItem
	if err := attributevalue.UnmarshalMap(out.Attributes, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal run: %w", err)
	}
	return &item.Run, nil
}

// -------------------------------------------------------------- claim queue

// ListQueuedRuns returns pending queue entries for an owner, oldest first
// (run IDs are ULIDs, so the SK ordering is creation order).
func (s *RunStore) ListQueuedRuns(ctx context.Context, ownerID string, limit int) ([]string, error) {
	keyCond := expression.Key("PK").Equal(expression.Value(runqPK(ownerID)))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	out, err := s.Client.Query(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		Limit:                     aws.Int32(int32(limit)),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list queued runs: %w", err)
	}
	ids := make([]string, 0, len(out.Items))
	for _, raw := range out.Items {
		var item runqItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal run queue item: %w", err)
		}
		ids = append(ids, item.RunID)
	}
	return ids, nil
}

// ClaimRun atomically hands a queued run to a runner: the META row moves
// queued → acknowledged with the runner + lease stamped, and the queue row
// is deleted — all or nothing, so two runners racing the same entry resolve
// to one winner (the loser gets ErrStaleRun).
func (s *RunStore) ClaimRun(ctx context.Context, run *model.Run, runnerID string, lease time.Time) error {
	claimed := *run
	claimed.State = model.RunStateAcknowledged
	claimed.RunnerID = runnerID
	claimed.LeaseExpiresAt = &lease
	claimed.UpdatedAt = time.Now()
	item := runItem{
		PK:     runPK(claimed.ID),
		SK:     metaSK(),
		GSI1PK: runParentGSI1PK(claimed.ParentID),
		GSI1SK: runGSI1SK(claimed.ID),
		GSI2PK: activeRunsGSI2PK(),
		GSI2SK: activeRunGSI2SK(claimed.Deadline, claimed.ID),
		Run:    claimed,
	}
	av := mustAttrs(attributevalue.MarshalMap(item))
	cond := expression.Name("state").Equal(expression.Value(string(model.RunStateQueued)))
	expr := mustExpr(expression.NewBuilder().WithCondition(cond).Build())
	_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{Put: &types.Put{
				TableName:                 aws.String(s.Table),
				Item:                      av,
				ConditionExpression:       expr.Condition(),
				ExpressionAttributeNames:  expr.Names(),
				ExpressionAttributeValues: expr.Values(),
			}},
			{Delete: &types.Delete{
				TableName: aws.String(s.Table),
				Key:       compositeKey(runqPK(claimed.OwnerID), runqSK(claimed.ID)),
			}},
		},
	})
	if err != nil {
		if isTransactionCancelledWithCondition(err) {
			return ErrStaleRun
		}
		return fmt.Errorf("store: claim run: %w", err)
	}
	*run = claimed
	return nil
}

// DeleteQueueEntry removes a claim-queue row outside the claim transaction —
// used when a queued run is failed/canceled before any runner takes it.
func (s *RunStore) DeleteQueueEntry(ctx context.Context, ownerID, runID string) error {
	if _, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(runqPK(ownerID), runqSK(runID)),
	}); err != nil {
		return fmt.Errorf("store: delete run queue entry: %w", err)
	}
	return nil
}

// ------------------------------------------------------------ liveness sweep

// ListActiveRunsPastDeadline returns non-terminal runs whose deadline sorts
// before `now` — one bounded Query on the ACTIVE_RUNS partition, no scan.
func (s *RunStore) ListActiveRunsPastDeadline(ctx context.Context, now time.Time, limit int) ([]*model.Run, error) {
	keyCond := expression.Key("GSI2PK").Equal(expression.Value(activeRunsGSI2PK())).
		And(expression.Key("GSI2SK").LessThan(expression.Value(sortableTime(now))))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	out, err := s.Client.Query(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI2"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		Limit:                     aws.Int32(int32(limit)),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list active runs past deadline: %w", err)
	}
	runs := make([]*model.Run, 0, len(out.Items))
	for _, raw := range out.Items {
		var item runItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal run: %w", err)
		}
		r := item.Run
		runs = append(runs, &r)
	}
	return runs, nil
}

// ListActiveRuns returns every non-terminal run — the whole ACTIVE_RUNS
// partition. Used once at boot so the orchestrator can re-arm lease timers
// after a restart; the partition only holds in-flight runs, so it stays small.
func (s *RunStore) ListActiveRuns(ctx context.Context) ([]*model.Run, error) {
	keyCond := expression.Key("GSI2PK").Equal(expression.Value(activeRunsGSI2PK()))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := queryAllOf[runItem](ctx, s.DB, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI2"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	}, "active runs")
	if err != nil {
		return nil, err
	}
	runs := make([]*model.Run, 0, len(items))
	for _, item := range items {
		r := item.Run
		runs = append(runs, &r)
	}
	return runs, nil
}

// ListRunsByParent returns runs in a channel/conversation, newest first.
func (s *RunStore) ListRunsByParent(ctx context.Context, parentID string, limit int) ([]*model.Run, error) {
	keyCond := expression.Key("GSI1PK").Equal(expression.Value(runParentGSI1PK(parentID)))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	out, err := s.Client.Query(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI1"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		ScanIndexForward:          aws.Bool(false),
		Limit:                     aws.Int32(int32(limit)),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list runs by parent: %w", err)
	}
	runs := make([]*model.Run, 0, len(out.Items))
	for _, raw := range out.Items {
		var item runItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal run: %w", err)
		}
		r := item.Run
		runs = append(runs, &r)
	}
	return runs, nil
}

// ---------------------------------------------------------------- timeline

type runEventItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
	model.RunEvent
}

// AppendRunEvent writes one timeline row, idempotent on (runID, seq): a
// retried write of the same seq is a silent no-op, so a network blip on the
// runner's batch can never duplicate the timeline.
func (s *RunStore) AppendRunEvent(ctx context.Context, evt *model.RunEvent) error {
	if evt.RunID == "" {
		return errors.New("store: run event requires runID")
	}
	item := runEventItem{
		PK:       runPK(evt.RunID),
		SK:       runEvtSK(evt.Seq),
		RunEvent: *evt,
	}
	av := mustAttrs(attributevalue.MarshalMap(item))
	_, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(s.Table),
		Item:                av,
		ConditionExpression: aws.String("attribute_not_exists(PK)"),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return nil // duplicate seq — already recorded, idempotent success
		}
		return fmt.Errorf("store: append run event: %w", err)
	}
	return nil
}

// DeleteRunEvents removes every EVT# row for a run. Called after the events
// have been archived to object storage on terminal state, so the hot table
// holds only live runs' timelines.
//
// Task-mode timelines are turn-uncapped, so this can be thousands of rows:
// the query projects KEYS ONLY (no payloads read back) and the deletes go out
// 25 at a time, draining UnprocessedItems — the same discipline the token
// revocation sweep uses.
func (s *RunStore) DeleteRunEvents(ctx context.Context, runID string) error {
	keyCond := expression.Key("PK").Equal(expression.Value(runPK(runID))).
		And(expression.Key("SK").BeginsWith("EVT#"))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		ProjectionExpression:      aws.String("PK, SK"),
	})
	if err != nil {
		return fmt.Errorf("store: list run events for delete: %w", err)
	}
	return s.batchDeleteKeys(ctx, items, "delete run events")
}

// batchDeleteKeys deletes the PK/SK pairs of already-fetched rows in batches of
// 25, retrying UnprocessedItems: under throttling DynamoDB returns deletes it
// silently did NOT apply, and a dropped delete here would leave orphan rows
// behind an archived timeline.
func (s *RunStore) batchDeleteKeys(ctx context.Context, items []map[string]types.AttributeValue, what string) error {
	for i := 0; i < len(items); i += 25 {
		end := min(i+25, len(items))
		batch := make([]types.WriteRequest, 0, end-i)
		for _, item := range items[i:end] {
			batch = append(batch, types.WriteRequest{
				DeleteRequest: &types.DeleteRequest{
					Key: map[string]types.AttributeValue{"PK": item["PK"], "SK": item["SK"]},
				},
			})
		}
		input := &dynamodb.BatchWriteItemInput{
			RequestItems: map[string][]types.WriteRequest{s.Table: batch},
		}
		for attempt := 0; attempt < 3; attempt++ {
			out, err := s.Client.BatchWriteItem(ctx, input)
			if err != nil {
				return fmt.Errorf("store: %s: %w", what, err)
			}
			if len(out.UnprocessedItems[s.Table]) == 0 {
				break
			}
			if attempt == 2 {
				return fmt.Errorf("store: %s: %d unprocessed after retries", what, len(out.UnprocessedItems[s.Table]))
			}
			input.RequestItems = out.UnprocessedItems
		}
	}
	return nil
}

// ListRunEvents returns a run's timeline in seq order (the zero-padded SK
// sorts numerically).
func (s *RunStore) ListRunEvents(ctx context.Context, runID string) ([]*model.RunEvent, error) {
	keyCond := expression.Key("PK").Equal(expression.Value(runPK(runID))).
		And(expression.Key("SK").BeginsWith("EVT#"))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := queryAllOf[runEventItem](ctx, s.DB, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	}, "run events")
	if err != nil {
		return nil, err
	}
	out := make([]*model.RunEvent, 0, len(items))
	for _, item := range items {
		e := item.RunEvent
		e.RunID = runID
		out = append(out, &e)
	}
	return out, nil
}

// ------------------------------------------------------------------ digest

type runDigestItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
	model.RunDigest
}

// PutDigest writes the run's terminal digest.
func (s *RunStore) PutDigest(ctx context.Context, d *model.RunDigest) error {
	item := runDigestItem{
		PK:        runPK(d.RunID),
		SK:        runDigestSK(),
		RunDigest: *d,
	}
	av := mustAttrs(attributevalue.MarshalMap(item))
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      av,
	}); err != nil {
		return fmt.Errorf("store: put run digest: %w", err)
	}
	return nil
}

// GetDigest fetches a run's digest, ErrNotFound when none was written.
func (s *RunStore) GetDigest(ctx context.Context, runID string) (*model.RunDigest, error) {
	item, err := getItem[runDigestItem](ctx, s.DB, runPK(runID), runDigestSK(), "run digest")
	if err != nil {
		return nil, err
	}
	d := item.RunDigest
	d.RunID = runID
	return &d, nil
}
