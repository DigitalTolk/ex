package msgraph

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"golang.org/x/oauth2"
)

// Graph takes a file in one request up to 4 MiB; a larger one goes through
// an upload session, in chunks that are a multiple of 320 KiB.
const (
	simpleUploadMax = 4 << 20
	uploadChunk     = 16 * 320 << 10 // 5 MiB
)

// Upload puts a file into the user's own OneDrive, at folder/name (folders
// are made as needed), and returns it. A file of that name already there is
// kept: the new one is renamed ("report 1.docx"). body must hold exactly size
// bytes.
func (d *Delegated) Upload(ctx context.Context, ts oauth2.TokenSource, folder []string, name string, body io.Reader, size int64) (*DriveItem, error) {
	token, err := accessToken(ts)
	if err != nil {
		return nil, err
	}
	segments := make([]string, 0, len(folder)+1)
	for _, s := range append(folder, name) {
		segments = append(segments, url.PathEscape(s))
	}
	item := d.baseURL + "/me/drive/root:/" + strings.Join(segments, "/") + ":"
	if size <= simpleUploadMax {
		var out DriveItem
		err := send(ctx, d.client, http.MethodPut, item+"/content?@microsoft.graph.conflictBehavior=rename", token, io.LimitReader(body, size), size, "", &out)
		if err != nil {
			return nil, err
		}
		return &out, nil
	}
	var session struct {
		UploadURL string `json:"uploadUrl"`
	}
	payload := map[string]any{"item": map[string]string{"@microsoft.graph.conflictBehavior": "rename"}}
	if err := call(ctx, d.client, item+"/createUploadSession", token, http.MethodPost, payload, &session); err != nil {
		return nil, err
	}
	if u, err := url.Parse(session.UploadURL); err != nil || u.Scheme != "https" || u.Host == "" {
		return nil, errors.New("msgraph: upload session without an https address")
	}
	out, err := d.uploadChunks(ctx, session.UploadURL, body, size)
	if err != nil {
		// Let the session go rather than wait out its expiry.
		_ = send(context.WithoutCancel(ctx), d.client, http.MethodDelete, session.UploadURL, "", nil, 0, "", nil)
		return nil, err
	}
	return out, nil
}

// uploadChunks sends body to an upload session, a chunk at a time. Graph
// answers each chunk but the last with 202; the last with the new item. The
// session's address is its own credential: no token goes with it.
func (d *Delegated) uploadChunks(ctx context.Context, sessionURL string, body io.Reader, size int64) (*DriveItem, error) {
	buf := make([]byte, uploadChunk)
	var start int64
	for {
		n := min(int64(uploadChunk), size-start)
		if _, err := io.ReadFull(body, buf[:n]); err != nil {
			return nil, fmt.Errorf("msgraph: read upload: %w", err)
		}
		rng := fmt.Sprintf("bytes %d-%d/%d", start, start+n-1, size)
		start += n
		var out *DriveItem
		var dest any
		if start == size {
			out = &DriveItem{}
			dest = out
		}
		if err := send(ctx, d.client, http.MethodPut, sessionURL, "", bytes.NewReader(buf[:n]), n, rng, dest); err != nil {
			return nil, err
		}
		if out != nil {
			return out, nil
		}
	}
}

// send is call for a raw body: the bytes of a file, sized up front.
// contentRange, when set, places the body within an upload session.
func send(ctx context.Context, client *http.Client, method, rawURL, token string, body io.Reader, size int64, contentRange string, dest any) error {
	req := mustRequest(http.NewRequestWithContext(ctx, method, rawURL, body))
	if body != nil {
		req.ContentLength = size
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if contentRange != "" {
		req.Header.Set("Content-Range", contentRange)
	}
	req.Header.Set("Accept", "application/json")
	return respond(client, req, dest)
}
