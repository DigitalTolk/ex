package model

// SharePointStatus is how far sharing a posted SharePoint link with its
// channel or conversation has got.
type SharePointStatus string

const (
	SharePointPending SharePointStatus = "pending"
	SharePointShared  SharePointStatus = "shared"
	SharePointFailed  SharePointStatus = "failed"
)

// SharePointProblem says why a link was not shared.
type SharePointProblem string

const (
	// SharePointSignIn: the poster's Microsoft sign-in has to be renewed —
	// none is stored, or it expired or was revoked.
	SharePointSignIn SharePointProblem = "sign_in"
	// SharePointDenied: the poster may not share the file.
	SharePointDenied SharePointProblem = "denied"
	// SharePointNotFound: the link doesn't lead to a file the poster can see.
	SharePointNotFound SharePointProblem = "not_found"
	// SharePointUnavailable: Microsoft 365 could not be reached.
	SharePointUnavailable SharePointProblem = "unavailable"
)

// SharePointFile is a SharePoint or OneDrive file (or folder) shared with a
// channel or conversation.
type SharePointFile struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	Folder   bool   `json:"folder,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
	WebURL   string `json:"webURL"`
	// EditURL opens the file for editing in Office for the web; empty for
	// files Office doesn't edit.
	EditURL string `json:"editURL,omitempty"`
	// DownloadURL downloads the file from SharePoint; empty for folders and
	// items Microsoft 365 gave no SharePoint ids.
	DownloadURL string `json:"downloadURL,omitempty"`
}

// SharePointLink is a SharePoint link as posted in a channel or conversation:
// the file it leads to, once known, and how sharing it went. Problem,
// SharedWith and NotShared are filled in only for the person who posted it.
type SharePointLink struct {
	URL      string            `json:"url"`
	Status   SharePointStatus  `json:"status"`
	PosterID string            `json:"posterID"`
	File     *SharePointFile   `json:"file,omitempty"`
	Problem  SharePointProblem `json:"problem,omitempty"`
	// SharedWith counts the members who have the file through this link.
	SharedWith int `json:"sharedWith,omitempty"`
	// NotShared lists the members it could not be shared with: guests,
	// accounts outside the directory, and members Microsoft 365 refused.
	NotShared []string `json:"notShared,omitempty"`
}

// SharePointChangedEvent is the sharepoint.changed payload: these links in
// the parent changed state.
type SharePointChangedEvent struct {
	ParentID   string   `json:"parentID"`
	ParentType string   `json:"parentType"`
	URLs       []string `json:"urls"`
}
