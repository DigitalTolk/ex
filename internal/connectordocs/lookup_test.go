package connectordocs

import (
	"fmt"
	"strings"
	"testing"
)

// A small catalog mirroring the provider's shape: route_id, "METHOD path",
// side_effects, audience, summary, keywords.
const catalog = "meetings.upcoming\tGET /api/meetings/upcoming\tnone\tuser\tList upcoming meetings\tmeetings calendar upcoming\n" +
	"meetings.create\tPOST /api/meetings\twrites\tuser\tCreate a meeting\tmeetings new\n" +
	"one_on_ones.index\tGET /api/one-on-ones\tnone\tuser\tList one on ones\tmeetings people\n" +
	"sync.push\tPOST /api/sync\twrites\tinternal\tInternal sync\tsync\n" +
	"short\n" + // fewer than two columns — skipped
	"\n"

const meetingsYaml = `service: meetings
endpoints:
  - id: meetings.upcoming
    method: GET
    path: /api/meetings/upcoming
    params:
      range: enum:meeting_range
      status: enum:meeting_status
# ----------
  - id: meetings.create
    method: POST
`

const enumsYaml = `meeting_range:
  - today
  - week   # the current ISO week

unused:
  - x
`

func docFiles() []File {
	return []File{
		{Name: "_catalog.tsv", Content: catalog},
		{Name: "_USAGE.md", Content: "usage prose"},
		{Name: "index.yml", Content: "- id: meetings.upcoming"}, // must be ignored
		{Name: "_enums.yaml", Content: enumsYaml},
		{Name: "meetings.yaml", Content: meetingsYaml},
	}
}

func TestLookup_QueryThenRoute(t *testing.T) {
	// Two words → the cutoff keeps only the 2-hit row, and the single match
	// auto-inlines the contract block plus its enums.
	text, isErr := Lookup(docFiles(), "hub", "upcoming meetings", "", "")
	if isErr {
		t.Fatalf("unexpected error: %s", text)
	}
	for _, want := range []string{
		`1 hub endpoint(s) match "upcoming meetings"`,
		"meetings.upcoming | GET /api/meetings/upcoming | none | List upcoming meetings",
		"--- contract: meetings.upcoming (meetings.yaml:3) ---",
		"range: enum:meeting_range",
		"--- enums referenced (the ONLY valid values) ---",
		"week   # the current ISO week",
		"(enum(s) not found in _enums.yaml: meeting_status)",
		"Compose ONE complete connector_call",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in:\n%s", want, text)
		}
	}
	if strings.Contains(text, "# ----------") {
		t.Fatal("separator line must be dropped from the block")
	}
	if strings.Contains(text, "meetings.create\n    method: POST") {
		t.Fatal("block leaked past the next sibling endpoint")
	}
}

func TestLookup_MultipleHitsAskForRouteID(t *testing.T) {
	text, isErr := Lookup(docFiles(), "hub", "meetings", "", "")
	if isErr {
		t.Fatalf("unexpected error: %s", text)
	}
	if !strings.Contains(text, "call connector_lookup again with its route_id") {
		t.Fatalf("multi-hit result must ask for a route_id:\n%s", text)
	}
	if strings.Contains(text, "sync.push") {
		t.Fatal("audience: internal rows must never be offered")
	}
}

func TestLookup_ServiceScope(t *testing.T) {
	text, _ := Lookup(docFiles(), "hub", "meetings", "", "one_on_ones.*")
	if !strings.Contains(text, "one_on_ones.index") || strings.Contains(text, "meetings.upcoming |") {
		t.Fatalf("service scope must restrict to the prefix:\n%s", text)
	}
	// No hits inside a scope names the scope and suggests dropping it.
	text, _ = Lookup(docFiles(), "hub", "zzz", "", "one_on_ones")
	if !strings.Contains(text, "in service one_on_ones") || !strings.Contains(text, "drop the service scope") {
		t.Fatalf("scoped miss message wrong:\n%s", text)
	}
	// Unscoped miss keeps the shorter suggestion.
	text, _ = Lookup(docFiles(), "hub", "zzz", "", "")
	if strings.Contains(text, "drop the service scope") {
		t.Fatalf("unscoped miss must not mention scope:\n%s", text)
	}
}

func TestLookup_RouteDirect(t *testing.T) {
	// Internal routes are refused by audience even when addressed directly.
	text, isErr := Lookup(docFiles(), "hub", "", "sync.push", "")
	if isErr || !strings.Contains(text, "audience: internal") {
		t.Fatalf("internal route must be refused: err=%v %s", isErr, text)
	}
	// Cataloged but no contract block: informative, NOT an error.
	files := append(docFiles(), File{Name: "extra.yml", Content: "nothing"})
	text, isErr = Lookup(files, "hub", "", "meetings.create", "")
	if isErr {
		t.Fatalf("cataloged route without block must not error: %s", text)
	}
	// meetings.create IS in meetings.yaml — use a cataloged id with no block.
	text, isErr = Lookup(files, "hub", "", "one_on_ones.index", "")
	if isErr || !strings.Contains(text, `no contract block found for route_id "one_on_ones.index"`) {
		t.Fatalf("want block-missing note, got err=%v %s", isErr, text)
	}
	// Unknown route: error, with the spelling hint.
	text, isErr = Lookup(docFiles(), "hub", "", "nope.nope", "")
	if !isErr || !strings.Contains(text, "not in the catalog either") {
		t.Fatalf("unknown route must error: err=%v %s", isErr, text)
	}
}

