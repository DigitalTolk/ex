package model

import "time"

// UserGroupIDPrefix starts every user-group ID. A group is mentioned with the
// same "@[id|label]" token as a person, so the prefix is what tells a mention
// parser it names a group (ULID user IDs and "bot-" IDs never start with it).
const UserGroupIDPrefix = "group-"

// UserGroup is a named set of people mentioned together through its handle
// (Slack-style "@oncall"). Groups come from the Microsoft 365 (Entra ID)
// department field: one per department and one per squad, created and kept
// in sync by the directory sweep. A disabled group keeps its members and its
// handle but is not mentionable.
type UserGroup struct {
	ID          string    `json:"id" dynamodbav:"id"`
	Handle      string    `json:"handle" dynamodbav:"handle"`
	Name        string    `json:"name" dynamodbav:"name"`
	Description string    `json:"description" dynamodbav:"description"`
	Disabled    bool      `json:"disabled" dynamodbav:"disabled"`
	MemberCount int       `json:"memberCount" dynamodbav:"memberCount"`
	CreatedBy   string    `json:"createdBy" dynamodbav:"createdBy"`
	CreatedAt   time.Time `json:"createdAt" dynamodbav:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt" dynamodbav:"updatedAt"`

	// Source is the department or squad the members come from.
	Source UserGroupSource `json:"source" dynamodbav:"source"`
	// AdminEdited is set once an admin edits the handle, name or description:
	// the sweep then never overwrites them.
	AdminEdited bool `json:"adminEdited,omitempty" dynamodbav:"adminEdited,omitempty"`
	// SyncSkipped counts the people Microsoft 365 lists for the source who
	// aren't group members in ex (no ex account yet, a guest or deactivated).
	SyncSkipped int `json:"syncSkipped,omitempty" dynamodbav:"syncSkipped,omitempty"`
	// SyncState is why the last sweep didn't fully apply ("" when it did).
	SyncState UserGroupSyncState `json:"syncState,omitempty" dynamodbav:"syncState,omitempty"`
	// PendingRemoval is how many members a held sync would remove.
	PendingRemoval int `json:"pendingRemoval,omitempty" dynamodbav:"pendingRemoval,omitempty"`
	// RemovalApproved: an admin approved the held removal; the next sweep
	// applies it.
	RemovalApproved bool `json:"removalApproved,omitempty" dynamodbav:"removalApproved,omitempty"`
}

// UserGroupSourceKind says what a group follows.
type UserGroupSourceKind string

const (
	UserGroupSourceDepartment UserGroupSourceKind = "department"
	UserGroupSourceSquad      UserGroupSourceKind = "squad"
)

// UserGroupSource is the department or squad a group's members come from.
// Key identifies it (case- and spacing-insensitive): "dept:<department>" or
// "squad:<squad>".
type UserGroupSource struct {
	Kind UserGroupSourceKind `json:"kind" dynamodbav:"kind"`
	// Department is the department's name; for a squad, the department most
	// of its members list.
	Department string `json:"department,omitempty" dynamodbav:"department,omitempty"`
	Squad      string `json:"squad,omitempty" dynamodbav:"squad,omitempty"`
	Key        string `json:"key" dynamodbav:"key"`
}

// UserGroupSyncState says why a group's last sweep didn't fully apply.
type UserGroupSyncState string

const (
	// UserGroupSyncHeld: the sweep would remove most members (or all of
	// them); the removal waits for an admin's approval.
	UserGroupSyncHeld UserGroupSyncState = "held-removal"
	// UserGroupSyncSourceMissing: nobody in Microsoft 365 has the department
	// or squad any more; the members are kept until an admin approves.
	UserGroupSyncSourceMissing UserGroupSyncState = "source-missing"
)

// UserGroupSyncStatus is the last directory sweep's group sync, for admins.
type UserGroupSyncStatus struct {
	// LastSyncedAt is when the last sweep finished; nil before the first.
	LastSyncedAt *time.Time `json:"lastSyncedAt,omitempty"`
	// Held is set while a sweep was held because far fewer departments came
	// back than the time before; the next sweep applies if it agrees.
	Held bool `json:"held,omitempty"`
	// Readable is how many people had a readable department.
	Readable  int                     `json:"readable"`
	Anomalies DepartmentAnomalyReport `json:"anomalies"`
}

// DepartmentAnomalyReport summarises the department values the parser read
// only partly: a count per kind, and up to a few example values.
type DepartmentAnomalyReport struct {
	People   int                 `json:"people"`
	Counts   map[string]int      `json:"counts"`
	Examples []DepartmentAnomaly `json:"examples"`
}

// DepartmentAnomaly is one unusual department value and how many people
// have it.
type DepartmentAnomaly struct {
	Value  string   `json:"value"`
	Kinds  []string `json:"kinds"`
	People int      `json:"people"`
}

// UserGroupDetail is a group with its member IDs. The members are rows of
// their own (one per member), so a group has no size limit. Version is the
// group row's optimistic-concurrency counter.
type UserGroupDetail struct {
	UserGroup `tstype:",extends"`
	MemberIDs []string `json:"memberIds" dynamodbav:"-"`
	Version   int64    `json:"-" dynamodbav:"version"`
}
