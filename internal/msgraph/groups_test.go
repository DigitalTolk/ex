package msgraph

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"testing"
)

func TestListMemberGroups(t *testing.T) {
	var base string
	c := graphServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/groups/parent-1/members/microsoft.graph.group" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.URL.Query().Get("$skiptoken") == "" {
			if got := r.URL.Query().Get("$select"); got != "id,displayName,description" {
				t.Errorf("$select = %q", got)
			}
			writeJSONBody(w, map[string]any{
				"value":           []map[string]any{{"id": "g-1", "displayName": "eng", "description": "Engineering department"}},
				"@odata.nextLink": base + "/groups/parent-1/members/microsoft.graph.group?$top=999&$skiptoken=p2",
			})
			return
		}
		writeJSONBody(w, map[string]any{"value": []map[string]any{{"id": "g-2", "displayName": "eng-dope"}}})
	})
	base = c.baseURL
	groups, err := c.ListMemberGroups(context.Background(), "parent-1")
	if err != nil {
		t.Fatal(err)
	}
	want := []Group{{ID: "g-1", DisplayName: "eng", Description: "Engineering department"}, {ID: "g-2", DisplayName: "eng-dope"}}
	if !slices.Equal(groups, want) {
		t.Fatalf("groups = %+v, want %+v (both pages)", groups, want)
	}
}

func TestListMemberGroupsMissingParent(t *testing.T) {
	c := graphServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	if _, err := c.ListMemberGroups(context.Background(), "gone"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestListMemberUserIDs(t *testing.T) {
	c := graphServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/groups/g-1/members/microsoft.graph.user" || r.URL.Query().Get("$select") != "id" {
			t.Errorf("request = %s", r.URL)
		}
		writeJSONBody(w, map[string]any{"value": []map[string]any{{"id": "oid-1"}, {"id": "oid-2"}}})
	})
	ids, err := c.ListMemberUserIDs(context.Background(), "g-1")
	if err != nil || !slices.Equal(ids, []string{"oid-1", "oid-2"}) {
		t.Fatalf("ids = %v, %v", ids, err)
	}
}

func TestListPagesErrors(t *testing.T) {
	c := graphServer(t, func(w http.ResponseWriter, _ *http.Request) {
		writeJSONBody(w, map[string]any{"value": []any{}, "@odata.nextLink": "https://elsewhere.example.com/next"})
	})
	if _, err := c.ListMemberUserIDs(context.Background(), "g-1"); err == nil {
		t.Fatal("a next link outside the Graph base URL was followed")
	}
	failing := graphServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	})
	if _, err := failing.ListMemberUserIDs(context.Background(), "g-1"); err == nil {
		t.Fatal("a 403 was not reported")
	}
}
