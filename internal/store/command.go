package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// ExternalCommandStore persists admin-registered slash commands.
//
// Two invariants drive the layout: a trigger word must be unique (two "/deploy"
// commands would make dispatch ambiguous), and the full list must be readable
// without a Scan on a table shared with every message. So each command has a META
// row, a TRIGGER claim row committed in the same transaction, and an id in a
// single directory row — the same shape as bots and incoming webhooks.
type ExternalCommandStore interface {
	// CreateCommand writes the command and claims its trigger. Returns
	// ErrAlreadyExists if the trigger is taken.
	CreateCommand(ctx context.Context, cmd *model.ExternalCommand) error
	// UpdateCommand overwrites a command whose trigger has not changed.
	UpdateCommand(ctx context.Context, cmd *model.ExternalCommand) error
	GetCommand(ctx context.Context, id string) (*model.ExternalCommand, error)
	// GetCommandByTrigger resolves a trigger word to its command via the claim row.
	GetCommandByTrigger(ctx context.Context, trigger string) (*model.ExternalCommand, error)
	ListCommands(ctx context.Context) ([]*model.ExternalCommand, error)
	// DeleteCommand removes the command, its trigger claim, and its directory entry.
	DeleteCommand(ctx context.Context, id string) error
}

type ExternalCommandStoreImpl struct {
	*DB
}

var _ ExternalCommandStore = (*ExternalCommandStoreImpl)(nil)

func NewExternalCommandStore(db *DB) *ExternalCommandStoreImpl {
	return &ExternalCommandStoreImpl{DB: db}
}

type extCommandItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
	model.ExternalCommand
}

// extCommandTriggerItem is the uniqueness claim for one trigger word. It stores
// only the owning command id — the trigger lookup is a keyed GetItem followed by
// a keyed GetItem, never a Query.
type extCommandTriggerItem struct {
	PK        string `dynamodbav:"PK"`
	SK        string `dynamodbav:"SK"`
	CommandID string `dynamodbav:"commandID"`
}

const extCommandDirPK = "COMMANDDIR"

type extCommandDirRow struct {
	IDs []string `dynamodbav:"ids,stringset,omitempty"`
}

func (s *ExternalCommandStoreImpl) CreateCommand(ctx context.Context, cmd *model.ExternalCommand) error {
	item := extCommandItem{PK: extCommandPK(cmd.ID), SK: metaSK(), ExternalCommand: *cmd}
	claim := extCommandTriggerItem{PK: extCommandTriggerPK(cmd.Trigger), SK: metaSK(), CommandID: cmd.ID}
	// All three writes commit together: a claimed trigger with no command would
	// permanently block that word, and a command with no claim would let a second
	// one take the same trigger.
	_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{Put: &types.Put{
				TableName:           aws.String(s.Table),
				Item:                mustAttrs(attributevalue.MarshalMap(item)),
				ConditionExpression: aws.String("attribute_not_exists(PK)"),
			}},
			{Put: &types.Put{
				TableName:           aws.String(s.Table),
				Item:                mustAttrs(attributevalue.MarshalMap(claim)),
				ConditionExpression: aws.String("attribute_not_exists(PK)"),
			}},
			{Update: &types.Update{
				TableName:        aws.String(s.Table),
				Key:              compositeKey(extCommandDirPK, metaSK()),
				UpdateExpression: aws.String("ADD ids :id"),
				ExpressionAttributeValues: map[string]types.AttributeValue{
					":id": &types.AttributeValueMemberSS{Value: []string{cmd.ID}},
				},
			}},
		},
	})
	if err != nil {
		if isTransactionCancelledWithCondition(err) {
			return ErrAlreadyExists
		}
		return fmt.Errorf("store: create command: %w", err)
	}
	return nil
}

// UpdateCommand overwrites the META row. The caller guarantees the trigger is
// unchanged (the service re-creates the command when a trigger moves), so no
// claim row is touched here.
func (s *ExternalCommandStoreImpl) UpdateCommand(ctx context.Context, cmd *model.ExternalCommand) error {
	item := extCommandItem{PK: extCommandPK(cmd.ID), SK: metaSK(), ExternalCommand: *cmd}
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(s.Table),
		Item:                mustAttrs(attributevalue.MarshalMap(item)),
		ConditionExpression: aws.String("attribute_exists(PK)"),
	}); err != nil {
		if isConditionCheckFailed(err) {
			return ErrNotFound
		}
		return fmt.Errorf("store: update command: %w", err)
	}
	return nil
}

