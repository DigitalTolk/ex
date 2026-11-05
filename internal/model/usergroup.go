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
