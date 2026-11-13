package agents

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/apperr"
)

// Connect to Claude: instead of pairing a computer of their own, a person
// asks ex to set up a runner for them on the shared agent workbench. ex
// issues a runner token for them and hands it to the workbench's onboarding
// endpoint, which signs them in to Claude there and starts an ex-runner with
// that token. The token goes server to server and never reaches the browser.

// WorkbenchLabel names the workbench install on the Runners page.
const WorkbenchLabel = "Agent workbench"

// workbenchTimeout bounds the onboarding call, inside the HTTP server's
// 60-second write timeout so the person still gets an answer.
const workbenchTimeout = 45 * time.Second

var (
	// ErrWorkbenchOff means this deployment has no agent workbench.
	ErrWorkbenchOff = errors.New("the agent workbench isn't set up here")
	// ErrWorkbenchConnected means the person already has a workbench runner.
	ErrWorkbenchConnected = errors.New("you're already connected to Claude")
	// ErrWorkbenchFailed means the workbench didn't take the onboarding.
	ErrWorkbenchFailed = errors.New("the agent workbench couldn't set you up")
)

// WorkbenchOnboarder hands a person's runner token to the workbench.
type WorkbenchOnboarder interface {
	Onboard(ctx context.Context, username, runnerToken string) error
}

// SetWorkbench turns Connect to Claude on. Optional: nil leaves it off.
func (s *RunnerTokenService) SetWorkbench(w WorkbenchOnboarder) { s.workbench = w }

// UseWorkbenchURL turns Connect to Claude on for the workbench at baseURL,
// whose runners connect back to server. An empty baseURL leaves it off.
func (s *RunnerTokenService) UseWorkbenchURL(baseURL, server string) {
	if baseURL != "" {
		s.workbench = NewWorkbenchClient(baseURL, server)
	}
}

// WorkbenchEnabled reports whether Connect to Claude is available.
func (s *RunnerTokenService) WorkbenchEnabled() bool { return s.workbench != nil }

// ConnectWorkbench issues a runner token for the user and onboards them on
// the workbench. While the workbench is being tested a failed onboarding
// keeps the token, so it can be looked into; disconnecting "Agent
// workbench" from the Runners list allows another try.
func (s *RunnerTokenService) ConnectWorkbench(ctx context.Context, userID string) error {
	if s.workbench == nil {
		return ErrWorkbenchOff
	}
	user, err := s.users.GetByID(ctx, userID)
	if err != nil {
		return fmt.Errorf("workbench: load user: %w", err)
	}
	if !usableRunnerOwner(user) {
		return apperr.Forbidden("this account can't connect a runner")
	}
	existing, err := s.List(ctx, userID)
	if err != nil {
		return err
	}
	for _, t := range existing {
		if t.Workbench {
			return ErrWorkbenchConnected
		}
	}
	issued, err := s.issue(ctx, user, WorkbenchLabel, true)
	if err != nil {
		return err
	}
	if err := s.workbench.Onboard(ctx, user.Email, issued.Token); err != nil {
		slog.WarnContext(ctx, "workbench: onboarding failed", "userID", userID, "tokenID", issued.ID, "error", err)
		return ErrWorkbenchFailed
	}
	return nil
}

// WorkbenchClient calls the workbench's onboarding endpoint.
type WorkbenchClient struct {
	url    string // base URL, no trailing slash
	server string // this ex's address, for the runner to connect back to
	http   *http.Client
}

// NewWorkbenchClient returns a client for the workbench at baseURL that
// tells it to connect runners to server.
func NewWorkbenchClient(baseURL, server string) *WorkbenchClient {
	return &WorkbenchClient{
		url:    strings.TrimRight(baseURL, "/"),
		server: server,
		http:   &http.Client{Timeout: workbenchTimeout},
	}
}

// Onboard posts {username, runner_token, server} to <url>/onboard.
func (c *WorkbenchClient) Onboard(ctx context.Context, username, runnerToken string) error {
	// Three strings: marshalling can't fail.
	body, _ := json.Marshal(map[string]string{
		"username":     username,
		"runner_token": runnerToken,
		"server":       c.server,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url+"/onboard", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode/100 != 2 {
		detail, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("workbench answered %d: %s", res.StatusCode, strings.TrimSpace(string(detail)))
	}
	return nil
}
