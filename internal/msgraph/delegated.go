package msgraph

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"golang.org/x/oauth2"
)

// Delegated calls Microsoft Graph as a signed-in user, with that user's own
// token, so Graph allows exactly what the user may do. Sharing a file runs
// this way and never with the app's rights: with app-only access anyone could
// paste a link to a file they may not share, and the app would share it.
type Delegated struct {
	baseURL string
	client  *http.Client
}

// NewDelegated builds a Delegated client. BaseURL and HTTPClient are
// injectable for tests; empty and nil take the Graph defaults.
func NewDelegated(baseURL string, httpClient *http.Client) (*Delegated, error) {
	baseURL = strings.TrimSpace(baseURL)
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	if _, err := url.ParseRequestURI(baseURL); err != nil {
		return nil, fmt.Errorf("msgraph: invalid base URL: %w", err)
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}
	return &Delegated{baseURL: strings.TrimRight(baseURL, "/"), client: httpClient}, nil
}

// DriveItem is the slice of a SharePoint or OneDrive item the app shows.
type DriveItem struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	WebURL string `json:"webUrl"`
	File   *struct {
		MimeType string `json:"mimeType"`
	} `json:"file,omitempty"`
	Folder          *struct{} `json:"folder,omitempty"`
	ParentReference struct {
		DriveID string `json:"driveId"`
	} `json:"parentReference"`
	SharePointIDs *struct {
		ListItemUniqueID string `json:"listItemUniqueId"`
		SiteURL          string `json:"siteUrl"`
	} `json:"sharepointIds,omitempty"`
}

// officeEditable are the file types Office for the web opens for editing.
var officeEditable = map[string]bool{
	"docx": true, "docm": true, "dotx": true,
	"xlsx": true, "xlsm": true, "xlsb": true,
	"pptx": true, "pptm": true, "ppsx": true,
	"vsdx": true, "odt": true, "ods": true, "odp": true,
}

// EditURL is where the item opens for editing in Office for the web, or ""
// when Office doesn't edit this kind of file.
func (i *DriveItem) EditURL() string {
	ext := strings.ToLower(strings.TrimPrefix(path.Ext(i.Name), "."))
	if !officeEditable[ext] {
		return ""
	}
	return i.layoutsURL("Doc.aspx", func(id string) url.Values {
		return url.Values{"sourcedoc": {"{" + id + "}"}, "action": {"edit"}}
	})
}

// DownloadURL is where SharePoint downloads the file, or "" for a folder.
// (An Office file's webUrl opens its viewer instead.)
func (i *DriveItem) DownloadURL() string {
	return i.layoutsURL("download.aspx", func(id string) url.Values { return url.Values{"UniqueId": {id}} })
}

// layoutsURL is a file's address under its site's _layouts/15 pages, or ""
// for a folder or an item without SharePoint ids.
func (i *DriveItem) layoutsURL(page string, query func(uniqueID string) url.Values) string {
	if i.File == nil || i.SharePointIDs == nil || i.SharePointIDs.ListItemUniqueID == "" || i.SharePointIDs.SiteURL == "" {
		return ""
	}
	return strings.TrimRight(i.SharePointIDs.SiteURL, "/") + "/_layouts/15/" + page + "?" + query(i.SharePointIDs.ListItemUniqueID).Encode()
}

const driveItemSelect = "id,name,size,webUrl,file,folder,parentReference,sharepointIds"

// ResolveLink looks up the item a SharePoint or OneDrive link points to —
// a sharing link or the item's own address. ErrNotFound when the user can't
// see it.
func (d *Delegated) ResolveLink(ctx context.Context, ts oauth2.TokenSource, link string) (*DriveItem, error) {
	var ref DriveItem
	if err := d.do(ctx, ts, http.MethodGet, "/shares/"+EncodeShareURL(link)+"/driveItem", nil, &ref); err != nil {
		return nil, err
	}
	// The shares endpoint leaves out the SharePoint ids the edit address
	// needs; the item itself has them.
	var item DriveItem
	if err := d.do(ctx, ts, http.MethodGet, itemPath(ref.ParentReference.DriveID, ref.ID)+"?$select="+driveItemSelect, nil, &item); err != nil {
		return nil, err
	}
	return &item, nil
}

// EncodeShareURL turns a link into the share id Graph's /shares endpoint
// takes: "u!" and the URL in unpadded base64url.
func EncodeShareURL(link string) string {
	return "u!" + base64.RawURLEncoding.EncodeToString([]byte(link))
}

