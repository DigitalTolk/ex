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
	"net/url"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/model"
)

// Connect to Claude: instead of pairing a computer of their own, a person
// asks ex to set up a runner for them on the shared agent workbench. ex
// issues a runner token for them and hands it to the workbench's onboarding
// endpoint, which queues a job that signs them in to Claude there and starts
// an ex-runner with that token. ex keeps the job's id to show its progress.
// The token goes server to server and never reaches the browser.

// WorkbenchLabel names the workbench install on the Runners page.
const WorkbenchLabel = "Agent workbench"

// workbenchTimeout bounds each workbench call, inside the HTTP server's
// 60-second write timeout so the person still gets an answer.
const workbenchTimeout = 45 * time.Second

var (
	// ErrWorkbenchOff means this deployment has no agent workbench.
	ErrWorkbenchOff = errors.New("the agent workbench isn't set up here")
	// ErrWorkbenchConnected means the person already has a workbench runner.
	ErrWorkbenchConnected = errors.New("you're already connected to Claude")
	// ErrWorkbenchFailed means the workbench didn't take the onboarding.
	ErrWorkbenchFailed = errors.New("the agent workbench couldn't set you up")
	// ErrWorkbenchNotConnected means the person has no workbench runner.
	ErrWorkbenchNotConnected = errors.New("you aren't connected to Claude")
	// ErrWorkbenchUnreachable means the workbench didn't answer a status check.
	ErrWorkbenchUnreachable = errors.New("couldn't reach the agent workbench")
)

// WorkbenchJob is one onboarding on the workbench. State is queued, running,
// done or failed; Status and Result are the workbench's own, passed through.
type WorkbenchJob struct {
	ID         string          `json:"id"`
	State      string          `json:"state"`
	Username   string          `json:"username,omitempty"`
	CreatedAt  string          `json:"created_at,omitempty"`
	StartedAt  string          `json:"started_at,omitempty"`
	FinishedAt string          `json:"finished_at,omitempty"`
	Status     json.RawMessage `json:"status,omitempty"`
	Result     json.RawMessage `json:"result,omitempty"`
}

// WorkbenchJobFailed is the state of a job that never started.
const WorkbenchJobFailed = "failed"

// Workbench is the agent workbench's onboarding API.
type Workbench interface {
	// Onboard queues setting up a runner for username with runnerToken
	// and returns the job's id.
	Onboard(ctx context.Context, username, runnerToken string) (string, error)
	// Job reports how an onboarding is going.
	Job(ctx context.Context, id string) (*WorkbenchJob, error)
}

// SetWorkbench turns Connect to Claude on. Optional: nil leaves it off.
func (s *RunnerTokenService) SetWorkbench(w Workbench) { s.workbench = w }

// UseWorkbenchURL turns Connect to Claude on for the workbench at baseURL,
// called with apiToken, whose runners connect back to server. An empty
// baseURL leaves it off.
func (s *RunnerTokenService) UseWorkbenchURL(baseURL, apiToken, server string) {
	if baseURL != "" {
		s.workbench = NewWorkbenchClient(baseURL, apiToken, server)
	}
}

// WorkbenchEnabled reports whether Connect to Claude is available.
func (s *RunnerTokenService) WorkbenchEnabled() bool { return s.workbench != nil }

// workbenchInstall is the user's workbench install, nil when they have none.
func (s *RunnerTokenService) workbenchInstall(ctx context.Context, userID string) (*model.RunnerToken, error) {
	toks, err := s.List(ctx, userID)
	if err != nil {
		return nil, err
	}
	for _, t := range toks {
		if t.Workbench {
			return t, nil
		}
	}
	return nil, nil
}

