package main

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestProductionLoggerEmitsParseableJSON(t *testing.T) {
	var buf bytes.Buffer
	logger := productionLogger(&buf)

	logger.Warn("author last-read mark failed", "parentID", "ch-1", "error", "store: item not found")

	var line map[string]any
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatalf("production log line is not JSON: %v\nline: %s", err, buf.String())
	}
	if line["level"] != "WARN" {
		t.Errorf("level = %v, want WARN", line["level"])
	}
	if line["msg"] != "author last-read mark failed" {
		t.Errorf("msg = %v", line["msg"])
	}
	if line["parentID"] != "ch-1" {
		t.Errorf("parentID field = %v, want ch-1 (attributes must be structured, not embedded in msg)", line["parentID"])
	}
}
