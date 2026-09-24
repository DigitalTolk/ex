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
)

// Skills (plan.md §2c): workspace-wide instruction packs, listed via GSI2.
// Methods live on AgentStore — skills are part of the agent surface.

type skillItem struct {
	PK     string `dynamodbav:"PK"`
	SK     string `dynamodbav:"SK"`
	GSI2PK string `dynamodbav:"GSI2PK"`
	GSI2SK string `dynamodbav:"GSI2SK"`
	model.Skill
}

// PutSkill creates or replaces a skill.
func (s *AgentStore) PutSkill(ctx context.Context, sk *model.Skill) error {
	if sk.ID == "" {
		return errors.New("store: skill id required")
	}
	item := skillItem{
		PK:     skillPK(sk.ID),
		SK:     metaSK(),
		GSI2PK: allSkillsGSI2PK(),
		GSI2SK: skillPK(sk.ID),
		Skill:  *sk,
	}
	av := mustAttrs(attributevalue.MarshalMap(item))
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      av,
	}); err != nil {
		return fmt.Errorf("store: put skill: %w", err)
	}
	return nil
}

// GetSkill fetches one skill.
func (s *AgentStore) GetSkill(ctx context.Context, id string) (*model.Skill, error) {
	item, err := getItem[skillItem](ctx, s.DB, skillPK(id), metaSK(), "skill")
	if err != nil {
		return nil, err
	}
	return &item.Skill, nil
}

// ListSkills returns every workspace skill.
func (s *AgentStore) ListSkills(ctx context.Context) ([]*model.Skill, error) {
	keyCond := expression.Key("GSI2PK").Equal(expression.Value(allSkillsGSI2PK()))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := queryAllOf[skillItem](ctx, s.DB, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI2"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	}, "skills")
	if err != nil {
		return nil, err
	}
	out := make([]*model.Skill, 0, len(items))
	for _, item := range items {
		out = append(out, &item.Skill)
	}
	return out, nil
}

// ListSkillIndex is ListSkills projected to the routing fields (id, name,
// description) — Instructions are NOT loaded.
//
// The bundle's ambient skill index and the list_skills tool need a line each;
// reading full 8KB instruction bodies for every skill on every bundle build
// (and every tool call) to render a ~2KB index was most of that read wasted.
// The full row is one GetSkill away for the skills that are actually used.
func (s *AgentStore) ListSkillIndex(ctx context.Context) ([]*model.Skill, error) {
	keyCond := expression.Key("GSI2PK").Equal(expression.Value(allSkillsGSI2PK()))
	proj := expression.NamesList(expression.Name("id"), expression.Name("name"), expression.Name("description"))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).WithProjection(proj).Build())
	items, err := queryAllOf[skillItem](ctx, s.DB, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI2"),
		KeyConditionExpression:    expr.KeyCondition(),
		ProjectionExpression:      expr.Projection(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	}, "skill index")
	if err != nil {
		return nil, err
	}
	out := make([]*model.Skill, 0, len(items))
	for _, item := range items {
		out = append(out, &item.Skill)
	}
	return out, nil
}

// DeleteSkill removes a skill.
func (s *AgentStore) DeleteSkill(ctx context.Context, id string) error {
	if _, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(skillPK(id), metaSK()),
	}); err != nil {
		return fmt.Errorf("store: delete skill: %w", err)
	}
	return nil
}
