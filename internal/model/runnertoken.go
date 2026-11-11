package model

import "time"

// RunnerToken is the server-side record behind one paired ex-runner install.
// The runner's JWT carries this ID as its `jti`, and the runner middleware
// accepts a runner JWT only while its row exists — so deleting the row
// revokes exactly that install, without rotating the signing secret (which
// would sign every user out).
type RunnerToken struct {
	ID     string `json:"id" dynamodbav:"id"`
	UserID string `json:"userID" dynamodbav:"userID"`
	// Label names the machine as the runner reported it at sign-in (its
	// hostname), so the owner can tell installs apart when revoking one.
	Label     string    `json:"label" dynamodbav:"label"`
	CreatedAt time.Time `json:"createdAt" dynamodbav:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt" dynamodbav:"expiresAt"`
	// LastUsedAt and LastIP say when and from where the install last made a
	// request — refreshed at most every few minutes, or when the IP changes.
	LastUsedAt time.Time `json:"lastUsedAt,omitempty" dynamodbav:"lastUsedAt,omitempty"`
	LastIP     string    `json:"lastIP,omitempty" dynamodbav:"lastIP,omitempty"`
	// DeviceKey is the install's device-bound public key (base64 std of a
	// P-256 SPKI DER). When set, every request must carry a proof signed by
	// its private key, which never leaves the computer.
	DeviceKey string `json:"-" dynamodbav:"deviceKey,omitempty"`
	// DeviceKeyHardware reports that the private key lives in the computer's
	// secure chip rather than in a file.
	DeviceKeyHardware bool `json:"deviceKeyHardware,omitempty" dynamodbav:"deviceKeyHardware,omitempty"`
}

// RunnerGrant is the short-lived, single-use approval a signed-in user gives
// in the browser while pairing an ex-runner. The browser hands its code to
// the runner on localhost; the runner redeems it together with the PKCE
// verifier only it holds, so a code that leaks (browser history, a proxy
// log) is useless on its own. Stored under the hash of the code, never the
// code itself.
type RunnerGrant struct {
	CodeHash string `json:"codeHash" dynamodbav:"codeHash"`
	UserID   string `json:"userID" dynamodbav:"userID"`
	// Challenge is the PKCE S256 challenge: base64url(sha256(verifier)).
	Challenge string    `json:"challenge" dynamodbav:"challenge"`
	Label     string    `json:"label" dynamodbav:"label"`
	ExpiresAt time.Time `json:"expiresAt" dynamodbav:"expiresAt"`
}
