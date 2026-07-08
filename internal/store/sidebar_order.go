package store

import (
	"context"
	"fmt"
	"slices"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// Sidebar item types accepted by the order writer. They pick the user-side
// row family (CHAN#/CONV#) the update targets.
const (
	SidebarItemChannel      = "channel"
	SidebarItemConversation = "conversation"
)

// SidebarRowUpdate is one server-computed ordering write for a user-side
// sidebar row. Position is always set; CategoryID/Favorite ride along only on
// the moved row (nil = attribute untouched — the re-spaced neighbors keep
// their section assignment).
type SidebarRowUpdate struct {
	ItemType   string  `json:"itemType"` // SidebarItemChannel | SidebarItemConversation
	ItemID     string  `json:"itemID"`
	Position   int     `json:"position"`
	CategoryID *string `json:"categoryID,omitempty"`
	Favorite   *bool   `json:"favorite,omitempty"`
}

// dynamoTransactLimit is DynamoDB's TransactWriteItems item cap.
const dynamoTransactLimit = 100

// SidebarOrderStoreImpl writes server-computed sidebar ordering onto the
// user-side rows. The single-table design puts a user's channel and
// conversation rows in one partition, so a mixed reorder commits as one
// TransactWriteItems call in the common case.
type SidebarOrderStoreImpl struct {
	*DB
}

// NewSidebarOrderStore returns a new SidebarOrderStoreImpl.
func NewSidebarOrderStore(db *DB) *SidebarOrderStoreImpl {
	return &SidebarOrderStoreImpl{DB: db}
}

// ApplyOrder applies the given row updates for one user. Batches of up to the
// DynamoDB transact limit commit atomically; a larger rebalance is applied in
// order-preserving chunks (each chunk atomic), which is safe to apply
// progressively — relative order stays correct even if a later chunk fails.
// A missing row (the user lost membership mid-drag) fails the whole chunk
// with ErrNotFound rather than creating orphan rows.
func (s *SidebarOrderStoreImpl) ApplyOrder(ctx context.Context, userID string, updates []SidebarRowUpdate) error {
	for chunk := range slices.Chunk(updates, dynamoTransactLimit) {
		items := make([]types.TransactWriteItem, 0, len(chunk))
		for _, u := range chunk {
			sk := chanSK(u.ItemID)
			if u.ItemType == SidebarItemConversation {
				sk = convSK(u.ItemID)
			}
			upd := expression.Set(expression.Name("sidebarPosition"), expression.Value(u.Position))
			if u.CategoryID != nil {
				upd = upd.Set(expression.Name("categoryID"), expression.Value(*u.CategoryID))
			}
			if u.Favorite != nil {
				upd = upd.Set(expression.Name("favorite"), expression.Value(*u.Favorite))
			}
			expr := mustExpr(expression.NewBuilder().WithUpdate(upd).Build())
			items = append(items, types.TransactWriteItem{
				Update: &types.Update{
					TableName:                 aws.String(s.Table),
					Key:                       compositeKey(userPK(userID), sk),
					UpdateExpression:          expr.Update(),
					ExpressionAttributeNames:  expr.Names(),
					ExpressionAttributeValues: expr.Values(),
					ConditionExpression:       aws.String("attribute_exists(PK)"),
				},
			})
		}
		if _, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: items}); err != nil {
			if isConditionCheckFailed(err) || isTransactionCancelledWithCondition(err) {
				return ErrNotFound
			}
			return fmt.Errorf("store: apply sidebar order: %w", err)
		}
	}
	return nil
}
