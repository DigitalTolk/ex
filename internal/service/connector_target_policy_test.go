package service

import "testing"

// Connector URL validation is strict by default (see validateOutboundURL) but
// the suite verifies against loopback httptest servers, so the whole package
// runs with the development relaxation on. The strict arms are exercised
// explicitly in TestConnector_OutboundURLPolicy, which flips it back.
func init() { allowPrivateConnectorTargets = true }

// TestConnector_OutboundURLPolicy pins the production policy: https only, to a
// routable host — the targets the server later hits WITH a user's credential.
func TestConnector_OutboundURLPolicy(t *testing.T) {
	allowPrivateConnectorTargets = false
	t.Cleanup(func() { allowPrivateConnectorTargets = true })

	ok := []string{"", "https://api.example.com/v1", "https://sub.example.com:8443/x"}
	for _, u := range ok {
		if err := validateOutboundURL(u); err != nil {
			t.Fatalf("%q should be allowed: %v", u, err)
		}
	}
	bad := []string{
		"http://api.example.com",       // plaintext
		"https://localhost/api",        // loopback by name
		"https://api.localhost/x",      // loopback suffix
		"https://127.0.0.1/api",        // loopback literal
		"https://[::1]/api",            // loopback v6
		"https://10.0.0.5/api",         // RFC-1918
		"https://192.168.1.1/api",      // RFC-1918
		"https://169.254.169.254/meta", // link-local metadata endpoint
		"https://0.0.0.0/x",            // unspecified
		"https://239.1.1.1/x",          // multicast
		"https://[ff01::1]/x",          // interface-local multicast
		"https:///nohost",              // no host
		"://nope",                      // unparseable
	}
	for _, u := range bad {
		if err := validateOutboundURL(u); err == nil {
			t.Fatalf("%q should be refused", u)
		}
	}
}
