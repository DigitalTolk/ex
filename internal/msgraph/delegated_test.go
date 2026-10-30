package msgraph

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"golang.org/x/oauth2"
)

func staticToken(tok string) oauth2.TokenSource {
	return oauth2.StaticTokenSource(&oauth2.Token{AccessToken: tok})
}

type failingTokens struct{ err error }

func (f failingTokens) Token() (*oauth2.Token, error) { return nil, f.err }

func newDelegated(t *testing.T, h http.HandlerFunc) *Delegated {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	d, err := NewDelegated(srv.URL+"/", nil)
	if err != nil {
		t.Fatalf("NewDelegated: %v", err)
	}
	return d
}

func TestNewDelegated(t *testing.T) {
	d, err := NewDelegated("", nil)
	if err != nil || d.baseURL != defaultBaseURL || d.client == nil {
		t.Fatalf("defaults: %+v, %v", d, err)
	}
	if _, err := NewDelegated("not a url", nil); err == nil {
		t.Fatal("want an invalid base URL refused")
	}
	hc := &http.Client{}
	if d, _ := NewDelegated("https://graph.example.com/v1.0/", hc); d.client != hc || d.baseURL != "https://graph.example.com/v1.0" {
		t.Fatalf("custom: %+v", d)
	}
}

func TestEncodeShareURL(t *testing.T) {
	got := EncodeShareURL("https://contoso.sharepoint.com/:w:/s/team/Eabc?e=1")
	if !strings.HasPrefix(got, "u!") || strings.ContainsAny(got, "=+/") {
		t.Fatalf("share id %q is not unpadded base64url", got)
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(got, "u!"))
	if err != nil || string(raw) != "https://contoso.sharepoint.com/:w:/s/team/Eabc?e=1" {
		t.Fatalf("decoded %q, %v", raw, err)
	}
}

func TestResolveLink(t *testing.T) {
	link := "https://contoso.sharepoint.com/:w:/s/team/Eabc"
	d := newDelegated(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer user-tok" {
			t.Errorf("auth header %q", r.Header.Get("Authorization"))
		}
		switch r.URL.Path {
		case "/shares/" + EncodeShareURL(link) + "/driveItem":
			_, _ = w.Write([]byte(`{"id":"item-1","parentReference":{"driveId":"drive-1"}}`))
		case "/drives/drive-1/items/item-1":
			if r.URL.Query().Get("$select") != driveItemSelect {
				t.Errorf("select %q", r.URL.Query().Get("$select"))
			}
			_, _ = w.Write([]byte(`{"id":"item-1","name":"Plan.docx","size":42,"webUrl":"https://contoso.sharepoint.com/sites/team/Plan.docx",
				"file":{"mimeType":"application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
				"parentReference":{"driveId":"drive-1"},
				"sharepointIds":{"listItemUniqueId":"abc-123","siteUrl":"https://contoso.sharepoint.com/sites/team/"}}`))
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(http.StatusTeapot)
		}
	})
	item, err := d.ResolveLink(context.Background(), staticToken("user-tok"), link)
	if err != nil {
		t.Fatalf("ResolveLink: %v", err)
	}
	if item.Name != "Plan.docx" || item.Size != 42 || item.ParentReference.DriveID != "drive-1" || item.File == nil {
		t.Fatalf("item %+v", item)
	}
	if want := "https://contoso.sharepoint.com/sites/team/_layouts/15/Doc.aspx?action=edit&sourcedoc=%7Babc-123%7D"; item.EditURL() != want {
		t.Fatalf("EditURL = %q, want %q", item.EditURL(), want)
	}
	if want := "https://contoso.sharepoint.com/sites/team/_layouts/15/download.aspx?UniqueId=abc-123"; item.DownloadURL() != want {
		t.Fatalf("DownloadURL = %q, want %q", item.DownloadURL(), want)
	}
}

func TestResolveLinkErrors(t *testing.T) {
	t.Run("share not visible", func(t *testing.T) {
		d := newDelegated(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) })
		if _, err := d.ResolveLink(context.Background(), staticToken("t"), "https://x"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})
	t.Run("item read fails", func(t *testing.T) {
		d := newDelegated(t, func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/shares/") {
				_, _ = w.Write([]byte(`{"id":"i","parentReference":{"driveId":"d"}}`))
				return
			}
			w.WriteHeader(http.StatusForbidden)
		})
		if _, err := d.ResolveLink(context.Background(), staticToken("t"), "https://x"); !errors.Is(err, ErrForbidden) {
			t.Fatalf("err = %v, want ErrForbidden", err)
		}
	})
}

