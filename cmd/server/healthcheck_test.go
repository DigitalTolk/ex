package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthCheckPort(t *testing.T) {
	if got := healthCheckPort(func(string) string { return "" }); got != "8080" {
		t.Fatalf("default port = %q, want 8080", got)
	}
	getenv := func(k string) string {
		if k == "PORT" {
			return "3000"
		}
		return ""
	}
	if got := healthCheckPort(getenv); got != "3000" {
		t.Fatalf("env port = %q, want 3000", got)
	}
}

func TestRunHealthCheck(t *testing.T) {
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer healthy.Close()
	if code := runHealthCheck(healthy.Client(), healthy.URL+"/healthz"); code != 0 {
		t.Fatalf("healthy probe exit = %d, want 0", code)
	}

	unhealthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer unhealthy.Close()
	if code := runHealthCheck(unhealthy.Client(), unhealthy.URL+"/healthz"); code != 1 {
		t.Fatalf("unhealthy probe exit = %d, want 1", code)
	}

	// A connection error (nothing listening) is also unhealthy.
	if code := runHealthCheck(http.DefaultClient, "http://127.0.0.1:1/healthz"); code != 1 {
		t.Fatalf("connection-error probe exit = %d, want 1", code)
	}
}
