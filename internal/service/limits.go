package service

import "github.com/DigitalTolk/ex/internal/limits"

// The input ceilings and validators live in internal/limits so the history
// importer enforces exactly the same rules; these names keep the service API.
const (
	MaxMessageBodyChars      = limits.MaxMessageBodyChars
	MaxAttachmentsPerMessage = limits.MaxAttachmentsPerMessage
	MaxMessageListLimit      = limits.MaxMessageListLimit
	MaxChannelNameLen        = limits.MaxChannelNameLen
	MaxChannelDescriptionLen = limits.MaxChannelDescriptionLen
	MaxDistinctReactions     = limits.MaxDistinctReactions
)

var (
	ErrMessageTooLong            = limits.ErrMessageTooLong
	ErrTooManyAttachments        = limits.ErrTooManyAttachments
	ErrTooManyReactions          = limits.ErrTooManyReactions
	ErrChannelNameInvalid        = limits.ErrChannelNameInvalid
	ErrChannelNameTooLong        = limits.ErrChannelNameTooLong
	ErrChannelDescriptionTooLong = limits.ErrChannelDescriptionTooLong

	ValidateMessageBody        = limits.ValidateMessageBody
	ValidateAttachmentCount    = limits.ValidateAttachmentCount
	ValidateChannelName        = limits.ValidateChannelName
	ValidateChannelDescription = limits.ValidateChannelDescription
)
