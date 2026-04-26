package model

import "time"

type ChannelType string

const (
	ChannelTypePublic  ChannelType = "public"
	ChannelTypePrivate ChannelType = "private"
)

type ChannelRole int

const (
	ChannelRoleMember ChannelRole = 1
	ChannelRoleAdmin  ChannelRole = 2
	ChannelRoleOwner  ChannelRole = 3
)

func (r ChannelRole) String() string {
	switch r {
	case ChannelRoleMember:
		return "member"
	case ChannelRoleAdmin:
		return "admin"
	case ChannelRoleOwner:
		return "owner"
	default:
		return "unknown"
	}
}

func ParseChannelRole(s string) ChannelRole {
	switch s {
	case "owner":
		return ChannelRoleOwner
	case "admin":
		return ChannelRoleAdmin
	default:
		return ChannelRoleMember
	}
}

type Channel struct {
	ID          string      `json:"id" dynamodbav:"id"`
	Name        string      `json:"name" dynamodbav:"name"`
	Slug        string      `json:"slug" dynamodbav:"slug"`
	Description string      `json:"description,omitempty" dynamodbav:"description,omitempty"`
	Type        ChannelType `json:"type" dynamodbav:"type"`
	CreatedBy   string      `json:"createdBy" dynamodbav:"createdBy"`
	Archived    bool        `json:"archived" dynamodbav:"archived"`
	CreatedAt   time.Time   `json:"createdAt" dynamodbav:"createdAt"`
	UpdatedAt   time.Time   `json:"updatedAt" dynamodbav:"updatedAt"`
}
