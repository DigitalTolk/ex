package store

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

// Connectors: admin-ingested API docs bundles + per-user installs.
//
// Key schema:
//   CONNECTOR#slug / META        connector metadata (GSI2: ALL_CONNECTORS)
//   CONNECTOR#slug / FILE#name   one docs file
//   USER#id        / CONNINST#slug  a user's install (token + status)

type ConnectorStore struct {
	*DB
}

func NewConnectorStore(db *DB) *ConnectorStore { return &ConnectorStore{DB: db} }

func connectorPK(slug string) string    { return "CONNECTOR#" + slug }
func connectorFileSK(name string) string { return "FILE#" + name }
func allConnectorsGSI2PK() string       { return "ALL_CONNECTORS" }
func connInstallSK(slug string) string  { return "CONNINST#" + slug }

type connectorItem struct {
	PK     string `dynamodbav:"PK"`
	SK     string `dynamodbav:"SK"`
	GSI2PK string `dynamodbav:"GSI2PK"`
	GSI2SK string `dynamodbav:"GSI2SK"`
	model.Connector
}

type connectorFileItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
	model.ConnectorFile
}

type connectorInstallItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
	model.ConnectorInstall
}

// PutConnector writes the connector metadata row and every docs file.
// Replaces any previous version wholesale (stale files are deleted).
func (s *ConnectorStore) PutConnector(ctx context.Context, c *model.Connector, files []model.ConnectorFile) error {
	if c.Slug == "" {
		return errors.New("store: connector slug required")
	}
	// Delete files that are no longer in the manifest.
	if old, err := s.GetConnector(ctx, c.Slug); err == nil {
		keep := make(map[string]bool, len(files))
		for _, f := range files {
			keep[f.Name] = true
		}
		for _, name := range old.FileNames {
			if !keep[name] {
				if _, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
					TableName: aws.String(s.Table),
					Key:       compositeKey(connectorPK(c.Slug), connectorFileSK(name)),
				}); err != nil {
					return fmt.Errorf("store: prune connector file: %w", err)
				}
			}
		}
	}

	meta := connectorItem{
		PK:        connectorPK(c.Slug),
		SK:        metaSK(),
		GSI2PK:    allConnectorsGSI2PK(),
		GSI2SK:    connectorPK(c.Slug),
		Connector: *c,
	}
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      mustAttrs(attributevalue.MarshalMap(meta)),
	}); err != nil {
		return fmt.Errorf("store: put connector: %w", err)
	}
	for _, f := range files {
		f.Slug = c.Slug
		item := connectorFileItem{
			PK:            connectorPK(c.Slug),
			SK:            connectorFileSK(f.Name),
			ConnectorFile: f,
		}
		if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
			TableName: aws.String(s.Table),
			Item:      mustAttrs(attributevalue.MarshalMap(item)),
		}); err != nil {
			return fmt.Errorf("store: put connector file %s: %w", f.Name, err)
		}
	}
	return nil
}

// GetConnector fetches one connector's metadata.
func (s *ConnectorStore) GetConnector(ctx context.Context, slug string) (*model.Connector, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(connectorPK(slug), metaSK()),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get connector: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var item connectorItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal connector: %w", err)
	}
	return &item.Connector, nil
}

// ListConnectors returns every connector's metadata.
func (s *ConnectorStore) ListConnectors(ctx context.Context) ([]*model.Connector, error) {
	keyCond := expression.Key("GSI2PK").Equal(expression.Value(allConnectorsGSI2PK()))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI2"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list connectors: %w", err)
	}
	out := make([]*model.Connector, 0, len(items))
	for _, raw := range items {
		var item connectorItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal connector: %w", err)
		}
		out = append(out, &item.Connector)
	}
	return out, nil
}

// GetConnectorFiles returns the full docs bundle for one connector.
func (s *ConnectorStore) GetConnectorFiles(ctx context.Context, slug string) ([]model.ConnectorFile, error) {
	keyCond := expression.Key("PK").Equal(expression.Value(connectorPK(slug))).
		And(expression.Key("SK").BeginsWith("FILE#"))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: connector files: %w", err)
	}
	out := make([]model.ConnectorFile, 0, len(items))
	for _, raw := range items {
		var item connectorFileItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal connector file: %w", err)
		}
		out = append(out, item.ConnectorFile)
	}
	return out, nil
}

// DeleteConnector removes the metadata and all files (installs are left to
// expire naturally; they dangle harmlessly and list joins skip them).
func (s *ConnectorStore) DeleteConnector(ctx context.Context, slug string) error {
	c, err := s.GetConnector(ctx, slug)
	if err != nil {
		return err
	}
	for _, name := range c.FileNames {
		if _, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
			TableName: aws.String(s.Table),
			Key:       compositeKey(connectorPK(slug), connectorFileSK(name)),
		}); err != nil {
			return fmt.Errorf("store: delete connector file: %w", err)
		}
	}
	if _, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(connectorPK(slug), metaSK()),
	}); err != nil {
		return fmt.Errorf("store: delete connector: %w", err)
	}
	return nil
}

// PutInstall stores one user's connection (upsert).
func (s *ConnectorStore) PutInstall(ctx context.Context, in *model.ConnectorInstall) error {
	if in.UserID == "" || in.ConnectorSlug == "" {
		return errors.New("store: install needs user + connector")
	}
	item := connectorInstallItem{
		PK:               userPK(in.UserID),
		SK:               connInstallSK(in.ConnectorSlug),
		ConnectorInstall: *in,
	}
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      mustAttrs(attributevalue.MarshalMap(item)),
	}); err != nil {
		return fmt.Errorf("store: put install: %w", err)
	}
	return nil
}

// GetInstall fetches one user's install of one connector.
func (s *ConnectorStore) GetInstall(ctx context.Context, userID, slug string) (*model.ConnectorInstall, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(userPK(userID), connInstallSK(slug)),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get install: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var item connectorInstallItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal install: %w", err)
	}
	return &item.ConnectorInstall, nil
}

// ListInstalls returns every connector install for one user.
func (s *ConnectorStore) ListInstalls(ctx context.Context, userID string) ([]*model.ConnectorInstall, error) {
	keyCond := expression.Key("PK").Equal(expression.Value(userPK(userID))).
		And(expression.Key("SK").BeginsWith("CONNINST#"))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list installs: %w", err)
	}
	out := make([]*model.ConnectorInstall, 0, len(items))
	for _, raw := range items {
		var item connectorInstallItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal install: %w", err)
		}
		// Defensive: only rows that really are installs.
		if strings.HasPrefix(item.SK, "CONNINST#") {
			out = append(out, &item.ConnectorInstall)
		}
	}
	return out, nil
}

// DeleteInstall disconnects a user from a connector.
func (s *ConnectorStore) DeleteInstall(ctx context.Context, userID, slug string) error {
	if _, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(userPK(userID), connInstallSK(slug)),
	}); err != nil {
		return fmt.Errorf("store: delete install: %w", err)
	}
	return nil
}
