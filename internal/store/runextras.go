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

// Approvals and artifacts (plan-v2 §7): both live under RUN#<id> next to the
// EVT# timeline.

// ErrStaleApproval signals a decision raced another writer (already decided
// or expired).
var ErrStaleApproval = errors.New("store: approval no longer pending")

type approvalItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
	model.Approval
}

// PutApproval creates the pending approval row.
func (s *RunStore) PutApproval(ctx context.Context, a *model.Approval) error {
	if a.RunID == "" || a.ID == "" {
		return errors.New("store: approval requires runID and id")
	}
	item := approvalItem{PK: runPK(a.RunID), SK: approvalSK(a.ID), Approval: *a}
	av := mustAttrs(attributevalue.MarshalMap(item))
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(s.Table),
		Item:                av,
		ConditionExpression: aws.String("attribute_not_exists(PK)"),
	}); err != nil {
		return fmt.Errorf("store: put approval: %w", err)
	}
	return nil
}

// GetApproval fetches one approval.
func (s *RunStore) GetApproval(ctx context.Context, runID, approvalID string) (*model.Approval, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(runPK(runID), approvalSK(approvalID)),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get approval: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var item approvalItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal approval: %w", err)
	}
	return &item.Approval, nil
}

// SettleApproval moves a PENDING approval to a terminal state (recording the
// chosen option for ask_user gates). Conditional on pending so a decision and
// the expiry sweep can race safely — exactly one writer wins; the loser gets
// ErrStaleApproval.
func (s *RunStore) SettleApproval(ctx context.Context, runID, approvalID, state, decidedBy, choice, note string, decidedAt time.Time) error {
	_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:           aws.String(s.Table),
		Key:                 compositeKey(runPK(runID), approvalSK(approvalID)),
		UpdateExpression:    aws.String("SET #st = :st, decidedBy = :by, decidedAt = :at, #ch = :ch, note = :note"),
		ConditionExpression: aws.String("#st = :pending"),
		ExpressionAttributeNames: map[string]string{
			"#st": "state",
			"#ch": "choice",
		},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":st":      &types.AttributeValueMemberS{Value: state},
			":by":      &types.AttributeValueMemberS{Value: decidedBy},
			":at":      &types.AttributeValueMemberS{Value: decidedAt.UTC().Format(time.RFC3339Nano)},
			":ch":      &types.AttributeValueMemberS{Value: choice},
			":note":    &types.AttributeValueMemberS{Value: note},
			":pending": &types.AttributeValueMemberS{Value: model.ApprovalPending},
		},
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrStaleApproval
		}
		return fmt.Errorf("store: settle approval: %w", err)
	}
	return nil
}

// ListApprovals returns a run's approvals in creation (ULID) order.
func (s *RunStore) ListApprovals(ctx context.Context, runID string) ([]*model.Approval, error) {
	keyCond := expression.Key("PK").Equal(expression.Value(runPK(runID))).
		And(expression.Key("SK").BeginsWith("APPROVAL#"))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list approvals: %w", err)
	}
	out := make([]*model.Approval, 0, len(items))
	for _, raw := range items {
		var item approvalItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal approval: %w", err)
		}
		out = append(out, &item.Approval)
	}
	return out, nil
}

// ---------------------------------------------------------------- artifacts

type artifactItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
	model.Artifact
}

// PutArtifact stores one run artifact (content inline, size-capped at the
// service layer).
func (s *RunStore) PutArtifact(ctx context.Context, a *model.Artifact) error {
	if a.RunID == "" || a.ID == "" {
		return errors.New("store: artifact requires runID and id")
	}
	item := artifactItem{PK: runPK(a.RunID), SK: artifactSK(a.ID), Artifact: *a}
	av := mustAttrs(attributevalue.MarshalMap(item))
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      av,
	}); err != nil {
		return fmt.Errorf("store: put artifact: %w", err)
	}
	return nil
}

// ListArtifacts returns a run's artifacts in creation (ULID) order.
func (s *RunStore) ListArtifacts(ctx context.Context, runID string) ([]*model.Artifact, error) {
	keyCond := expression.Key("PK").Equal(expression.Value(runPK(runID))).
		And(expression.Key("SK").BeginsWith("ART#"))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list artifacts: %w", err)
	}
	out := make([]*model.Artifact, 0, len(items))
	for _, raw := range items {
		var item artifactItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal artifact: %w", err)
		}
		out = append(out, &item.Artifact)
	}
	return out, nil
}