// Grantee is a person who holds a permission on an item.
type Grantee struct {
	ID    string // directory object id
	Email string
}

type permission struct {
	ID          string `json:"id"`
	GrantedToV2 *struct {
		User *struct {
			ID    string `json:"id"`
			Email string `json:"email"`
		} `json:"user,omitempty"`
	} `json:"grantedToV2,omitempty"`
}

// Grantees lists the people who already hold a permission of their own on
// the item, inherited or not (people with access through a group or a link
// aren't listed).
func (d *Delegated) Grantees(ctx context.Context, ts oauth2.TokenSource, driveID, itemID string) ([]Grantee, error) {
	var res struct {
		Value []permission `json:"value"`
	}
	if err := d.do(ctx, ts, http.MethodGet, itemPath(driveID, itemID)+"/permissions", nil, &res); err != nil {
		return nil, err
	}
	var out []Grantee
	for _, p := range res.Value {
		if p.GrantedToV2 != nil && p.GrantedToV2.User != nil {
			out = append(out, Grantee{ID: p.GrantedToV2.User.ID, Email: p.GrantedToV2.User.Email})
		}
	}
	return out, nil
}

// Invite gives one person (by directory object id) edit access to the item,
// without emailing them, and returns the permission it created so that
// exactly this permission can be taken back later.
func (d *Delegated) Invite(ctx context.Context, ts oauth2.TokenSource, driveID, itemID, objectID string) (string, error) {
	payload := map[string]any{
		"recipients":     []map[string]string{{"objectId": objectID}},
		"requireSignIn":  true,
		"sendInvitation": false,
		"roles":          []string{"write"},
	}
	var res struct {
		Value []permission `json:"value"`
	}
	if err := d.do(ctx, ts, http.MethodPost, itemPath(driveID, itemID)+"/invite", payload, &res); err != nil {
		return "", err
	}
	if len(res.Value) == 0 || res.Value[0].ID == "" {
		return "", errors.New("msgraph: invite returned no permission")
	}
	return res.Value[0].ID, nil
}

// DeletePermission takes back one permission on the item. A permission that
// is already gone is not an error.
func (d *Delegated) DeletePermission(ctx context.Context, ts oauth2.TokenSource, driveID, itemID, permissionID string) error {
	err := d.do(ctx, ts, http.MethodDelete, itemPath(driveID, itemID)+"/permissions/"+url.PathEscape(permissionID), nil, nil)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}

// Preview returns a short-lived address that shows the item as it is
// (Office for the web's viewer for Office files), embeddable in a frame. It
// carries the user's own access — whoever opens it acts as them — so it is
// for that user's eyes only. ErrNotFound when the item has no such preview.
func (d *Delegated) Preview(ctx context.Context, ts oauth2.TokenSource, driveID, itemID string) (*url.URL, error) {
	var res struct {
		GetURL string `json:"getUrl"`
	}
	if err := d.do(ctx, ts, http.MethodPost, itemPath(driveID, itemID)+"/preview", map[string]any{}, &res); err != nil {
		return nil, err
	}
	u, err := url.Parse(res.GetURL)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return nil, ErrNotFound
	}
	// nb=true drops the viewer's banner. Appended, so the rest of the
	// address (its token) stays exactly as Graph wrote it.
	if u.RawQuery != "" {
		u.RawQuery += "&"
	}
	u.RawQuery += "nb=true"
	return u, nil
}

func itemPath(driveID, itemID string) string {
	return "/drives/" + url.PathEscape(driveID) + "/items/" + url.PathEscape(itemID)
}

// signInCodes are the token-endpoint refusals that only signing in again
// fixes.
var signInCodes = map[string]bool{
	"invalid_grant": true, "interaction_required": true, "consent_required": true, "login_required": true,
}

func (d *Delegated) do(ctx context.Context, ts oauth2.TokenSource, method, path string, payload, dest any) error {
	tok, err := ts.Token()
	if err != nil {
		// Like the app-only token, reduce a refusal to its status and code:
		// the RetrieveError's own message embeds the raw response body.
		if re, ok := errors.AsType[*oauth2.RetrieveError](err); ok {
			if signInCodes[re.ErrorCode] {
				return fmt.Errorf("msgraph: token refused (code %s): %w", re.ErrorCode, ErrSignInRequired)
			}
			return fmt.Errorf("msgraph: token request failed with status %d (code %s)", re.Response.StatusCode, re.ErrorCode)
		}
		return fmt.Errorf("msgraph: delegated token: %w", err)
	}
	return call(ctx, d.client, d.baseURL+path, tok.AccessToken, method, payload, dest)
}
