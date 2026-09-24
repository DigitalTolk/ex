// Package connectordocs is the server-side twin of the desktop runner's
// connector_lookup (ex-electron src/runner/connector-docs.ts): instead of the
// model discovering an endpoint by reading whole doc files turn after turn
// (_USAGE.md, grep _catalog.tsv, the service YAML, _enums.yaml — each one a
// full tool result carried in context), one lookup does that walk in-process
// and hands back only the matching catalog rows, the chosen endpoint's
// contract block, and the enum values it references. Docs arrive as in-memory
// files (the run surface), not a directory — that is the one divergence.
package connectordocs

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// File is one connector doc file as the run surface holds it.
type File struct {
	Name    string
	Content string
}

// Caps keep one lookup result well inside what a single turn should carry:
// the point is to REPLACE several reads, not to dump a service file whole.
const (
	maxRows       = 20
	maxBlockLines = 160
	maxBlockChars = 9000
	maxEnums      = 8
	maxEnumLines  = 40
)

type catalogRow struct {
	routeID     string
	methodPath  string
	sideEffects string
	audience    string
	summary     string
	raw         string
}

// parseCatalog reads the provider-generated _catalog.tsv. Columns: route_id,
// "METHOD path", side_effects, audience, summary, keywords.
func parseCatalog(tsv string) []catalogRow {
	var rows []catalogRow
	for _, line := range strings.Split(tsv, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		cols := strings.Split(line, "\t")
		if len(cols) < 2 {
			continue
		}
		col := func(i int) string {
			if i < len(cols) {
				return strings.TrimSpace(cols[i])
			}
			return ""
		}
		rows = append(rows, catalogRow{
			routeID: col(0), methodPath: col(1), sideEffects: col(2),
			audience: col(3), summary: col(4), raw: line,
		})
	}
	return rows
}

var wordSplit = regexp.MustCompile(`[^a-z0-9_:/-]+`)

// searchCatalog ranks rows by how many query words hit the whole line (the
// same visibility a `grep -i` had), optionally scoped to a route prefix
// ("one_on_ones" matches one_on_ones.*). audience: internal endpoints are
// machine-to-machine and never offered.
func searchCatalog(rows []catalogRow, query, service string) []catalogRow {
	var words []string
	for _, w := range wordSplit.Split(strings.ToLower(query), -1) {
		if w = strings.TrimSpace(w); len(w) >= 2 {
			words = append(words, w)
		}
	}
	if len(words) == 0 {
		return nil
	}
	prefix := ""
	if s := strings.ToLower(strings.TrimSpace(service)); s != "" {
		prefix = strings.TrimSuffix(strings.TrimSuffix(s, ".*"), ".") + "."
	}
	type scored struct {
		row         catalogRow
		hits, bonus int
	}
	var hits []scored
	for _, row := range rows {
		if strings.EqualFold(row.audience, "internal") {
			continue
		}
		if prefix != "" && !strings.HasPrefix(strings.ToLower(row.routeID), prefix) {
			continue
		}
		hay := strings.ToLower(row.raw)
		s := scored{row: row}
		for _, w := range words {
			if !strings.Contains(hay, w) {
				continue
			}
			s.hits++
			if strings.Contains(strings.ToLower(row.routeID), w) || strings.Contains(strings.ToLower(row.summary), w) {
				s.bonus++
			}
		}
		if s.hits > 0 {
			hits = append(hits, s)
		}
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].hits != hits[j].hits {
			return hits[i].hits > hits[j].hits
		}
		if hits[i].bonus != hits[j].bonus {
			return hits[i].bonus > hits[j].bonus
		}
		return hits[i].row.routeID < hits[j].row.routeID
	})
	// Relevance cutoff: when some rows match two or more of the words, rows
	// matching just one are noise.
	if len(hits) > 0 && hits[0].hits >= 2 {
		kept := hits[:0]
		for _, s := range hits {
			if s.hits >= 2 {
				kept = append(kept, s)
			}
		}
		hits = kept
	}
	if len(hits) > maxRows {
		hits = hits[:maxRows]
	}
	out := make([]catalogRow, len(hits))
	for i, s := range hits {
		out[i] = s.row
	}
	return out
}

