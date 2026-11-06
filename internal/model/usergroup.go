package model

import "time"

// UserGroupIDPrefix starts every user-group ID. A group is mentioned with the
// same "@[id|label]" token as a person, so the prefix is what tells a mention
// parser it names a group (ULID user IDs and "bot-" IDs never start with it).
const UserGroupIDPrefix = "group-"

// UserGroup is a named set of people mentioned together through its handle
// (Slack-style "@oncall"). A disabled group keeps its members and its handle
// but is not mentionable.
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

	// EntraGroupID links the group to a Microsoft Entra ID group: its members
	// then come from Entra (synced, read-only in ex). Empty: members are
	// managed in ex.
	EntraGroupID string `json:"entraGroupId,omitempty" dynamodbav:"entraGroupId,omitempty"`
	// EntraGroupName is the linked group's display name, refreshed on link and
	// on Sync now.
	EntraGroupName string `json:"entraGroupName,omitempty" dynamodbav:"entraGroupName,omitempty"`
	// SyncedAt is when the linked group last synced successfully.
	SyncedAt *time.Time `json:"syncedAt,omitempty" dynamodbav:"syncedAt,omitempty"`
	// SyncSkipped counts the Entra members who aren't group members in ex
	// (no ex account yet, a guest, a bot or deactivated).
	SyncSkipped int `json:"syncSkipped,omitempty" dynamodbav:"syncSkipped,omitempty"`
	// SyncState is why the last sync didn't apply ("" when it did).
	SyncState UserGroupSyncState `json:"syncState,omitempty" dynamodbav:"syncState,omitempty"`
	// PendingRemoval is how many members a held sync would remove.
	PendingRemoval int `json:"pendingRemoval,omitempty" dynamodbav:"pendingRemoval,omitempty"`
}

// UserGroupSyncState says why a linked group's last sync didn't apply.
type UserGroupSyncState string

const (
	// UserGroupSyncOversize: the Entra group has more members than a user
	// group holds; members stay as last synced.
	UserGroupSyncOversize UserGroupSyncState = "paused-oversize"
	// UserGroupSyncHeld: the sync would remove most members (or all of them);
	// it waits for an admin to apply it.
	UserGroupSyncHeld UserGroupSyncState = "held-removal"
	// UserGroupSyncSourceMissing: the Entra group is gone or unreadable; the
	// group was disabled with its members kept.
	UserGroupSyncSourceMissing UserGroupSyncState = "source-missing"
	// UserGroupSyncError: Microsoft Graph failed; members stay.
	UserGroupSyncError UserGroupSyncState = "error"
)

// Linked reports whether the group's members come from Entra.
func (g UserGroup) Linked() bool { return g.EntraGroupID != "" }

// EntraGroup is a Microsoft Entra ID group as the link picker shows it.
type EntraGroup struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	Mail        string `json:"mail,omitempty"`
	// Kind is "m365", "security" or "dynamic".
	Kind string `json:"kind"`
}

// UserGroupLinkPreview is what linking a group to an Entra group would do.
type UserGroupLinkPreview struct {
	// Users is how many users the Entra group has (nested groups included).
	Users     int  `json:"users"`
	ToAdd     int  `json:"toAdd"`
	ToRemove  int  `json:"toRemove"`
	Skipped   int  `json:"skipped"`
	OverLimit bool `json:"overLimit"`
}

// UserGroupDetail is a group with its member IDs. Version is the store's
// optimistic-concurrency counter: every write of a group expects the version
// it read, so two concurrent member edits can't overwrite each other or push
// a group past its cap.
type UserGroupDetail struct {
	UserGroup `tstype:",extends"`
	MemberIDs []string `json:"memberIds" dynamodbav:"memberIds"`
	Version   int64    `json:"-" dynamodbav:"version"`
}

// UserGroupManagers says who may create and edit user groups.
type UserGroupManagers string

const (
	UserGroupManagersAdmins  UserGroupManagers = "admins"
	UserGroupManagersMembers UserGroupManagers = "members"
)
