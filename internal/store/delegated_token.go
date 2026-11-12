package store

import (
	"context"
	"time"

	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
)

// A user's Microsoft (delegated Graph) token lives on their own partition
// (PK=USER#<id>, SK=MSTOKEN), already encrypted: the store only ever holds the
// sealed bytes.

const delegatedTokenSK = "MSTOKEN"

type delegatedTokenRow struct {
	PK        string    `dynamodbav:"PK"`
	SK        string    `dynamodbav:"SK"`
	Sealed    []byte    `dynamodbav:"sealed"`
	UpdatedAt time.Time `dynamodbav:"updated_at"`
}

// DelegatedTokenStore persists each user's sealed Microsoft token.
type DelegatedTokenStore struct {
	*DB
}

func NewDelegatedTokenStore(db *DB) *DelegatedTokenStore { return &DelegatedTokenStore{DB: db} }

// GetDelegatedToken returns the user's sealed token; ErrNotFound when none is
// stored.
func (s *DelegatedTokenStore) GetDelegatedToken(ctx context.Context, userID string) ([]byte, error) {
	row, err := getItem[delegatedTokenRow](ctx, s.DB, userPK(userID), delegatedTokenSK, "delegated token")
	if err != nil {
		return nil, err
	}
	return row.Sealed, nil
}

// PutDelegatedToken stores (or replaces) the user's sealed token.
func (s *DelegatedTokenStore) PutDelegatedToken(ctx context.Context, userID string, sealed []byte) error {
	row := delegatedTokenRow{PK: userPK(userID), SK: delegatedTokenSK, Sealed: sealed, UpdatedAt: time.Now()}
	return putRow(ctx, s.DB, mustAttrs(attributevalue.MarshalMap(row)), "delegated token")
}

// DeleteDelegatedToken forgets the user's token.
func (s *DelegatedTokenStore) DeleteDelegatedToken(ctx context.Context, userID string) error {
	return deleteRow(ctx, s.DB, userPK(userID), delegatedTokenSK, "delegated token")
}
