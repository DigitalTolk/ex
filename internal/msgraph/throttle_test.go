package msgraph

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// graphServer serves Graph requests with handler, after a token server.
func graphServer(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	tokenSrv, _ := newTokenServer(t, 3600)
	api := httptest.NewServer(handler)
	t.Cleanup(api.Close)
	c := newClient(t, tokenSrv.URL, api.URL)
	c.wait = func(context.Context, time.Duration) error { return nil }
	return c
}

func writeJSONBody(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func TestThrottledCallsRetryAsAsked(t *testing.T) {
	var calls atomic.Int64
	c := graphServer(t, func(w http.ResponseWriter, _ *http.Request) {
		switch calls.Add(1) {
		case 1:
			w.Header().Set("Retry-After", "7")
			w.WriteHeader(http.StatusTooManyRequests)
		case 2:
			w.WriteHeader(http.StatusServiceUnavailable)
		default:
			writeJSONBody(w, map[string]any{"value": []any{}})
		}
	})
	var waits []time.Duration
	c.wait = func(_ context.Context, d time.Duration) error { waits = append(waits, d); return nil }
	if _, err := c.ListUserAccounts(context.Background()); err != nil {
		t.Fatalf("ListUserAccounts after throttling = %v", err)
	}
	if !slices.Equal(waits, []time.Duration{7 * time.Second, defaultRetryAfter}) {
		t.Fatalf("waits = %v", waits)
	}
}

func TestThrottledCallsGiveUp(t *testing.T) {
	var calls atomic.Int64
	c := graphServer(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusTooManyRequests)
	})
	if _, err := c.ListUserAccounts(context.Background()); err == nil || !strings.Contains(err.Error(), "throttled") {
		t.Fatalf("ListUserAccounts = %v, want the throttling error", err)
	}
	if calls.Load() != throttleAttempts {
		t.Fatalf("calls = %d, want %d", calls.Load(), throttleAttempts)
	}

	c.wait = func(context.Context, time.Duration) error { return context.Canceled }
	if _, err := c.ListUserAccounts(context.Background()); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled wait = %v", err)
	}
}

func TestRetryDelay(t *testing.T) {
	for header, want := range map[string]time.Duration{
		"":      defaultRetryAfter,
		"nope":  defaultRetryAfter,
		"0":     defaultRetryAfter,
		"3":     3 * time.Second,
		"99999": maxRetryAfter,
	} {
		res := &http.Response{Header: http.Header{"Retry-After": []string{header}}}
		if got := retryDelay(res); got != want {
			t.Errorf("retryDelay(%q) = %v, want %v", header, got, want)
		}
	}
}

func TestWaitCtx(t *testing.T) {
	if err := waitCtx(context.Background(), time.Millisecond); err != nil {
		t.Fatalf("waitCtx = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := waitCtx(ctx, time.Hour); !errors.Is(err, context.Canceled) {
		t.Fatalf("waitCtx(cancelled) = %v", err)
	}
}

// A request that never reaches Graph (a dead endpoint) reports a transport
// error, for the shared request path the delegated and upload calls use.
func TestCallReportsATransportError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close()
	err := call(context.Background(), http.DefaultClient, url, "tok", http.MethodGet, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "msgraph: request:") {
		t.Fatalf("call to a dead endpoint = %v, want a transport error", err)
	}
}
