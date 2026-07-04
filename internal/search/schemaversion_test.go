package search

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStampSchemaMeta_InjectsValidMeta(t *testing.T) {
	for _, name := range []string{IndexUsers, IndexChannels} {
		body := indexMappings[name]
		stamped, err := stampSchemaMeta(body, 7)
		if err != nil {
			t.Fatalf("%s: stampSchemaMeta error: %v", name, err)
		}
		if !json.Valid([]byte(stamped)) {
			t.Fatalf("%s: stamped body is not valid JSON:\n%s", name, stamped)
		}
		// The stamp round-trips through a real decode at the mappings._meta path.
		var doc struct {
			Mappings struct {
				Meta struct {
					SchemaVersion int `json:"schemaVersion"`
				} `json:"_meta"`
			} `json:"mappings"`
		}
		if err := json.Unmarshal([]byte(stamped), &doc); err != nil {
			t.Fatalf("%s: unmarshal stamped: %v", name, err)
		}
		if doc.Mappings.Meta.SchemaVersion != 7 {
			t.Fatalf("%s: schemaVersion = %d, want 7", name, doc.Mappings.Meta.SchemaVersion)
		}
	}
}

func TestStampSchemaMeta_ErrorOnMissingMarker(t *testing.T) {
	if _, err := stampSchemaMeta(`{"settings":{}}`, 1); err == nil {
		t.Fatal("expected an error when the body has no mappings object")
	}
}

// EnsureIndices must create UNSTAMPED bodies so a brand-new empty index reads as
// stale and gets auto-populated on first boot — guard against a stray _meta
// creeping into the raw mapping constants.
func TestIndexMappings_RawBodiesAreUnstamped(t *testing.T) {
	for name, body := range indexMappings {
		if strings.Contains(body, "_meta") {
			t.Errorf("indexMappings[%q] must not carry _meta; the stamp is added at promote time", name)
		}
		if !json.Valid([]byte(body)) {
			t.Errorf("indexMappings[%q] is not valid JSON", name)
		}
	}
}

// Every versioned index must be a real logical index.
func TestDesiredSchemaVersion_KeysAreKnownIndices(t *testing.T) {
	for name := range desiredSchemaVersion {
		if _, ok := indexMappings[name]; !ok {
			t.Errorf("desiredSchemaVersion has unknown index %q", name)
		}
	}
}

func TestClient_IndexSchemaVersion_NilClient(t *testing.T) {
	var c *Client
	v, present, err := c.IndexSchemaVersion(context.Background(), IndexUsers)
	if v != 0 || present || err != nil {
		t.Fatalf("nil client must yield (0,false,nil), got (%d,%v,%v)", v, present, err)
	}
}

func TestClient_IndexSchemaVersion_ReadsStamp(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/"+IndexUsers+"/_mapping" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		// Keyed by the physical alias-backed index, as OpenSearch returns.
		_, _ = w.Write([]byte(`{"ex_users-r42":{"mappings":{"_meta":{"schemaVersion":3},"properties":{"id":{"type":"keyword"}}}}}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	v, present, err := c.IndexSchemaVersion(context.Background(), IndexUsers)
	if err != nil || !present || v != 3 {
		t.Fatalf("got (%d,%v,%v), want (3,true,nil)", v, present, err)
	}
}

func TestClient_IndexSchemaVersion_NoStamp(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"ex_users":{"mappings":{"properties":{"id":{"type":"keyword"}}}}}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	v, present, err := c.IndexSchemaVersion(context.Background(), IndexUsers)
	if err != nil || present || v != 0 {
		t.Fatalf("an unstamped index must be (0,false,nil), got (%d,%v,%v)", v, present, err)
	}
}

func TestClient_IndexSchemaVersion_NotFoundIsAbsent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	v, present, err := c.IndexSchemaVersion(context.Background(), IndexUsers)
	if err != nil || present || v != 0 {
		t.Fatalf("a missing index must be (0,false,nil), got (%d,%v,%v)", v, present, err)
	}
}

func TestClient_IndexSchemaVersion_ErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"boom"}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	if _, _, err := c.IndexSchemaVersion(context.Background(), IndexUsers); err == nil {
		t.Fatal("expected an error for a 5xx mapping read")
	}
}

func TestClient_IndexSchemaVersion_DecodeError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`not json`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	if _, _, err := c.IndexSchemaVersion(context.Background(), IndexUsers); err == nil {
		t.Fatal("expected a decode error for a malformed mapping body")
	}
}

func TestClient_IndexSchemaVersion_TransportError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close() // now unreachable → http.Do fails
	c := NewClient(url)
	if _, _, err := c.IndexSchemaVersion(context.Background(), IndexUsers); err == nil {
		t.Fatal("expected a transport error when the server is down")
	}
}

func TestClient_BeginIndexRebuild_StampsVersionedIndex(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, "/"+IndexUsers+"-r") {
			b, _ := io.ReadAll(r.Body)
			gotBody = string(b)
		}
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	staging, err := c.BeginIndexRebuild(context.Background(), IndexUsers)
	if err != nil {
		t.Fatalf("BeginIndexRebuild: %v", err)
	}
	if !strings.HasPrefix(staging, IndexUsers+"-r") {
		t.Fatalf("staging name = %q", staging)
	}
	if !strings.Contains(gotBody, "_meta") || !strings.Contains(gotBody, "schemaVersion") {
		t.Fatalf("versioned staging index must be stamped; body:\n%s", gotBody)
	}
}

func TestClient_BeginIndexRebuild_LeavesUnversionedIndexUnstamped(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, "/"+IndexMessages+"-r") {
			b, _ := io.ReadAll(r.Body)
			gotBody = string(b)
		}
	}))
	defer srv.Close()
	c := NewClient(srv.URL)
	if _, err := c.BeginIndexRebuild(context.Background(), IndexMessages); err != nil {
		t.Fatalf("BeginIndexRebuild: %v", err)
	}
	if strings.Contains(gotBody, "_meta") {
		t.Fatalf("a non-versioned index must not be stamped; body:\n%s", gotBody)
	}
}