func TestEditURLOnlyForOfficeFiles(t *testing.T) {
	ids := &struct {
		ListItemUniqueID string `json:"listItemUniqueId"`
		SiteURL          string `json:"siteUrl"`
	}{ListItemUniqueID: "u", SiteURL: "https://contoso.sharepoint.com/sites/a"}
	file := &struct {
		MimeType string `json:"mimeType"`
	}{}
	for _, tc := range []struct {
		name string
		item DriveItem
		want bool
	}{
		{"office file", DriveItem{Name: "Budget.XLSX", File: file, SharePointIDs: ids}, true},
		{"pdf", DriveItem{Name: "Scan.pdf", File: file, SharePointIDs: ids}, false},
		{"folder", DriveItem{Name: "Reports.docx", SharePointIDs: ids}, false},
		{"no sharepoint ids", DriveItem{Name: "a.docx", File: file}, false},
		{"empty unique id", DriveItem{Name: "a.docx", File: file, SharePointIDs: &struct {
			ListItemUniqueID string `json:"listItemUniqueId"`
			SiteURL          string `json:"siteUrl"`
		}{SiteURL: "https://x"}}, false},
	} {
		if got := tc.item.EditURL() != ""; got != tc.want {
			t.Errorf("%s: edit URL %q", tc.name, tc.item.EditURL())
		}
		// Every file downloads; a folder, or an item without ids, doesn't.
		if got, want := tc.item.DownloadURL() != "", tc.item.File != nil && tc.item.SharePointIDs != nil && tc.item.SharePointIDs.ListItemUniqueID != ""; got != want {
			t.Errorf("%s: download URL %q", tc.name, tc.item.DownloadURL())
		}
	}
}

func TestGrantees(t *testing.T) {
	d := newDelegated(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.EscapedPath() != "/drives/d%201/items/i/permissions" {
			t.Errorf("path %s", r.URL.EscapedPath())
		}
		_, _ = w.Write([]byte(`{"value":[
			{"id":"p1","grantedToV2":{"user":{"id":"oid-1","email":"a@example.com"}}},
			{"id":"p2","grantedToV2":{"siteGroup":{"id":"5"}}},
			{"id":"p3","link":{"type":"view"}}
		]}`))
	})
	got, err := d.Grantees(context.Background(), staticToken("t"), "d 1", "i")
	if err != nil {
		t.Fatalf("Grantees: %v", err)
	}
	if len(got) != 1 || got[0] != (Grantee{ID: "oid-1", Email: "a@example.com"}) {
		t.Fatalf("grantees %+v", got)
	}

	failing := newDelegated(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusUnauthorized) })
	if _, err := failing.Grantees(context.Background(), staticToken("t"), "d", "i"); !errors.Is(err, ErrSignInRequired) {
		t.Fatalf("err = %v, want ErrSignInRequired", err)
	}
}

func TestInvite(t *testing.T) {
	d := newDelegated(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/drives/d/items/i/invite" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		var got map[string]any
		_ = json.Unmarshal(body, &got)
		if got["sendInvitation"] != false || got["requireSignIn"] != true {
			t.Errorf("invite body %s", body)
		}
		if roles := got["roles"].([]any); len(roles) != 1 || roles[0] != "write" {
			t.Errorf("roles %v", roles)
		}
		if rec := got["recipients"].([]any)[0].(map[string]any); rec["objectId"] != "oid-7" {
			t.Errorf("recipient %v", rec)
		}
		_, _ = w.Write([]byte(`{"value":[{"id":"perm-7"}]}`))
	})
	id, err := d.Invite(context.Background(), staticToken("t"), "d", "i", "oid-7")
	if err != nil || id != "perm-7" {
		t.Fatalf("Invite = %q, %v", id, err)
	}
}

func TestInviteErrors(t *testing.T) {
	empty := newDelegated(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"value":[]}`)) })
	if _, err := empty.Invite(context.Background(), staticToken("t"), "d", "i", "o"); err == nil || !strings.Contains(err.Error(), "no permission") {
		t.Fatalf("err = %v, want no-permission error", err)
	}
	denied := newDelegated(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"code":"accessDenied"}}`))
	})
	_, err := denied.Invite(context.Background(), staticToken("t"), "d", "i", "o")
	if !errors.Is(err, ErrForbidden) || !strings.Contains(err.Error(), "accessDenied") {
		t.Fatalf("err = %v, want ErrForbidden with its code", err)
	}
}

