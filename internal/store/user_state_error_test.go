//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

func makeUserState(userID string, kind model.UserStateKind, targetID string) *model.UserStateItem {
	return &model.UserStateItem{
		UserID:    userID,
		Kind:      kind,
		TargetID:  targetID,
		UpdatedAt: time.Now().Truncate(time.Millisecond),
	}
}

// SDK-call error branches in the user-state store, exercised via faultClient.

func TestUserStateStore_Set_PutItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserStateStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	err := s.SetUserState(ctx, makeUserState("u-us", model.UserStateThreadNotification, "ch-1"))
	if !errors.Is(err, errInjected) {
		t.Fatalf("Set: want errInjected, got %v", err)
	}
}

func TestUserStateStore_Delete_DeleteItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserStateStore(withFault(db, func(f *faultClient) { f.failDeleteItem = true }))
	err := s.DeleteUserState(ctx, "u-us", model.UserStateThreadNotification, "ch-1")
	if !errors.Is(err, errInjected) {
		t.Fatalf("Delete: want errInjected, got %v", err)
	}
}

func TestUserStateStore_List_QueryError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserStateStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	_, err := s.ListUserState(ctx, "u-us", model.UserStateThreadNotification)
	if !errors.Is(err, errInjected) {
		t.Fatalf("List: want errInjected, got %v", err)
	}
}

// A row stored without its kind attribute still reports the kind it was
// listed or read under.
func TestUserStateStore_KindFromTheQuery(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserStateStore(db)
	row := userStateItem{PK: userPK("u-usk"), SK: userStateSK(string(model.UserStateHiddenSkill), "sk-1"), UserStateItem: model.UserStateItem{UserID: "u-usk", TargetID: "sk-1"}}
	if _, err := db.Client.PutItem(ctx, &dynamodb.PutItemInput{TableName: aws.String(db.Table), Item: mustAttrs(attributevalue.MarshalMap(row))}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	items, err := s.ListUserState(ctx, "u-usk", model.UserStateHiddenSkill)
	if err != nil || len(items) != 1 || items[0].Kind != model.UserStateHiddenSkill {
		t.Fatalf("List = %+v (err %v), want the row as a hidden skill", items, err)
	}
	got, err := s.GetUserState(ctx, "u-usk", model.UserStateHiddenSkill, "sk-1")
	if err != nil || got.Kind != model.UserStateHiddenSkill {
		t.Fatalf("Get = %+v (err %v), want the row as a hidden skill", got, err)
	}
}
