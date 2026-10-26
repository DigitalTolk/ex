package config

import (
	"errors"
	"strings"
	"testing"

	"github.com/caarlos0/env/v11"
)

// A parse failure names the variable an operator set, not the Go field, and
// every bad variable is reported in one boot attempt.
func TestLoadParseErrorsNameTheVariable(t *testing.T) {
	clearEnv(t)
	t.Setenv("ENV", "development")
	t.Setenv("TRUSTED_PROXY_COUNT", "abc")
	t.Setenv("JWT_ACCESS_TTL", "soon")

	_, err := Load()
	if err == nil {
		t.Fatal("Load with two unparsable variables should fail")
	}
	for _, want := range []string{"invalid TRUSTED_PROXY_COUNT", "invalid JWT_ACCESS_TTL"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
	if strings.Contains(err.Error(), "TrustedProxyCount") {
		t.Errorf("error %q leaks the Go field name", err)
	}
}

func TestEnvErrorKeepsOtherErrors(t *testing.T) {
	plain := errors.New("not from env")
	if got := envError(plain); got != plain {
		t.Fatalf("envError(plain) = %v, want it unchanged", got)
	}

	unset := env.VarIsNotSetError{Key: "SOME_VAR"}
	got := envError(env.AggregateError{Errors: []error{unset}})
	if !errors.Is(got, unset) {
		t.Fatalf("envError dropped a non-parse error: %v", got)
	}
}
