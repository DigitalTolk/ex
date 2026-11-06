package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path"
	"strings"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/msgraph"
)

// Office files in a channel or a conversation. A Word, Excel or PowerPoint
// file posted in a channel, a DM or a group DM goes into its uploader's
// OneDrive, under Ex/<channel> (Ex/Direct messages, or the group's name),
// rather than ex's own storage: the message then carries its
// link, which shares it with the members as any posted link is (see
// sharepoint.go) and shows it as its file, open for editing in Office.
// Everywhere else — and for anyone without a working Microsoft sign-in — it
// stays an ordinary attachment; the client falls back to that whenever this
// refuses.

// officeExtensions are the files that go to OneDrive.
var officeExtensions = map[string]bool{"doc": true, "docx": true, "xls": true, "xlsx": true, "ppt": true, "pptx": true}

// oneDriveFolder is the folder in the uploader's OneDrive the files go under.
const oneDriveFolder = "Ex"

// ErrMicrosoftSignInRequired: the uploader has no working Microsoft sign-in,
// so nothing can be put in their OneDrive.
var ErrMicrosoftSignInRequired = apperr.Conflict("sign in with Microsoft to keep Office files in OneDrive")

// OfficeUpload is an Office file put into its uploader's OneDrive.
type OfficeUpload struct {
	Name   string `json:"name"`
	WebURL string `json:"webURL"`
	Size   int64  `json:"size"`
}

// oneDriveName makes a name OneDrive accepts: none of " * : < > ? / \ | or
// control characters, and no leading or trailing spaces or dots.
func oneDriveName(name string) string {
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || strings.ContainsRune(`"*:<>?/\|`, r) {
			return '-'
		}
		return r
	}, name)
	return strings.Trim(name, " .")
}

// directMessagesFolder is where a DM's files go, under Ex.
const directMessagesFolder = "Direct messages"

// UploadOfficeFile puts an Office file, posted by userID in a channel or a
// conversation they belong to, into their own OneDrive and returns its
// link. body holds exactly size bytes.
func (s *SharePointService) UploadOfficeFile(ctx context.Context, userID, parentID, parentType, name string, body io.Reader, size int64) (*OfficeUpload, error) {
	name = oneDriveName(path.Base(strings.ReplaceAll(name, `\`, "/")))
	if !officeExtensions[strings.ToLower(strings.TrimPrefix(path.Ext(name), "."))] {
		return nil, apperr.Invalid("sharepoint: only Word, Excel and PowerPoint files go to OneDrive")
	}
	if !s.d.Uploads.AllowsExtension(ctx, name) || !s.d.Uploads.AllowsSize(ctx, size) {
		return nil, apperr.Invalid("sharepoint: this file's type or size isn't allowed")
	}
	folder, err := s.officeFolder(ctx, parentID, parentType)
	if err != nil {
		return nil, err
	}
	if err := s.d.Access.CheckAccess(ctx, userID, parentID, parentType); err != nil {
		return nil, err
	}
	ts, err := s.d.Tokens.TokenSource(ctx, userID)
	if errors.Is(err, ErrNoDelegatedToken) {
		return nil, ErrMicrosoftSignInRequired
	}
	if err != nil {
		return nil, err
	}
	item, err := s.d.Graph.Upload(ctx, ts, []string{oneDriveFolder, folder}, name, body, size)
	if errors.Is(err, msgraph.ErrSignInRequired) {
		return nil, ErrMicrosoftSignInRequired
	}
	if err != nil {
		return nil, fmt.Errorf("sharepoint: upload: %w", err)
	}
	// Only a link on a shared host reaches the channel's members; one on
	// another host would be a file only the uploader can open.
	u, err := url.Parse(item.WebURL)
	if err != nil || u.Scheme != "https" || !matchesHost(s.d.Hosts, u.Hostname()) {
		return nil, fmt.Errorf("sharepoint: uploaded file's link %q is not on a shared host", item.WebURL)
	}
	return &OfficeUpload{Name: item.Name, WebURL: item.WebURL, Size: item.Size}, nil
}

// officeFolder is the folder under Ex a parent's Office files go in: a
// channel's name (its id when the name leaves nothing OneDrive accepts), a
// group DM's name, else Direct messages. ~general (whose links are never
// shared: that would share with everyone), archived channels, and a group DM
// since turned into a channel keep theirs as attachments.
func (s *SharePointService) officeFolder(ctx context.Context, parentID, parentType string) (string, error) {
	if parentType == ParentConversation {
		conv, err := s.d.Conversations.GetConversation(ctx, parentID)
		if err != nil {
			return "", err
		}
		if conv.ConvertedToChannelID != "" {
			return "", apperr.Invalid("sharepoint: this conversation is now a channel")
		}
		if name := oneDriveName(conv.Name); name != "" {
			return name, nil
		}
		return directMessagesFolder, nil
	}
	if parentType != ParentChannel {
		return "", apperr.Invalid("sharepoint: invalid parent type")
	}
	if parentID == generalChannelID {
		return "", apperr.Invalid("sharepoint: ~general's files aren't shared")
	}
	ch, err := s.d.Channels.GetByID(ctx, parentID)
	if err != nil {
		return "", err
	}
	if ch.Archived {
		return "", apperr.Invalid("sharepoint: the channel is archived")
	}
	if name := oneDriveName(ch.Name); name != "" {
		return name, nil
	}
	return ch.ID, nil
}
