//go:build integration

package store

import (
	"context"
	"errors"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// A mute is written on the muting user's own row and read back from it: the
// other participant's row, and a chat nobody muted, read as not muted.
func TestConversationStore_SetMuted(t *testing.T) {
	db := setupDynamoDB(t)
	cs := NewConversationStore(db)
	ctx := context.Background()
	conv, members := makeConv("conv-mute", "u-cm-a", "u-cm-b")
	if err := cs.CreateConversation(ctx, conv, members); err != nil {
		t.Fatalf("Create: %v", err)
	}
	muted := func(userID string) bool {
		t.Helper()
		on, err := cs.ConversationMuted(ctx, "conv-mute", userID)
		if err != nil {
			t.Fatalf("ConversationMuted(%s): %v", userID, err)
		}
		return on
	}
	listed := func(userID string) bool {
		t.Helper()
		rows, err := cs.ListUserConversations(ctx, userID)
		if err != nil || len(rows) != 1 {
			t.Fatalf("ListUserConversations(%s) = %+v, %v, want one row", userID, rows, err)
		}
		return rows[0].Muted
	}

	if muted("u-cm-a") || listed("u-cm-a") {
		t.Fatal("a new chat reads as muted")
	}
	steps := []struct {
		name string
		set  bool
	}{
		{name: "muted", set: true},
		{name: "muted again", set: true},
		{name: "unmuted", set: false},
		{name: "unmuted again", set: false},
	}
	for _, step := range steps {
		if err := cs.SetMuted(ctx, "conv-mute", "u-cm-a", step.set); err != nil {
			t.Fatalf("%s: SetMuted: %v", step.name, err)
		}
		if muted("u-cm-a") != step.set || listed("u-cm-a") != step.set {
			t.Errorf("%s: the caller's row reads muted=%v, listed=%v, want %v", step.name, muted("u-cm-a"), listed("u-cm-a"), step.set)
		}
		if muted("u-cm-b") || listed("u-cm-b") {
			t.Errorf("%s: the other participant's row was muted too", step.name)
		}
	}
}

func TestConversationStore_SetMutedErrors(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	conv, members := makeConv("conv-mute-e", "u-cme-a", "u-cme-b")
	if err := NewConversationStore(db).CreateConversation(ctx, conv, members); err != nil {
		t.Fatalf("Create: %v", err)
	}

	t.Run("no such row", func(t *testing.T) {
		cs := NewConversationStore(db)
		if err := cs.SetMuted(ctx, "conv-ghost", "u-cme-a", true); !errors.Is(err, ErrNotFound) {
			t.Errorf("SetMuted = %v, want ErrNotFound", err)
		}
		// Nothing was created by the refused write.
		if on, err := cs.ConversationMuted(ctx, "conv-ghost", "u-cme-a"); err != nil || on {
			t.Errorf("ConversationMuted on a missing row = %v, %v, want not muted", on, err)
		}
	})
	t.Run("the write fails", func(t *testing.T) {
		cs := NewConversationStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
		if err := cs.SetMuted(ctx, "conv-mute-e", "u-cme-a", true); !errors.Is(err, errInjected) {
			t.Errorf("SetMuted = %v, want errInjected", err)
		}
	})
	t.Run("the read fails", func(t *testing.T) {
		cs := NewConversationStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
		if on, err := cs.ConversationMuted(ctx, "conv-mute-e", "u-cme-a"); !errors.Is(err, errInjected) || on {
			t.Errorf("ConversationMuted = %v, %v, want errInjected", on, err)
		}
	})
	t.Run("a row this code did not write", func(t *testing.T) {
		cs := NewConversationStore(withFault(db, func(f *faultClient) {
			f.transformGetItem = func(out *dynamodb.GetItemOutput) *dynamodb.GetItemOutput {
				out.Item = map[string]types.AttributeValue{"muted": &types.AttributeValueMemberS{Value: "yes"}}
				return out
			}
		}))
		on, err := cs.ConversationMuted(ctx, "conv-mute-e", "u-cme-a")
		assertUnmarshalErr(t, err, "ConversationMuted")
		if on {
			t.Error("an unreadable flag read as muted")
		}
	})
}
