package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

// SharePoint links posted in a channel or conversation, and the files they
// were shared as, live in the parent's own partition (PK=parentPK, like the
// pin and file indexes): SK=SPLINK#<hash of the URL> per link and
// SK=SPITEM#<item id> per file. A parent holds few of them, so every list is
// one Query. Work a user's Microsoft token left undone is marked on the
// user's own partition: SK=SPUNFINISHED#<parent id>.

const (
	spLinkSKPrefix       = "SPLINK#"
	spItemSKPrefix       = "SPITEM#"
	spUnfinishedSKPrefix = "SPUNFINISHED#"
)

func spLinkSK(url string) string {
	sum := sha256.Sum256([]byte(url))
	return spLinkSKPrefix + hex.EncodeToString(sum[:])
}

func spItemSK(id string) string { return spItemSKPrefix + id }

func spUnfinishedSK(parentID string) string { return spUnfinishedSKPrefix + parentID }

// SharePointLink is one SharePoint link posted in a parent: the messages that
// carry it, who posted it (whose Microsoft account shares it), and how far
// sharing it got. ItemID names the file once the link has been resolved.
type SharePointLink struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`

	ParentID   string    `dynamodbav:"parent_id"`
	URL        string    `dynamodbav:"url"`
	MessageIDs []string  `dynamodbav:"message_ids"`
	PosterID   string    `dynamodbav:"poster_id"`
	ItemID     string    `dynamodbav:"item_id,omitempty"`
	Status     string    `dynamodbav:"status"`
	Problem    string    `dynamodbav:"problem,omitempty"`
	CreatedAt  time.Time `dynamodbav:"created_at"`
	UpdatedAt  time.Time `dynamodbav:"updated_at"`
}

// SharePointItem is a SharePoint or OneDrive file shared with a parent's
// members. Grants maps each member given access to the permission that gave
// it: the app takes back only permissions it created, so a member who had
// access already maps to "". NotShared lists the members it could not share
// with. GrantorID is the poster whose Microsoft account shares it. Retired
// marks a file whose links have all gone but whose access couldn't all be
// taken back: it is no longer listed or shared, and stays until the
// grantor's next sign-in takes the rest back.
type SharePointItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`

	ParentID string `dynamodbav:"parent_id"`
	ID       string `dynamodbav:"id"`
	DriveID  string `dynamodbav:"drive_id"`
	ItemID   string `dynamodbav:"item_id"`
	Name     string `dynamodbav:"name"`
	Size     int64  `dynamodbav:"size"`
	Folder   bool   `dynamodbav:"folder,omitempty"`
	MimeType string `dynamodbav:"mime_type,omitempty"`
	WebURL   string `dynamodbav:"web_url"`
	EditURL  string `dynamodbav:"edit_url,omitempty"`
	// DownloadURL is empty for a folder, or an item without SharePoint ids.
	DownloadURL string            `dynamodbav:"download_url,omitempty"`
	GrantorID   string            `dynamodbav:"grantor_id"`
	Grants      map[string]string `dynamodbav:"grants"`
	NotShared   []string          `dynamodbav:"not_shared,omitempty"`
	Retired     bool              `dynamodbav:"retired,omitempty"`
	// MessageID, AuthorID and SharedAt describe the latest message that
	// shared the file: the Files panel lists it there.
	MessageID string    `dynamodbav:"message_id"`
	AuthorID  string    `dynamodbav:"author_id"`
	SharedAt  time.Time `dynamodbav:"shared_at"`
	UpdatedAt time.Time `dynamodbav:"updated_at"`
}