func (s *ExternalCommandStoreImpl) GetCommand(ctx context.Context, id string) (*model.ExternalCommand, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(extCommandPK(id), metaSK()),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get command: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var item extCommandItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal command: %w", err)
	}
	return &item.ExternalCommand, nil
}

func (s *ExternalCommandStoreImpl) GetCommandByTrigger(ctx context.Context, trigger string) (*model.ExternalCommand, error) {
	if strings.TrimSpace(trigger) == "" {
		return nil, ErrNotFound
	}
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(extCommandTriggerPK(trigger), metaSK()),
		// Strongly consistent: a command created moments ago must be runnable on
		// the very next invocation, and this is the lookup that decides.
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get command trigger: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var claim extCommandTriggerItem
	if err := attributevalue.UnmarshalMap(out.Item, &claim); err != nil {
		return nil, fmt.Errorf("store: unmarshal command trigger: %w", err)
	}
	return s.GetCommand(ctx, claim.CommandID)
}

func (s *ExternalCommandStoreImpl) ListCommands(ctx context.Context) ([]*model.ExternalCommand, error) {
	dirOut, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(s.Table),
		Key:            compositeKey(extCommandDirPK, metaSK()),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get command directory: %w", err)
	}
	if dirOut.Item == nil {
		return []*model.ExternalCommand{}, nil
	}
	var dir extCommandDirRow
	if err := attributevalue.UnmarshalMap(dirOut.Item, &dir); err != nil {
		return nil, fmt.Errorf("store: unmarshal command directory: %w", err)
	}

	// An id whose META row is gone (crashed half-delete) is skipped; the next
	// delete prunes it from the set.
	items := make([]*model.ExternalCommand, 0, len(dir.IDs))
	const batchSize = 100
	for start := 0; start < len(dir.IDs); start += batchSize {
		end := min(start+batchSize, len(dir.IDs))
		keys := make([]map[string]types.AttributeValue, 0, end-start)
		for _, id := range dir.IDs[start:end] {
			keys = append(keys, compositeKey(extCommandPK(id), metaSK()))
		}
		req := map[string]types.KeysAndAttributes{s.Table: {Keys: keys, ConsistentRead: aws.Bool(true)}}
		for {
			res, err := s.Client.BatchGetItem(ctx, &dynamodb.BatchGetItemInput{RequestItems: req})
			if err != nil {
				return nil, fmt.Errorf("store: batch get commands: %w", err)
			}
			for _, av := range res.Responses[s.Table] {
				var item extCommandItem
				if err := attributevalue.UnmarshalMap(av, &item); err != nil {
					return nil, fmt.Errorf("store: unmarshal command: %w", err)
				}
				items = append(items, &item.ExternalCommand)
			}
			if len(res.UnprocessedKeys) == 0 {
				break
			}
			req = res.UnprocessedKeys
		}
	}
	return items, nil
}

func (s *ExternalCommandStoreImpl) DeleteCommand(ctx context.Context, id string) error {
	cmd, err := s.GetCommand(ctx, id)
	if err != nil {
		return err
	}
	// Releasing the trigger claim in the same transaction as the delete means the
	// word is free for reuse the instant the command is gone — and can never be
	// released while the command still exists.
	_, err = s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{Delete: &types.Delete{
				TableName: aws.String(s.Table),
				Key:       compositeKey(extCommandPK(id), metaSK()),
			}},
			{Delete: &types.Delete{
				TableName: aws.String(s.Table),
				Key:       compositeKey(extCommandTriggerPK(cmd.Trigger), metaSK()),
			}},
			{Update: &types.Update{
				TableName:        aws.String(s.Table),
				Key:              compositeKey(extCommandDirPK, metaSK()),
				UpdateExpression: aws.String("DELETE ids :id"),
				ExpressionAttributeValues: map[string]types.AttributeValue{
					":id": &types.AttributeValueMemberSS{Value: []string{id}},
				},
			}},
		},
	})
	if err != nil {
		return fmt.Errorf("store: delete command: %w", err)
	}
	return nil
}
