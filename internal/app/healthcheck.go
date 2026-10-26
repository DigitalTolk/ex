package app

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// HealthCheck is the `ex healthcheck` subcommand: a single GET against the
// local /healthz endpoint, returning a process exit code — 0 when the server
// reports healthy (HTTP 200), 1 otherwise. It is the binary's built-in answer
// to a Docker HEALTHCHECK on the distroless runtime, which has no shell or
// wget to probe the endpoint itself.
func HealthCheck() int {
	url := "http://localhost:" + healthCheckPort(os.Getenv) + "/healthz"
	return runHealthCheck(&http.Client{Timeout: 3 * time.Second}, url, os.Stderr)
}

// healthCheckPort mirrors config.Load's PORT default so `ex healthcheck`
// probes the right local address without loading the full config (no
// DynamoDB / Redis connection needed just to answer a liveness probe).
func healthCheckPort(getenv func(string) string) string {
	if p := getenv("PORT"); p != "" {
		return p
	}
	return "8080"
}

func runHealthCheck(client *http.Client, url string, stderr io.Writer) int {
	resp, err := client.Get(url)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "healthcheck:", err)
		return 1
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		_, _ = fmt.Fprintf(stderr, "healthcheck: unhealthy status %d\n", resp.StatusCode)
		return 1
	}
	return 0
}
