package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// Agent core memory + channel subscriptions (buzz-inspired). Methods live on
// AgentStore, same as prefs and skills.

type agentMemItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
	model.AgentMemory
}

// PutAgentMemory replaces the (agent, invoker) core memory.
func (s *AgentStore) PutAgentMemory(ctx context.Context, m *model.AgentMemory) error {
	if m.AgentID == "" || m.InvokerID == "" {
		return errors.New("store: agent memory requires agentID and invokerID")
	}
	item := agentMemItem{PK: userPK(m.InvokerID), SK: agentMemSK(m.AgentID), AgentMemory: *m}
	av := mustAttrs(attributevalue.MarshalMap(item))
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      av,
	}); err != nil {
		return fmt.Errorf("store: put agent memory: %w", err)
	}
	return nil
}

// GetAgentMemory fetches the (agent, invoker) core memory.
func (s *AgentStore) GetAgentMemory(ctx context.Context, invokerID, agentID string) (*model.AgentMemory, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(userPK(invokerID), agentMemSK(agentID)),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get agent memory: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var item agentMemItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal agent memory: %w", err)
	}
	return &item.AgentMemory, nil
}

// ---------------------------------------------------------- subscriptions

type agentSubItem struct {
	PK     string `dynamodbav:"PK"`
	SK     string `dynamodbav:"SK"`
	GSI2PK string `dynamodbav:"GSI2PK"`
	GSI2SK string `dynamodbav:"GSI2SK"`
	model.AgentSubscription
}

// PutAgentSubscription creates or replaces a subscription.
func (s *AgentStore) PutAgentSubscription(ctx context.Context, sub *model.AgentSubscription) error {
	if sub.ID == "" || sub.ParentID == "" {
		return errors.New("store: subscription requires id and parentID")
	}
	item := agentSubItem{
		PK:                agentSubPK(sub.ParentID),
		SK:                agentSubSK(sub.ID),
		GSI2PK:            allAgentSubsGSI2PK(),
		GSI2SK:            agentSubSK(sub.ID),
		AgentSubscription: *sub,
	}
	av := mustAttrs(attributevalue.MarshalMap(item))
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      av,
	}); err != nil {
		return fmt.Errorf("store: put agent subscription: %w", err)
	}
	return nil
}

// ListSubscriptionsByParent returns every subscription watching one parent.
func (s *AgentStore) ListSubscriptionsByParent(ctx context.Context, parentID string) ([]*model.AgentSubscription, error) {
	keyCond := expression.Key("PK").Equal(expression.Value(agentSubPK(parentID))).
		And(expression.Key("SK").BeginsWith("SUB#"))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list subscriptions: %w", err)
	}
	return unmarshalSubs(items)
}

// ListAllSubscriptions returns every subscription (heartbeat sweep).
func (s *AgentStore) ListAllSubscriptions(ctx context.Context) ([]*model.AgentSubscription, error) {
	keyCond := expression.Key("GSI2PK").Equal(expression.Value(allAgentSubsGSI2PK()))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI2"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list all subscriptions: %w", err)
	}
	return unmarshalSubs(items)
}

// DeleteAgentSubscription removes a subscription.
func (s *AgentStore) DeleteAgentSubscription(ctx context.Context, parentID, id string) error {
	if _, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(agentSubPK(parentID), agentSubSK(id)),
	}); err != nil {
		return fmt.Errorf("store: delete agent subscription: %w", err)
	}
	return nil
}

func unmarshalSubs(items []map[string]types.AttributeValue) ([]*model.AgentSubscription, error) {
	out := make([]*model.AgentSubscription, 0, len(items))
	for _, raw := range items {
		var item agentSubItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal subscription: %w", err)
		}
		out = append(out, &item.AgentSubscription)
	}
	return out, nil
}