type endpointBlock struct {
	file      string
	line      int // 1-based line of the `- id:` marker
	text      string
	truncated bool
}

var yamlName = regexp.MustCompile(`(?i)\.ya?ml$`)
var topLevel = regexp.MustCompile(`^\S`)
var separator = regexp.MustCompile(`^\s*#\s*-{5,}\s*$`)
var siblingID = regexp.MustCompile(`^(\s*)-\s*id:\s*\S`)

// findEndpointBlock locates `- id: <routeID>` in the service YAMLs and
// returns that endpoint's block: from the marker down to the next sibling
// `- id:` (same or shallower indent), a top-level key, or the cap. Comment
// separator lines between endpoints are dropped.
func findEndpointBlock(files []File, routeID string) *endpointBlock {
	var names []string
	byName := map[string]string{}
	for _, f := range files {
		if !yamlName.MatchString(f.Name) || f.Name == "_enums.yaml" || f.Name == "index.yml" {
			continue
		}
		names = append(names, f.Name)
		byName[f.Name] = f.Content
	}
	sort.Strings(names)
	marker := regexp.MustCompile(`^(\s*)-\s*id:\s*['"]?` + regexp.QuoteMeta(routeID) + `['"]?\s*$`)
	for _, name := range names {
		lines := strings.Split(byName[name], "\n")
		for i, line := range lines {
			m := marker.FindStringSubmatch(line)
			if m == nil {
				continue
			}
			indent := len(m[1])
			out := []string{line}
			truncated := false
			chars := len(line)
			for j := i + 1; j < len(lines); j++ {
				l := lines[j]
				if sib := siblingID.FindStringSubmatch(l); sib != nil && len(sib[1]) <= indent {
					break
				}
				if indent > 0 && topLevel.MatchString(l) && !strings.HasPrefix(l, "#") {
					break // next top-level key
				}
				if separator.MatchString(l) {
					continue // "# -----" separators
				}
				if len(out) >= maxBlockLines || chars+len(l) > maxBlockChars {
					truncated = true
					break
				}
				out = append(out, l)
				chars += len(l) + 1
			}
			for len(out) > 1 && strings.TrimSpace(out[len(out)-1]) == "" {
				out = out[:len(out)-1]
			}
			return &endpointBlock{file: name, line: i + 1, text: strings.Join(out, "\n"), truncated: truncated}
		}
	}
	return nil
}

var enumRef = regexp.MustCompile(`enum:([A-Za-z0-9_.-]+)`)

// enumRefs lists the `enum:<name>` references a block carries, in order of
// first appearance, deduplicated and capped.
func enumRefs(block string) []string {
	seen := map[string]bool{}
	var out []string
	for _, m := range enumRef.FindAllStringSubmatch(block, -1) {
		if seen[m[1]] {
			continue
		}
		seen[m[1]] = true
		out = append(out, m[1])
		if len(out) >= maxEnums {
			break
		}
	}
	return out
}

// enumBlock extracts one top-level `<name>:` mapping from _enums.yaml text —
// its values plus the notes the KB author left. Capped per enum.
func enumBlock(enumsYaml, name string) string {
	lines := strings.Split(enumsYaml, "\n")
	start := regexp.MustCompile(`^` + regexp.QuoteMeta(name) + `:\s*$`)
	for i, line := range lines {
		if !start.MatchString(line) {
			continue
		}
		out := []string{line}
		for j := i + 1; j < len(lines) && len(out) < maxEnumLines; j++ {
			if topLevel.MatchString(lines[j]) {
				break
			}
			out = append(out, lines[j])
		}
		for len(out) > 1 && strings.TrimSpace(out[len(out)-1]) == "" {
			out = out[:len(out)-1]
		}
		return strings.Join(out, "\n")
	}
	return ""
}

