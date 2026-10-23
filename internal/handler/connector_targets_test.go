package handler

import (
	"github.com/DigitalTolk/ex/internal/agents"
)

// The connector handler tests drive loopback httptest servers, which the
// connector clients refuse at dial time outside a development workspace (see
// internal/netguard). The policy itself is tested in internal/service.
func init() { agents.AllowPrivateConnectorTargets(true) }
