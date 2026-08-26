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
)

// AgentStore persists agent templates, agent-instance user rows (with the
// owner GSI), and runner registrations.
type AgentStore struct {
	*DB
}

// NewAgentStore returns an AgentStore backed by the shared DB.
func NewAgentStore(db *DB) *AgentStore { return &AgentStore{DB: db} }

// ---------------------------------------------------------------- templates

type agentTplItem struct {
	PK     string `dynamodbav:"PK"`
	SK     string `dynamodbav:"SK"`
	GSI2PK string `dynamodbav:"GSI2PK"`
	GSI2SK string `dynamodbav:"GSI2SK"`
	model.AgentTemplate
}

// PutTemplate creates or replaces an agent template. Seeding and admin edits
// both go through here; instances resolve against the latest template at run
// start, so no fan-out is needed.
func (s *AgentStore) PutTemplate(ctx context.Context, tpl *model.AgentTemplate) error {
	if tpl.Slug == "" {
		return errors.New("store: agent template slug required")
	}
	item := agentTplItem{
		PK:            agentTplPK(tpl.Slug),
		SK:            metaSK(),
		GSI2PK:        allAgentTplGSI2PK(),
		GSI2SK:        agentTplPK(tpl.Slug),
		AgentTemplate: *tpl,
	}
	av := mustAttrs(attributevalue.MarshalMap(item))
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      av,
	}); err != nil {
		return fmt.Errorf("store: put agent template: %w", err)
	}
	return nil
}

// CreateTemplateIfAbsent writes the template only when no row exists — the
// boot-time seed must never clobber admin edits.
func (s *AgentStore) CreateTemplateIfAbsent(ctx context.Context, tpl *model.AgentTemplate) error {
	item := agentTplItem{
		PK:            agentTplPK(tpl.Slug),
		SK:            metaSK(),
		GSI2PK:        allAgentTplGSI2PK(),
		GSI2SK:        agentTplPK(tpl.Slug),
		AgentTemplate: *tpl,
	}
	av := mustAttrs(attributevalue.MarshalMap(item))
	_, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(s.Table),
		Item:                av,
		ConditionExpression: aws.String("attribute_not_exists(PK)"),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrAlreadyExists
		}
		return fmt.Errorf("store: seed agent template: %w", err)
	}
	return nil
}

// GetTemplate fetches one template by slug.
func (s *AgentStore) GetTemplate(ctx context.Context, slug string) (*model.AgentTemplate, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(agentTplPK(slug), metaSK()),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get agent template: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var item agentTplItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal agent template: %w", err)
	}
	return &item.AgentTemplate, nil
}

// ListTemplates returns every agent template.
func (s *AgentStore) ListTemplates(ctx context.Context) ([]*model.AgentTemplate, error) {
	keyCond := expression.Key("GSI2PK").Equal(expression.Value(allAgentTplGSI2PK()))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI2"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list agent templates: %w", err)
	}
	out := make([]*model.AgentTemplate, 0, len(items))
	for _, raw := range items {
		var item agentTplItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal agent template: %w", err)
		}
		tpl := item.AgentTemplate
		out = append(out, &tpl)
	}
	return out, nil
}

// ------------------------------------------------------ shared agent users

// agentUserItem is the user row shape for the shared agent users — the
// standard userItem layout (ALL_USERS GSI2 included, so agents appear in
// member lists and pickers like anyone else).
type agentUserItem struct {
	PK     string `dynamodbav:"PK"`
	SK     string `dynamodbav:"SK"`
	GSI2PK string `dynamodbav:"GSI2PK"`
	GSI2SK string `dynamodbav:"GSI2SK"`
	model.User
}

