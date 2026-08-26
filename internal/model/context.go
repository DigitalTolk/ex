package model

import "time"

// ContextItem is one curated shared-context entry for a channel or
// conversation (plan-v2 §8): briefs, decisions, constraints. Humans write
// them in the UI; agents append via the write_shared_context tool. Every
// agent run in that parent reads them — this is the "central context which
// they can share".
type ContextItem struct {
	ID         string `json:"id" dynamodbav:"id"`
	ParentID   string `json:"parentID" dynamodbav:"parentID"`
	ParentType string `json:"parentType" dynamodbav:"parentType"`

	// AuthorID is who wrote the item — a human user or a shared agent. When
	// an agent wrote it, InvokerID records whose run it was (the agent is
	// shared; attribution is always to the invoking human).
	AuthorID  string `json:"authorID" dynamodbav:"authorID"`
	InvokerID string `json:"invokerID,omitempty" dynamodbav:"invokerID,omitempty"`

	Body   string `json:"body" dynamodbav:"body"`
	Pinned bool   `json:"pinned,omitempty" dynamodbav:"pinned,omitempty"`

	CreatedAt time.Time `json:"createdAt" dynamodbav:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt" dynamodbav:"updatedAt"`
}

// Shared-context governance bounds (plan-v2 §8). Config-worthy later; consts
// until someone needs to tune them.
const (
	ContextItemMaxBytes  = 2048
	ContextItemsPerScope = 50
)
