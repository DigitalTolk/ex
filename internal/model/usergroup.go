package model

import "time"

// UserGroupIDPrefix starts every user-group ID. A group is mentioned with the
// same "@[id|label]" token as a person, so the prefix is what tells a mention
// parser it names a group (ULID user IDs and "bot-" IDs never start with it).
const UserGroupIDPrefix = "group-"

// UserGroup is a named set of people mentioned together through its handle
// (Slack-style "@oncall"). Groups come from Microsoft 365 (Entra ID): each
// security group in the configured parent group is one user group, its
// display name the handle, kept in sync by the user-group sync. A disabled
// group keeps its members and its handle but is not mentionable.
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

	// Source is the Entra group the group follows.
	Source UserGroupSource `json:"source" dynamodbav:"source"`
	// SyncSkipped counts the people in the Entra group who aren't group
	// members in ex (no ex account, a guest, a bot or deactivated).
	SyncSkipped int `json:"syncSkipped,omitempty" dynamodbav:"syncSkipped,omitempty"`
	// SyncState flags something about the source an admin should know (""
	// when there's nothing).
	SyncState UserGroupSyncState `json:"syncState,omitempty" dynamodbav:"syncState,omitempty"`
}

// UserGroupSourceEntraGroup is the kind of a group that follows an Entra
// security group.
const UserGroupSourceEntraGroup = "entra-group"

// UserGroupSource is where a group's members come from. Key identifies it
// ("entra-group:<object id>") and is claimed, so one source backs at most one
// group; it never changes, so renaming the Entra group renames this group.
type UserGroupSource struct {
	Kind string `json:"kind" dynamodbav:"kind"`
	ID   string `json:"id" dynamodbav:"id"`
	Key  string `json:"key" dynamodbav:"key"`
}

// UserGroupSyncState flags a group's source for admins.
type UserGroupSyncState string

const (
	// UserGroupSyncSourceMissing: the Entra group left the parent group (or
	// was deleted), so the group has no members; an admin can disable it.
	UserGroupSyncSourceMissing UserGroupSyncState = "source-missing"
	// UserGroupSyncHandleConflict: the Entra group was renamed to a handle ex
	// can't use (invalid, reserved, or held by another group or a bot), so
	// the group keeps its handle until that's fixed.
	UserGroupSyncHandleConflict UserGroupSyncState = "handle-conflict"
)

// UserGroupSyncStatus is how the user-group sync went, for admins.
type UserGroupSyncStatus struct {
	// Configured is false when no parent group is set, so nothing syncs.
	Configured bool `json:"configured"`
	// IntervalMinutes is how often the scheduled sync runs.
	IntervalMinutes int `json:"intervalMinutes"`
	// Running is set while a sync runs; StartedAt and Trigger ("scheduled"
	// or "manual") describe it.
	Running   bool       `json:"running"`
	StartedAt *time.Time `json:"startedAt,omitempty"`
	Trigger   string     `json:"trigger,omitempty"`
	// LastSyncedAt is when the last successful sync finished; nil before
	// the first.
	LastSyncedAt *time.Time `json:"lastSyncedAt,omitempty"`
	// FinishedAt is when the last sync, successful or not, finished.
	FinishedAt *time.Time `json:"finishedAt,omitempty"`
	// LastError says why the last sync failed; "" when it succeeded.
	LastError string `json:"lastError,omitempty"`
	// Skipped lists the Entra groups the last sync couldn't create or rename.
	Skipped []UserGroupSyncSkip `json:"skipped"`
}

// UserGroupSyncSkip is an Entra group a sync couldn't use as it is, and why.
type UserGroupSyncSkip struct {
	// GroupID is the ex group (when it exists), Name the Entra group's name.
	GroupID string `json:"groupId,omitempty"`
	Name    string `json:"name"`
	Reason  string `json:"reason"`
}

// UserGroupDetail is a group with its member IDs. The members are rows of
// their own (one per member), so a group has no size limit. Version is the
// group row's optimistic-concurrency counter.
type UserGroupDetail struct {
	UserGroup `tstype:",extends"`
	MemberIDs []string `json:"memberIds" dynamodbav:"-"`
	Version   int64    `json:"-" dynamodbav:"version"`
}