func TestLookup_InputAndCatalogErrors(t *testing.T) {
	if text, isErr := Lookup(docFiles(), "hub", "", "", ""); !isErr || !strings.Contains(text, "needs query") {
		t.Fatalf("empty input must error: %v %s", isErr, text)
	}
	if text, isErr := Lookup([]File{{Name: "_USAGE.md", Content: "x"}}, "hub", "meetings", "", ""); !isErr || !strings.Contains(text, "no catalog found for hub") {
		t.Fatalf("missing catalog must error: %v %s", isErr, text)
	}
}

func TestParseCatalog_ShortRows(t *testing.T) {
	// A row may carry only the leading columns; the rest read as empty.
	rows := parseCatalog("a.b\tGET /x\tnone\n")
	if len(rows) != 1 || rows[0].audience != "" || rows[0].summary != "" {
		t.Fatalf("short row: %+v", rows)
	}
}

func TestSearchCatalog_RankingAndCaps(t *testing.T) {
	rows := parseCatalog(catalog)
	// Single word: no cutoff, ties broken by bonus then route id.
	hits := searchCatalog(rows, "meetings", "")
	if len(hits) < 2 || hits[0].routeID != "meetings.create" && hits[0].routeID != "meetings.upcoming" {
		t.Fatalf("ranking off: %+v", hits)
	}
	// One-char words are dropped entirely.
	if got := searchCatalog(rows, "a b", ""); got != nil {
		t.Fatalf("short words must not match: %+v", got)
	}
	// Row cap: build 25 matching rows, keep 20.
	var big strings.Builder
	for i := 0; i < 25; i++ {
		fmt.Fprintf(&big, "svc.r%02d\tGET /x\tnone\tuser\twidget row\twidget\n", i)
	}
	if got := searchCatalog(parseCatalog(big.String()), "widget", ""); len(got) != maxRows {
		t.Fatalf("cap: got %d rows", len(got))
	}
}

func TestFindEndpointBlock_Boundaries(t *testing.T) {
	// Quoted ids match; the block stops at a shallower/equal-indent sibling.
	files := []File{{Name: "a.yaml", Content: "eps:\n  - id: 'x.y'\n    p: 1\n  - id: z.z\n    q: 2\n"}}
	b := findEndpointBlock(files, "x.y")
	if b == nil || b.line != 2 || strings.Contains(b.text, "z.z") {
		t.Fatalf("quoted/sibling handling: %+v", b)
	}
	// A top-level key ends an indented block.
	files = []File{{Name: "a.yaml", Content: "eps:\n  - id: x.y\n    p: 1\n\ntop: v\n"}}
	if b = findEndpointBlock(files, "x.y"); b == nil || strings.Contains(b.text, "top: v") || strings.HasSuffix(b.text, "\n") {
		t.Fatalf("top-level boundary / blank trim: %+v", b)
	}
	// Line-count truncation.
	long := "eps:\n  - id: x.y\n" + strings.Repeat("    k: v\n", maxBlockLines+5)
	if b = findEndpointBlock([]File{{Name: "a.yaml", Content: long}}, "x.y"); b == nil || !b.truncated {
		t.Fatalf("line cap must truncate: %+v", b)
	}
	// Char-budget truncation, and the lookup rendering of the notice.
	wide := "eps:\n  - id: x.y\n" + strings.Repeat("    k: "+strings.Repeat("v", 400)+"\n", 30)
	if b = findEndpointBlock([]File{{Name: "a.yaml", Content: wide}}, "x.y"); b == nil || !b.truncated {
		t.Fatalf("char cap must truncate: %+v", b)
	}
	files = []File{
		{Name: "_catalog.tsv", Content: "x.y\tGET /x\tnone\tuser\twide\tw\n"},
		{Name: "a.yaml", Content: wide},
	}
	text, _ := Lookup(files, "hub", "", "x.y", "")
	if !strings.Contains(text, "block truncated") || !strings.Contains(text, `connector_doc file "a.yaml"`) {
		t.Fatalf("truncation notice missing:\n%s", text)
	}
	// Marker at zero indent runs to EOF (top-level rule needs indent > 0).
	if b = findEndpointBlock([]File{{Name: "a.yaml", Content: "- id: x.y\n  p: 1\nplain\n"}}, "x.y"); b == nil || !strings.Contains(b.text, "plain") {
		t.Fatalf("zero-indent block: %+v", b)
	}
	if findEndpointBlock([]File{{Name: "notes.md", Content: "- id: x.y"}}, "x.y") != nil {
		t.Fatal("non-yaml files must be ignored")
	}
}

func TestEnumHelpers(t *testing.T) {
	// Dedup and cap.
	var refs strings.Builder
	for i := 0; i < maxEnums+3; i++ {
		fmt.Fprintf(&refs, "a: enum:e%d enum:e%d\n", i, i)
	}
	if got := enumRefs(refs.String()); len(got) != maxEnums || got[0] != "e0" {
		t.Fatalf("enumRefs: %v", got)
	}
	if enumBlock(enumsYaml, "absent") != "" {
		t.Fatal("absent enum must return empty")
	}
	// Line cap on one enum's block.
	long := "big:\n" + strings.Repeat("  - v\n", maxEnumLines+5)
	if got := enumBlock(long, "big"); len(strings.Split(got, "\n")) != maxEnumLines {
		t.Fatalf("enum line cap: %d lines", len(strings.Split(got, "\n")))
	}
}
