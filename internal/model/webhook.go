package model

import "time"

type IncomingWebhook struct {
	ID              string    `json:"id" dynamodbav:"id"`
	Title           string    `json:"title" dynamodbav:"title"`
	Description     string    `json:"description,omitempty" dynamodbav:"description,omitempty"`
	ChannelID       string    `json:"channelID" dynamodbav:"channelID"`
	ChannelName     string    `json:"channelName,omitempty" dynamodbav:"channelName,omitempty"`
	ChannelSlug     string    `json:"channelSlug,omitempty" dynamodbav:"channelSlug,omitempty"`
	LockToChannel   bool      `json:"lockToChannel" dynamodbav:"lockToChannel"`
	Username        string    `json:"username,omitempty" dynamodbav:"username,omitempty"`
	ProfileImageURL string    `json:"profileImageURL,omitempty" dynamodbav:"profileImageURL,omitempty"`
	CreatedBy       string    `json:"createdBy" dynamodbav:"createdBy"`
	CreatedAt       time.Time `json:"createdAt" dynamodbav:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt" dynamodbav:"updatedAt"`
}
