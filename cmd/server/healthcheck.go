package main

import (
	"fmt"
	"net/http"
	"os"
	"time"
)

// healthCheckPort mirrors config.Load's PORT default so `ex healthcheck`
// probes the right local address without loading the full config (no
// DynamoDB / Redis connection needed just to answer a liveness probe).
func healthCheckPort(getenv func(string) string) string {
	if p := getenv("PORT"); p != "" {
		return p
	}
	return "8080"
}

// runHealthCheck issues a single GET against the local /healthz endpoint
// and returns a process exit code: 0 when the server reports healthy
// (HTTP 200), 1 otherwise. This is the binary's built-in answer to a
// Docker HEALTHCHECK on the distroless runtime, which has no shell or
// wget to probe the endpoint itself.
func runHealthCheck(client *http.Client, url string) int {
	resp, err := client.Get(url)
	if err != nil {
		fmt.Fprintln(os.Stderr, "healthcheck:", err)
		return 1
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "healthcheck: unhealthy status %d\n", resp.StatusCode)
		return 1
	}
	return 0
}

// healthCheckCommand wires the default client and URL from the
// environment, then runs the probe. Invoked when the binary is started
// as `ex healthcheck`.
func healthCheckCommand() int {
	url := "http://localhost:" + healthCheckPort(os.Getenv) + "/healthz"
	return runHealthCheck(&http.Client{Timeout: 3 * time.Second}, url)
}