func fileContent(files []File, name string) (string, bool) {
	for _, f := range files {
		if f.Name == name {
			return f.Content, true
		}
	}
	return "", false
}

// Lookup renders the connector_lookup result: matching rows for a query, the
// contract block (plus referenced enums) for a route id — or for a query that
// matches exactly one endpoint, both at once. isError follows the tool-result
// convention: true only when the input itself cannot be served.
func Lookup(files []File, slug, query, routeID, service string) (text string, isError bool) {
	query, routeID = strings.TrimSpace(query), strings.TrimSpace(routeID)
	if query == "" && routeID == "" {
		return "connector_lookup needs query (words from the question) and/or route_id", true
	}
	catalog, ok := fileContent(files, "_catalog.tsv")
	if !ok {
		return "no catalog found for " + slug + " — call use_connector first", true
	}
	rows := parseCatalog(catalog)
	var parts []string

	if query != "" {
		hits := searchCatalog(rows, query, service)
		if len(hits) == 0 {
			scope, drop := "", ""
			if service != "" {
				scope, drop = " in service "+service, ", or drop the service scope"
			}
			parts = append(parts, fmt.Sprintf("no %s endpoints match %q%s. Try fewer or different words%s.", slug, query, scope, drop))
		} else {
			parts = append(parts, fmt.Sprintf("%d %s endpoint(s) match %q (route_id | METHOD path | side_effects | summary):", len(hits), slug, query))
			for _, h := range hits {
				parts = append(parts, h.routeID+" | "+h.methodPath+" | "+h.sideEffects+" | "+h.summary)
			}
			if routeID == "" && len(hits) == 1 {
				routeID = hits[0].routeID
			} else if routeID == "" {
				parts = append(parts, "Pick the one whose SCOPE matches the question and call connector_lookup again with its route_id for the contract.")
			}
		}
	}

	if routeID != "" {
		var row *catalogRow
		for i := range rows {
			if rows[i].routeID == routeID {
				row = &rows[i]
				break
			}
		}
		if row != nil && strings.EqualFold(row.audience, "internal") {
			parts = append(parts, routeID+" is audience: internal (machine-to-machine) — never call it; pick a user-facing endpoint.")
			return strings.Join(parts, "\n"), false
		}
		block := findEndpointBlock(files, routeID)
		if block == nil {
			note := ""
			if row == nil {
				note = " (not in the catalog either — check the spelling)"
			}
			parts = append(parts, fmt.Sprintf("no contract block found for route_id %q%s", routeID, note))
			return strings.Join(parts, "\n"), row == nil
		}
		parts = append(parts, "", fmt.Sprintf("--- contract: %s (%s:%d) ---", routeID, block.file, block.line), block.text)
		if block.truncated {
			parts = append(parts, fmt.Sprintf("… (block truncated at %d lines; read the rest with connector_doc file %q)", maxBlockLines, block.file))
		}
		if refs := enumRefs(block.text); len(refs) > 0 {
			enums, _ := fileContent(files, "_enums.yaml")
			var found, missing []string
			for _, name := range refs {
				if b := enumBlock(enums, name); b != "" {
					found = append(found, b)
				} else {
					missing = append(missing, name)
				}
			}
			if len(found) > 0 {
				parts = append(parts, "", "--- enums referenced (the ONLY valid values) ---")
				parts = append(parts, found...)
			}
			if len(missing) > 0 {
				parts = append(parts, "(enum(s) not found in _enums.yaml: "+strings.Join(missing, ", ")+")")
			}
		}
		parts = append(parts, "", "Compose ONE complete connector_call from this contract: every constraint in the question → a documented filter above.")
	}
	return strings.Join(parts, "\n"), false
}
