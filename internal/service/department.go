package service

import (
	"slices"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// The Microsoft 365 (Entra ID) department field carries a person's department
// and, optionally, their squads: "Department - Squad, Squad". ParseDepartment
// reads it as well as it can and never fails: whatever doesn't match that
// format exactly is still read, and reported as an anomaly.

// DepartmentAnomalyKind names one way a department value differs from the
// agreed format.
type DepartmentAnomalyKind string

const (
	// AnomalyDash: the separator is a dash other than "-" (an en or em dash,
	// a minus sign…), as Word and Outlook type for " - ".
	AnomalyDash DepartmentAnomalyKind = "non-standard-dash"
	// AnomalySpacing: the separator, or a comma between squads, lacks a space.
	AnomalySpacing DepartmentAnomalyKind = "spacing"
	// AnomalySecondSeparator: a second " - " after the first; it stays part of
	// the squad name.
	AnomalySecondSeparator DepartmentAnomalyKind = "second-separator"
	// AnomalyEmptySquad: an empty entry in the squad list (",," or a trailing
	// comma).
	AnomalyEmptySquad DepartmentAnomalyKind = "empty-squad"
	// AnomalyDuplicateSquad: the same squad twice (ignoring case and spacing).
	AnomalyDuplicateSquad DepartmentAnomalyKind = "duplicate-squad"
	// AnomalySemicolon: squads separated by ";" instead of ",".
	AnomalySemicolon DepartmentAnomalyKind = "semicolon"
	// AnomalyEmptySquadList: a separator with nothing after it.
	AnomalyEmptySquadList DepartmentAnomalyKind = "empty-squad-list"
	// AnomalyNoDepartment: nothing before the separator; no groups are read.
	AnomalyNoDepartment DepartmentAnomalyKind = "no-department"
	// AnomalyTooManySquads: more than maxDepartmentSquads squads; the rest are
	// dropped.
	AnomalyTooManySquads DepartmentAnomalyKind = "too-many-squads"
)

// maxDepartmentSquads bounds the squads read from one value (Entra caps the
// field at 64 characters, so this only guards against bad data).
const maxDepartmentSquads = 20

// ParsedDepartment is what one department value says.
type ParsedDepartment struct {
	// Department is "" when the value names none.
	Department string
	Squads     []string
	Anomalies  []DepartmentAnomalyKind
}

// departmentPlaceholders mean "no department".
var departmentPlaceholders = map[string]bool{"-": true, "n/a": true, "na": true, "none": true, "tbd": true, "unknown": true, "?": true}

// departmentDashes are the dashes accepted as the department/squad separator:
// "-" and the look-alikes word processors type for it.
var departmentDashes = map[rune]bool{'-': true, '\u2010': true, '\u2011': true, '\u2012': true, '–': true, '—': true, '\u2212': true}

// invisibleRunes are dropped: zero-width spaces and joiners, word joiner, BOM.
var invisibleRunes = map[rune]bool{'\u200b': true, '\u200c': true, '\u200d': true, '\u2060': true, '\ufeff': true}

// ParseDepartment reads a department value (see the package comment above).
func ParseDepartment(raw string) ParsedDepartment {
	var out ParsedDepartment
	text := normalizeDepartmentText(raw)
	if text == "" || departmentPlaceholders[strings.ToLower(text)] {
		return out
	}
	runes := []rune(text)
	at, dash := findDepartmentSeparator(runes, 0)
	if at < 0 {
		out.Department = text
		return out
	}
	if dash != '-' {
		out.anomaly(AnomalyDash)
	}
	if !spaceAt(runes, at-1) || !spaceAt(runes, at+1) {
		out.anomaly(AnomalySpacing)
	}
	out.Department = strings.TrimSpace(string(runes[:at]))
	if out.Department == "" {
		return ParsedDepartment{Anomalies: []DepartmentAnomalyKind{AnomalyNoDepartment}}
	}
	rest := []rune(strings.TrimSpace(string(runes[at+1:])))
	if len(rest) == 0 {
		out.anomaly(AnomalyEmptySquadList)
		return out
	}
	if next, _ := findDepartmentSeparator(rest, 0); next >= 0 {
		out.anomaly(AnomalySecondSeparator)
	}
	out.Squads = out.splitSquads(rest)
	return out
}

func (p *ParsedDepartment) anomaly(kind DepartmentAnomalyKind) {
	if !slices.Contains(p.Anomalies, kind) {
		p.Anomalies = append(p.Anomalies, kind)
	}
}

// splitSquads splits a squad list on "," (and ";"), dropping empty entries
// and repeats.
func (p *ParsedDepartment) splitSquads(list []rune) []string {
	var squads, seen []string
	start := 0
	for i := 0; i <= len(list); i++ {
		if i < len(list) && list[i] != ',' && list[i] != ';' {
			continue
		}
		if i < len(list) {
			if list[i] == ';' {
				p.anomaly(AnomalySemicolon)
			}
			if i+1 < len(list) && list[i+1] != ' ' {
				p.anomaly(AnomalySpacing)
			}
		}
		squad := strings.TrimSpace(string(list[start:i]))
		start = i + 1
		key := strings.ToLower(squad)
		switch {
		case squad == "":
			p.anomaly(AnomalyEmptySquad)
		case slices.Contains(seen, key):
			p.anomaly(AnomalyDuplicateSquad)
		case len(squads) == maxDepartmentSquads:
			p.anomaly(AnomalyTooManySquads)
		default:
			seen = append(seen, key)
			squads = append(squads, squad)
		}
	}
	return squads
}

// findDepartmentSeparator returns the index of the first dash at or after
// from that has a space (or the start or end of the text) on at least one
// side, and the dash; -1 when there is none. A dash between two letters is
// part of a name ("Back-office").
func findDepartmentSeparator(runes []rune, from int) (int, rune) {
	for i := from; i < len(runes); i++ {
		if departmentDashes[runes[i]] && (i == 0 || i == len(runes)-1 || spaceAt(runes, i-1) || spaceAt(runes, i+1)) {
			return i, runes[i]
		}
	}
	return -1, 0
}

func spaceAt(runes []rune, i int) bool {
	return i >= 0 && i < len(runes) && runes[i] == ' '
}

// normalizeDepartmentText puts a value in NFC, drops invisible characters,
// turns every kind of whitespace into a plain space, collapses runs of spaces
// and trims the ends.
func normalizeDepartmentText(raw string) string {
	var b strings.Builder
	space := false
	for _, r := range norm.NFC.String(raw) {
		switch {
		case invisibleRunes[r]:
			continue
		case unicode.IsSpace(r) || unicode.IsControl(r):
			space = b.Len() > 0
			continue
		}
		if space {
			b.WriteByte(' ')
			space = false
		}
		b.WriteRune(r)
	}
	return b.String()
}