// ConnectWorkbench issues a runner token for the user and onboards them on
// the workbench. The install is stored either way: while the workbench is
// being tested a failed onboarding keeps its token to look into, and
// disconnecting "Agent workbench" from the Runners list allows another try.
func (s *RunnerTokenService) ConnectWorkbench(ctx context.Context, userID string) (*WorkbenchJob, error) {
	if s.workbench == nil {
		return nil, ErrWorkbenchOff
	}
	user, err := s.users.GetByID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("workbench: load user: %w", err)
	}
	if !usableRunnerOwner(user) {
		return nil, apperr.Forbidden("this account can't connect a runner")
	}
	existing, err := s.workbenchInstall(ctx, userID)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return nil, ErrWorkbenchConnected
	}
	rec := s.newRecord(user, WorkbenchLabel)
	rec.Workbench = true
	token, err := s.mint(user, rec)
	if err != nil {
		return nil, err
	}
	// The workbench only queues the job here; its runner starts well after
	// the record below is stored.
	jobID, onboardErr := s.workbench.Onboard(ctx, user.Email, token)
	rec.WorkbenchJob = jobID
	if err := s.save(ctx, rec); err != nil {
		return nil, err
	}
	if onboardErr != nil {
		slog.WarnContext(ctx, "workbench: onboarding failed", "userID", userID, "tokenID", rec.ID, "error", onboardErr)
		return nil, ErrWorkbenchFailed
	}
	return &WorkbenchJob{ID: jobID, State: "queued"}, nil
}

// WorkbenchStatus reports how the user's workbench onboarding is going. An
// install whose onboarding the workbench never took reads as failed.
func (s *RunnerTokenService) WorkbenchStatus(ctx context.Context, userID string) (*WorkbenchJob, error) {
	if s.workbench == nil {
		return nil, ErrWorkbenchOff
	}
	rec, err := s.workbenchInstall(ctx, userID)
	if err != nil {
		return nil, err
	}
	if rec == nil {
		return nil, ErrWorkbenchNotConnected
	}
	if rec.WorkbenchJob == "" {
		return &WorkbenchJob{State: WorkbenchJobFailed}, nil
	}
	job, err := s.workbench.Job(ctx, rec.WorkbenchJob)
	if err != nil {
		slog.WarnContext(ctx, "workbench: status check failed", "userID", userID, "job", rec.WorkbenchJob, "error", err)
		return nil, ErrWorkbenchUnreachable
	}
	return job, nil
}

// WorkbenchClient calls the workbench's onboarding API.
type WorkbenchClient struct {
	url    string // base URL, no trailing slash
	token  string // bearer token for the workbench API; empty sends none
	server string // this ex's address, for the runner to connect back to
	http   *http.Client
}

// NewWorkbenchClient returns a client for the workbench at baseURL that
// authenticates with apiToken and tells it to connect runners to server.
func NewWorkbenchClient(baseURL, apiToken, server string) *WorkbenchClient {
	return &WorkbenchClient{
		url:    strings.TrimRight(baseURL, "/"),
		token:  apiToken,
		server: server,
		http:   &http.Client{Timeout: workbenchTimeout},
	}
}

// Onboard posts {username, runner_token, server} to <url>/onboard.
func (c *WorkbenchClient) Onboard(ctx context.Context, username, runnerToken string) (string, error) {
	// Three strings: marshalling can't fail.
	body, _ := json.Marshal(map[string]string{
		"username":     username,
		"runner_token": runnerToken,
		"server":       c.server,
	})
	var job WorkbenchJob
	if err := c.do(ctx, http.MethodPost, "/onboard", body, &job); err != nil {
		return "", err
	}
	if job.ID == "" {
		return "", errors.New("workbench answered without a job id")
	}
	return job.ID, nil
}

// Job gets <url>/onboard/<id>.
func (c *WorkbenchClient) Job(ctx context.Context, id string) (*WorkbenchJob, error) {
	var job WorkbenchJob
	if err := c.do(ctx, http.MethodGet, "/onboard/"+url.PathEscape(id), nil, &job); err != nil {
		return nil, err
	}
	return &job, nil
}

// do sends one request and decodes a 2xx JSON answer into out.
func (c *WorkbenchClient) do(ctx context.Context, method, path string, body []byte, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, c.url+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode/100 != 2 {
		detail, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("workbench answered %d: %s", res.StatusCode, strings.TrimSpace(string(detail)))
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(out); err != nil {
		return fmt.Errorf("workbench answer: %w", err)
	}
	return nil
}