// CreateAgentUser writes a shared agent user row (one per template slug,
// deterministic ID). Conditional so concurrent boots converge on one row.
// Agent users carry no email-index row — they can never authenticate.
func (s *AgentStore) CreateAgentUser(ctx context.Context, user *model.User) error {
	if !user.IsAgent() || user.AgentConfig == nil {
		return errors.New("store: not an agent user")
	}
	item := agentUserItem{
		PK:     userPK(user.ID),
		SK:     profileSK(),
		GSI2PK: allUsersGSI2PK(),
		GSI2SK: user.CreatedAt.Format(time.RFC3339Nano) + "#" + user.ID,
		User:   *user,
	}
	av := mustAttrs(attributevalue.MarshalMap(item))
	_, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(s.Table),
		Item:                av,
		ConditionExpression: aws.String("attribute_not_exists(PK)"),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrAlreadyExists
		}
		return fmt.Errorf("store: create agent user: %w", err)
	}
	return nil
}

// --------------------------------------------------------- per-user prefs

type agentPrefsItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
	model.UserAgentPrefs
}

// PutAgentPrefs upserts one user's preferences for a shared agent.
func (s *AgentStore) PutAgentPrefs(ctx context.Context, prefs *model.UserAgentPrefs) error {
	if prefs.UserID == "" || prefs.Slug == "" {
		return errors.New("store: agent prefs require userID and slug")
	}
	item := agentPrefsItem{
		PK:             userPK(prefs.UserID),
		SK:             agentPrefsSK(prefs.Slug),
		UserAgentPrefs: *prefs,
	}
	av := mustAttrs(attributevalue.MarshalMap(item))
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      av,
	}); err != nil {
		return fmt.Errorf("store: put agent prefs: %w", err)
	}
	return nil
}

// GetAgentPrefs fetches one user's preferences for a slug. ErrNotFound when
// they never customized it — callers treat that as "inherit everything".
func (s *AgentStore) GetAgentPrefs(ctx context.Context, userID, slug string) (*model.UserAgentPrefs, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(userPK(userID), agentPrefsSK(slug)),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get agent prefs: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var item agentPrefsItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal agent prefs: %w", err)
	}
	p := item.UserAgentPrefs
	return &p, nil
}

// -------------------------------------------------------------- runner rows

type runnerItem struct {
	PK  string `dynamodbav:"PK"`
	SK  string `dynamodbav:"SK"`
	TTL int64  `dynamodbav:"ttl"`
	model.RunnerRegistration
}

// runnerTTLGrace pads the DynamoDB TTL past the lease so a runner that
// heartbeats late doesn't lose its row to the reaper mid-blip. TTL deletion
// is lazy anyway; liveness checks always use LeaseExpiresAt.
const runnerTTLGrace = 24 * time.Hour

// PutRunner upserts a runner registration under its owner's partition,
// refreshing the lease and the self-reaping TTL.
func (s *AgentStore) PutRunner(ctx context.Context, reg *model.RunnerRegistration) error {
	if reg.RunnerID == "" || reg.OwnerID == "" {
		return errors.New("store: runner id and owner required")
	}
	item := runnerItem{
		PK:                 userPK(reg.OwnerID),
		SK:                 runnerSK(reg.RunnerID),
		TTL:                reg.LeaseExpiresAt.Add(runnerTTLGrace).Unix(),
		RunnerRegistration: *reg,
	}
	av := mustAttrs(attributevalue.MarshalMap(item))
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      av,
	}); err != nil {
		return fmt.Errorf("store: put runner: %w", err)
	}
	return nil
}

// ListRunners returns the owner's registered runners, live and lapsed alike;
// callers filter on LeaseExpiresAt.
func (s *AgentStore) ListRunners(ctx context.Context, ownerID string) ([]*model.RunnerRegistration, error) {
	keyCond := expression.Key("PK").Equal(expression.Value(userPK(ownerID))).
		And(expression.Key("SK").BeginsWith("RUNNER#"))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list runners: %w", err)
	}
	out := make([]*model.RunnerRegistration, 0, len(items))
	for _, raw := range items {
		var item runnerItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal runner: %w", err)
		}
		reg := item.RunnerRegistration
		out = append(out, &reg)
	}
	return out, nil
}

// DeleteRunner removes a registration (clean shutdown).
func (s *AgentStore) DeleteRunner(ctx context.Context, ownerID, runnerID string) error {
	if _, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(userPK(ownerID), runnerSK(runnerID)),
	}); err != nil {
		return fmt.Errorf("store: delete runner: %w", err)
	}
	return nil
}
