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
