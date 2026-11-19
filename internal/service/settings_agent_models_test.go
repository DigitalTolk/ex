package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

var twoModels = []model.AgentModelOption{
	{Harness: model.HarnessClaude, ID: "claude-sonnet-5-5", Label: "Sonnet"},
	{Harness: model.HarnessBedrock, ID: "eu.anthropic.claude-opus-5"},
}

func TestSettingsService_AgentModelsDefaultUntilSet(t *testing.T) {
	svc := NewSettingsService(&fakeSettingsStore{})
	got := svc.Effective(context.Background()).AgentModels
	if len(got) != len(model.DefaultAgentModels) || got[0] != model.DefaultAgentModels[0] {
		t.Fatalf("AgentModels = %v, want the built-in list", got)
	}
	if !svc.OffersAgentModel(context.Background(), model.HarnessClaude, "claude-opus-5-5") {
		t.Fatal("a built-in model must be offered")
	}
	if svc.OffersAgentModel(context.Background(), model.HarnessClaude, "claude-made-up") {
		t.Fatal("a model not on the list must not be offered")
	}
}

func TestSettingsService_SetAgentModels(t *testing.T) {
	ctx := context.Background()
	st := &fakeSettingsStore{stored: &model.WorkspaceSettings{MaxUploadBytes: 1234, RunnersInApp: true}}
	svc := NewSettingsService(st)
	pub := newMockPublisher()
	svc.SetPublisher(pub)

	out, err := svc.SetAgentModels(ctx, append([]model.AgentModelOption{{Harness: " claude ", ID: " claude-opus-5 "}}, twoModels...))
	if err != nil {
		t.Fatalf("SetAgentModels: %v", err)
	}
	// Trimmed and stored, the other settings untouched.
	if len(st.stored.AgentModels) != 3 || st.stored.AgentModels[0].ID != "claude-opus-5" || st.stored.MaxUploadBytes != 1234 || !st.stored.RunnersInApp {
		t.Fatalf("stored = %+v", st.stored)
	}
	if len(out.AgentModels) != 3 || out.MaxUploadBytes != 1234 {
		t.Fatalf("out = %+v", out)
	}
	// Every client hears it and reloads its dropdowns.
	if len(pub.published) != 1 || pub.published[0].channel != pubsub.GlobalChannelEvents() ||
		pub.published[0].event.Type != events.EventSettingsUpdated {
		t.Fatalf("published = %+v", pub.published)
	}
	// The cache answers the next read: the model check sees the new list.
	if !svc.OffersAgentModel(ctx, model.HarnessClaude, "claude-sonnet-5-5") || svc.OffersAgentModel(ctx, model.HarnessClaude, "claude-opus-5-5") {
		t.Fatal("the saved list must be what is offered")
	}
}

func TestSettingsService_SetAgentModelsFirstSave(t *testing.T) {
	st := &fakeSettingsStore{}
	svc := NewSettingsService(st)
	if _, err := svc.SetAgentModels(context.Background(), twoModels); err != nil {
		t.Fatalf("SetAgentModels with nothing saved yet: %v", err)
	}
	if len(st.stored.AgentModels) != 2 {
		t.Fatalf("stored = %+v", st.stored)
	}
	// A store that answers nil for "nothing saved" is the same thing.
	if _, err := NewSettingsService(&nilOKSettingsStore{}).SetAgentModels(context.Background(), twoModels); err != nil {
		t.Fatalf("SetAgentModels over a nil record: %v", err)
	}
}

func TestSettingsService_SetAgentModelsRefusals(t *testing.T) {
	ctx := context.Background()
	st := &fakeSettingsStore{}
	svc := NewSettingsService(st)
	pub := newMockPublisher()
	svc.SetPublisher(pub)

	_, err := svc.SetAgentModels(ctx, []model.AgentModelOption{{Harness: model.HarnessBedrock, ID: "us.anthropic.claude-opus-5"}})
	if !errors.Is(err, apperr.ErrValidation) {
		t.Fatalf("a US profile: err = %v, want a validation error", err)
	}

	st.getErr = errors.New("read failed")
	if _, err := svc.SetAgentModels(ctx, twoModels); err == nil || errors.Is(err, apperr.ErrValidation) {
		t.Fatalf("a failed read: err = %v", err)
	}
	st.getErr = nil
	st.putErr = errors.New("write failed")
	if _, err := svc.SetAgentModels(ctx, twoModels); err == nil {
		t.Fatal("want the store error")
	}
	if len(pub.published) != 0 || st.stored != nil {
		t.Fatalf("a refused or failed save stored or published: %+v %+v", st.stored, pub.published)
	}
}

// The other settings have their own save, which sends the whole object: a
// client that leaves the list out, or sends it, must not change it.
func TestSettingsService_UpdateKeepsTheModelList(t *testing.T) {
	ctx := context.Background()
	st := &fakeSettingsStore{stored: &model.WorkspaceSettings{AgentModels: twoModels}}
	svc := NewSettingsService(st)

	if _, err := svc.Update(ctx, &model.WorkspaceSettings{MaxUploadBytes: 5}); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if len(st.stored.AgentModels) != 2 || st.stored.MaxUploadBytes != 5 {
		t.Fatalf("a save without the list changed it: %+v", st.stored)
	}
	if _, err := svc.Update(ctx, &model.WorkspaceSettings{AgentModels: []model.AgentModelOption{{Harness: "claude", ID: "claude-x"}}}); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if len(st.stored.AgentModels) != 2 {
		t.Fatalf("a save carrying a list changed it: %+v", st.stored)
	}

	st.getErr = errors.New("read failed")
	if _, err := svc.Update(ctx, &model.WorkspaceSettings{}); err == nil {
		t.Fatal("Update must fail when it cannot read the stored list")
	}
}
