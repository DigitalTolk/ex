package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func useConnectorFixture(policy string) (*ConnectorHandler, *hconnCovRuns) {
	st := hconnCovNewStore()
	st.connectors["s1"] = hconnCovPasteConnector("s1")
	st.installs[hconnCovKey("hconncov-inv", "s1")] = &model.ConnectorInstall{UserID: "hconncov-inv", ConnectorSlug: "s1", AgentUse: policy}
	runs := &hconnCovRuns{run: &model.Run{ID: "hconncov-run", InvokerID: "hconncov-inv"}}
	return hconnCovHandler(st, runs), runs
}

func useConnector(h *ConnectorHandler, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.UseConnector(rec, hconnCovReq(http.MethodPost, "/api/v1/agent/run/use-connector", body, hconnCovRunClaims(), ""))
	return rec
}

// A run acting on someone else's words (a watcher woken by another member)
// never attaches its invoker's credential on its own — not even an "always"
// connector: the invoker gets the server's approval card instead.
func TestUseConnector_UntrustedRunAsksEvenForAlwaysConnectors(t *testing.T) {
	h, runs := useConnectorFixture(model.ConnectorAgentUseAlways)
	runs.run.UntrustedTrigger = true
	rec := useConnector(h, `{"connector":"s1","reason":"look it up"}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ask"`) || len(runs.attached) != 0 {
		t.Fatalf("untrusted always-connector must ask: %d %s attached=%v", rec.Code, rec.Body.String(), runs.attached)
	}
	if len(runs.raised) != 1 || runs.raised[0] != model.ApprovalPurposeConnector("s1") {
		t.Fatalf("raised=%v", runs.raised)
	}
}

// An approval the agent raised itself (no purpose — an older runner that got
// no server gate) used to unlock the connector when its prose named it. Now
// the server answers with its own card instead of attaching.
func TestUseConnector_AgentRaisedApprovalReAsks(t *testing.T) {
	h, runs := useConnectorFixture(model.ConnectorAgentUseAsk)
	runs.legacy = &model.Approval{ID: "agent-card", State: model.ApprovalApproved, Summary: "use s1 please"}
	rec := useConnector(h, `{"connector":"s1","approvalID":"agent-card"}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ask"`) || len(runs.attached) != 0 || len(runs.raised) != 1 {
		t.Fatalf("an agent-raised approval must re-ask: %d %s attached=%v raised=%v", rec.Code, rec.Body.String(), runs.attached, runs.raised)
	}
}

// A retried call after the connector is attached (its approval already
// spent) reports it attached instead of asking again or refusing.
func TestUseConnector_AlreadyAttachedIsIdempotent(t *testing.T) {
	h, runs := useConnectorFixture(model.ConnectorAgentUseAsk)
	runs.run.ConnectorSlugs = []string{"other", "s1"}
	rec := useConnector(h, `{"connector":"s1","approvalID":"spent"}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"attached"`) || len(runs.raised) != 0 {
		t.Fatalf("already attached: %d %s raised=%v", rec.Code, rec.Body.String(), runs.raised)
	}
}
