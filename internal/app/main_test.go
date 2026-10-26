package app

import (
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

func TestMain(m *testing.M) {
	// Hermetic AWS configuration: no developer profile or credentials reach
	// the tests (DynamoDB Local accepts any static key).
	dir, err := os.MkdirTemp("", "ex-app-aws-")
	if err != nil {
		panic(err)
	}
	_ = os.Setenv("AWS_CONFIG_FILE", filepath.Join(dir, "config"))
	_ = os.Setenv("AWS_SHARED_CREDENTIALS_FILE", filepath.Join(dir, "credentials"))
	_ = os.Unsetenv("AWS_PROFILE")
	_ = os.Setenv("AWS_ACCESS_KEY_ID", "dummy")
	_ = os.Setenv("AWS_SECRET_ACCESS_KEY", "dummy")
	_ = os.Setenv("AWS_EC2_METADATA_DISABLED", "true")
	// A booting app logs every step; keep test output to the failures.
	slog.SetDefault(slog.New(slog.DiscardHandler))

	code := runWithContainers(m)
	_ = os.RemoveAll(dir)
	os.Exit(code)
}
