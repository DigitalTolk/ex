//go:build !integration

package app

import "testing"

// Without the integration tag no containers start; the boot tests live in
// integration-tagged files.
func runWithContainers(m *testing.M) int { return m.Run() }
