package service

import (
	"context"
	"strings"
	"testing"
	"time"
)

// msgCovPurger records PurgeThreadLogs calls and signals arrival.
type msgCovPurger struct {
	got chan [2]string
}

func (p *msgCovPurger) PurgeThreadLogs(_ context.Context, parentID, msgID string) {
	p.got <- [2]string{parentID, msgID}
}

func TestMsgCov_SendAsAgentAttribution(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	seedMembership(memberships, "ch1", "u-inv")
	ctx := context.Background()

	// Run-linked agent post: attribution records whose invocation it serves
	// and which run produced it.
	msg, err := svc.SendAsAgentRun(ctx, "a-gg", "u-inv", "ch1", ParentChannel, "here is the answer", "", "run-9")
	if err != nil {
		t.Fatalf("SendAsAgentRun: %v", err)
	}
	if msg.AgentInvokerID != "u-inv" || msg.AgentRunID != "run-9" {
		t.Fatalf("attribution missing: %+v", msg)
	}

	// The plain wrapper: same attribution, no run link.
	msg2, err := svc.SendAsAgent(ctx, "a-gg", "u-inv", "ch1", ParentChannel, "follow-up", "")
	if err != nil {
		t.Fatalf("SendAsAgent: %v", err)
	}
	if msg2.AgentInvokerID != "u-inv" || msg2.AgentRunID != "" {
		t.Fatalf("wrapper attribution: %+v", msg2)
	}
}

func TestMsgCov_ToggleReactionAsAgent(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	seedMembership(memberships, "ch1", "u-inv")
	ctx := context.Background()

	root, err := svc.Send(ctx, "u-inv", "ch1", ParentChannel, "react to me", "")
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	got, err := svc.ToggleReactionAsAgent(ctx, "a-gg", "u-inv", "ch1", ParentChannel, root.ID, "🚀")
	if err != nil {
		t.Fatalf("ToggleReactionAsAgent: %v", err)
	}
	found := false
	for _, u := range got.Reactions["🚀"] {
		if u == "a-gg" {
			found = true
		}
	}
	if !found {
		t.Fatalf("agent reaction not recorded: %+v", got.Reactions)
	}

	if _, err := svc.ToggleReactionAsAgent(ctx, "a-gg", "u-inv", "ch1", ParentChannel, root.ID, ""); err == nil || !strings.Contains(err.Error(), "emoji") {
		t.Fatalf("empty emoji: want emoji error, got %v", err)
	}
}

func TestMsgCov_DeletePurgesRunLogs(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	seedMembership(memberships, "ch1", "u-inv")
	purger := &msgCovPurger{got: make(chan [2]string, 1)}
	svc.SetRunLogPurger(purger)

	// A cancellable request context: the purge must survive its cancellation
	// (it runs detached in the background).
	ctx, cancel := context.WithCancel(context.Background())

	root, err := svc.Send(ctx, "u-inv", "ch1", ParentChannel, "to be deleted", "")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if err := svc.Delete(ctx, "u-inv", "ch1", ParentChannel, root.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	cancel()

	select {
	case got := <-purger.got:
		if got[0] != "ch1" || got[1] != root.ID {
			t.Fatalf("purge args: got %v", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("run-log purge never fired")
	}
}

func TestMsgCov_ToggleReactionRejectsMachineEmoji(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	seedMembership(memberships, "ch1", "u-inv")
	var machine string
	for e := range machineStateEmojis {
		machine = e
		break
	}
	if _, err := svc.ToggleReaction(context.Background(), "u-inv", "ch1", ParentChannel, "m-any", machine); err != ErrReservedEmoji {
		t.Fatalf("machine emoji: want ErrReservedEmoji, got %v", err)
	}
}