func TestDeletePermission(t *testing.T) {
	var gone bool
	d := newDelegated(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/drives/d/items/i/permissions/p" {
			t.Errorf("%s %s", r.Method, r.URL.Path)
		}
		if gone {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	if err := d.DeletePermission(context.Background(), staticToken("t"), "d", "i", "p"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	gone = true
	if err := d.DeletePermission(context.Background(), staticToken("t"), "d", "i", "p"); err != nil {
		t.Fatalf("delete of a permission already gone: %v", err)
	}
	failing := newDelegated(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusInternalServerError) })
	if err := failing.DeletePermission(context.Background(), staticToken("t"), "d", "i", "p"); err == nil {
		t.Fatal("want a server error surfaced")
	}
}

func TestPreview(t *testing.T) {
	getURL := "https://contoso.sharepoint.com/sites/team/_layouts/15/embed.aspx?UniqueId=u-1&embed=%7B%22af%22%3Atrue%7D&token=a%2Bb"
	d := newDelegated(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/drives/d/items/i/preview" || r.Header.Get("Authorization") != "Bearer t" {
			t.Errorf("%s %s (%s)", r.Method, r.URL.Path, r.Header.Get("Authorization"))
		}
		if body, _ := io.ReadAll(r.Body); string(body) != "{}" {
			t.Errorf("body = %s", body)
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"getUrl": getURL, "postUrl": "https://contoso.sharepoint.com/post"})
	})
	u, err := d.Preview(context.Background(), staticToken("t"), "d", "i")
	// The address stays exactly as Graph wrote it, with the banner dropped.
	if err != nil || u.String() != getURL+"&nb=true" {
		t.Fatalf("preview = %v, %v", u, err)
	}

	for _, body := range []string{`{"postUrl":"https://contoso.sharepoint.com/post"}`, `{"getUrl":"http://contoso.sharepoint.com/x"}`, `{"getUrl":"https://"}`, `{"getUrl":"%zz"}`} {
		d := newDelegated(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, body) })
		if _, err := d.Preview(context.Background(), staticToken("t"), "d", "i"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s: err = %v, want ErrNotFound", body, err)
		}
	}
	bare := newDelegated(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"getUrl":"https://contoso.sharepoint.com/embed"}`)
	})
	if u, err := bare.Preview(context.Background(), staticToken("t"), "d", "i"); err != nil || u.String() != "https://contoso.sharepoint.com/embed?nb=true" {
		t.Fatalf("preview = %v, %v", u, err)
	}
	failing := newDelegated(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusForbidden) })
	if _, err := failing.Preview(context.Background(), staticToken("t"), "d", "i"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}
}

func TestDelegatedTokenErrors(t *testing.T) {
	d := newDelegated(t, func(http.ResponseWriter, *http.Request) { t.Error("no request without a token") })
	refused := &oauth2.RetrieveError{Response: &http.Response{StatusCode: 400}, ErrorCode: "invalid_grant", Body: []byte("secret body")}
	_, err := d.ResolveLink(context.Background(), failingTokens{refused}, "https://x")
	if !errors.Is(err, ErrSignInRequired) || strings.Contains(err.Error(), "secret body") {
		t.Fatalf("refused refresh: err = %v, want ErrSignInRequired without the body", err)
	}
	outage := &oauth2.RetrieveError{Response: &http.Response{StatusCode: 503}, ErrorCode: "temporarily_unavailable", Body: []byte("secret body")}
	_, err = d.ResolveLink(context.Background(), failingTokens{outage}, "https://x")
	if err == nil || errors.Is(err, ErrSignInRequired) || strings.Contains(err.Error(), "secret body") || !strings.Contains(err.Error(), "status 503") {
		t.Fatalf("token outage: err = %v", err)
	}
	_, err = d.ResolveLink(context.Background(), failingTokens{errors.New("dial")}, "https://x")
	if err == nil || !strings.Contains(err.Error(), "delegated token: dial") {
		t.Fatalf("network: err = %v", err)
	}
}

func TestStatusErrorKinds(t *testing.T) {
	if !errors.Is(&StatusError{Status: 401}, ErrSignInRequired) || errors.Is(&StatusError{Status: 401}, ErrForbidden) {
		t.Error("401 is sign-in required only")
	}
	if !errors.Is(&StatusError{Status: 403}, ErrForbidden) || errors.Is(&StatusError{Status: 403}, ErrSignInRequired) {
		t.Error("403 is forbidden only")
	}
	if errors.Is(&StatusError{Status: 500}, ErrForbidden) || errors.Is(&StatusError{Status: 500}, ErrNotFound) {
		t.Error("500 is neither")
	}
	if got := (&StatusError{Status: 500}).Error(); got != "msgraph: request failed with status 500" {
		t.Errorf("message %q", got)
	}
}
