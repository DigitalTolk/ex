// Package service (directory webhookcompat) is a frozen copy of the shape a
// classic incoming webhook's payload had before rich webhooks existed
// (origin/main at 933dc8a). It exists for one job: decoding a post with it
// reproduces, exactly, whether main accepted it and the error text main gave
// when it didn't — encoding/json names the target's types in that text
// ("…into Go value of type service.IncomingWebhookPayload"), so the package
// and type names are main's too.
//
// Never edit these types. Classic senders' behaviour is pinned by
// internal/handler's TestClassicWebhooksBehaveAsBefore against a golden
// recorded on main.
package service

import "github.com/DigitalTolk/ex/internal/webhookcompat/model"

// IncomingWebhookPayload is main's classic payload, field for field.
type IncomingWebhookPayload struct {
	Text        string                    `json:"text"`
	Channel     string                    `json:"channel"`
	Username    string                    `json:"username"`
	IconURL     string                    `json:"icon_url"`
	IconEmoji   string                    `json:"icon_emoji"`
	Attachments []model.MessageAttachment `json:"attachments"`
	RootID      string                    `json:"root_id"`
}
