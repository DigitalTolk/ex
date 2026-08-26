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

// Thread-scoped agent coordination rows: task claims (first-write-wins work
// splitting between co-invoked agents) and thread follows (which agents keep
// listening to whose un-tagged replies). Both TTL'd — a thread's
// coordination state has no value days later.

const (
	// Claims coordinate one burst of parallel work — worthless days later.
	taskClaimTTL = 48 * time.Hour
	// Follow markers back "always"-mode follow-ups, so they live as long as
	// a thread plausibly stays active; 30 days of agent silence reaps them.
	agentFollowTTL = 30 * 24 * time.Hour
)

// ErrClaimTaken signals another agent already holds this label.
var ErrClaimTaken = errors.New("store: task label already claimed")

type taskClaimItem struct {
	PK  string `dynamodbav:"PK"`
	SK  string `dynamodbav:"SK"`
	TTL int64  `dynamodbav:"ttl"`
	model.TaskClaim
}

// PutTaskClaim writes a claim iff the label is free — the atomic tiebreak
// two parallel agents need. Returns ErrClaimTaken when someone beat us.
func (s *AgentStore) PutTaskClaim(ctx context.Context, c *model.TaskClaim) error {
	if c.ParentID == "" || c.ThreadRootID == "" || c.Label == "" {
		return errors.New("store: task claim requires parentID, threadRootID, label")
	}
	item := taskClaimItem{
		PK:        taskClaimPK(c.ParentID, c.ThreadRootID),
		SK:        taskClaimSK(c.Label),
		TTL:       c.CreatedAt.Add(taskClaimTTL).Unix(),
		TaskClaim: *c,
	}
	av := mustAttrs(attributevalue.MarshalMap(item))
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(s.Table),
		Item:                av,
		ConditionExpression: aws.String("attribute_not_exists(PK)"),
	}); err != nil {
		var cond *types.ConditionalCheckFailedException
		if errors.As(err, &cond) {
			return ErrClaimTaken
		}
		return fmt.Errorf("store: put task claim: %w", err)
	}
	return nil
}

// ListTaskClaims returns every claim in a thread, oldest label-order.
func (s *AgentStore) ListTaskClaims(ctx context.Context, parentID, threadRootID string) ([]*model.TaskClaim, error) {
	keyCond := expression.Key("PK").Equal(expression.Value(taskClaimPK(parentID, threadRootID))).
		And(expression.Key("SK").BeginsWith("L#"))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list task claims: %w", err)
	}
	out := make([]*model.TaskClaim, 0, len(items))
	for _, raw := range items {
		var item taskClaimItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal task claim: %w", err)
		}
		out = append(out, &item.TaskClaim)
	}
	return out, nil
}

// ------------------------------------------------------------ thread follows

type agentFollowItem struct {
	PK  string `dynamodbav:"PK"`
	SK  string `dynamodbav:"SK"`
	TTL int64  `dynamodbav:"ttl"`
	model.AgentThreadFollow
}

// PutAgentFollow upserts the (agent, invoker) follow marker for a thread —
// called on every agent post, refreshing LastPostAt and the TTL.
func (s *AgentStore) PutAgentFollow(ctx context.Context, f *model.AgentThreadFollow) error {
	if f.ParentID == "" || f.ThreadRootID == "" || f.AgentID == "" || f.InvokerID == "" {
		return errors.New("store: agent follow requires parentID, threadRootID, agentID, invokerID")
	}
	item := agentFollowItem{
		PK:                agentFollowPK(f.ParentID, f.ThreadRootID),
		SK:                agentFollowSK(f.AgentID, f.InvokerID),
		TTL:               f.LastPostAt.Add(agentFollowTTL).Unix(),
		AgentThreadFollow: *f,
	}
	av := mustAttrs(attributevalue.MarshalMap(item))
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      av,
	}); err != nil {
		return fmt.Errorf("store: put agent follow: %w", err)
	}
	return nil
}

// ListAgentFollows returns every follow marker on a thread.
func (s *AgentStore) ListAgentFollows(ctx context.Context, parentID, threadRootID string) ([]*model.AgentThreadFollow, error) {
	keyCond := expression.Key("PK").Equal(expression.Value(agentFollowPK(parentID, threadRootID))).
		And(expression.Key("SK").BeginsWith("F#"))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list agent follows: %w", err)
	}
	out := make([]*model.AgentThreadFollow, 0, len(items))
	for _, raw := range items {
		var item agentFollowItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal agent follow: %w", err)
		}
		out = append(out, &item.AgentThreadFollow)
	}
	return out, nil
}