// SharePointUnfinished marks a parent where a user's Microsoft token left
// work undone: access it couldn't take back, members it couldn't share with.
// The user's next sign-in finishes it.
type SharePointUnfinished struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`

	UserID     string    `dynamodbav:"user_id"`
	ParentID   string    `dynamodbav:"parent_id"`
	ParentType string    `dynamodbav:"parent_type"`
	UpdatedAt  time.Time `dynamodbav:"updated_at"`
}

// SharePointItemID is the stable id of a drive item: the same file always
// gets the same id, however it was linked.
func SharePointItemID(driveID, itemID string) string {
	sum := sha256.Sum256([]byte(driveID + "/" + itemID))
	return hex.EncodeToString(sum[:16])
}

// SharePointStore persists SharePoint links and shared files.
type SharePointStore struct {
	*DB
}

func NewSharePointStore(db *DB) *SharePointStore { return &SharePointStore{DB: db} }

func (s *SharePointStore) GetSharePointLink(ctx context.Context, parentID, url string) (*SharePointLink, error) {
	return getItem[SharePointLink](ctx, s.DB, parentPK(parentID), spLinkSK(url), "sharepoint link")
}

func (s *SharePointStore) ListSharePointLinks(ctx context.Context, parentID string) ([]SharePointLink, error) {
	return queryAllOf[SharePointLink](ctx, s.DB, s.prefixQuery(parentPK(parentID), spLinkSKPrefix), "sharepoint links")
}

func (s *SharePointStore) PutSharePointLink(ctx context.Context, l *SharePointLink) error {
	l.PK, l.SK = parentPK(l.ParentID), spLinkSK(l.URL)
	return putRow(ctx, s.DB, mustAttrs(attributevalue.MarshalMap(l)), "sharepoint link")
}

func (s *SharePointStore) DeleteSharePointLink(ctx context.Context, parentID, url string) error {
	return deleteRow(ctx, s.DB, parentPK(parentID), spLinkSK(url), "sharepoint link")
}

func (s *SharePointStore) GetSharePointItem(ctx context.Context, parentID, id string) (*SharePointItem, error) {
	return getItem[SharePointItem](ctx, s.DB, parentPK(parentID), spItemSK(id), "sharepoint item")
}

func (s *SharePointStore) ListSharePointItems(ctx context.Context, parentID string) ([]SharePointItem, error) {
	return queryAllOf[SharePointItem](ctx, s.DB, s.prefixQuery(parentPK(parentID), spItemSKPrefix), "sharepoint items")
}

func (s *SharePointStore) PutSharePointItem(ctx context.Context, it *SharePointItem) error {
	it.PK, it.SK = parentPK(it.ParentID), spItemSK(it.ID)
	return putRow(ctx, s.DB, mustAttrs(attributevalue.MarshalMap(it)), "sharepoint item")
}

func (s *SharePointStore) DeleteSharePointItem(ctx context.Context, parentID, id string) error {
	return deleteRow(ctx, s.DB, parentPK(parentID), spItemSK(id), "sharepoint item")
}

func (s *SharePointStore) PutSharePointUnfinished(ctx context.Context, u *SharePointUnfinished) error {
	u.PK, u.SK, u.UpdatedAt = userPK(u.UserID), spUnfinishedSK(u.ParentID), time.Now()
	return putRow(ctx, s.DB, mustAttrs(attributevalue.MarshalMap(u)), "sharepoint unfinished")
}

func (s *SharePointStore) ListSharePointUnfinished(ctx context.Context, userID string) ([]SharePointUnfinished, error) {
	return queryAllOf[SharePointUnfinished](ctx, s.DB, s.prefixQuery(userPK(userID), spUnfinishedSKPrefix), "sharepoint unfinished")
}

func (s *SharePointStore) DeleteSharePointUnfinished(ctx context.Context, userID, parentID string) error {
	return deleteRow(ctx, s.DB, userPK(userID), spUnfinishedSK(parentID), "sharepoint unfinished")
}

func (s *SharePointStore) prefixQuery(pk, prefix string) *dynamodb.QueryInput {
	keyCond := expression.Key("PK").Equal(expression.Value(pk)).
		And(expression.Key("SK").BeginsWith(prefix))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	return &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	}
}
