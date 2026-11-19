package service

import (
	"slices"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestParseDepartment(t *testing.T) {
	type want struct {
		dept      string
		squads    []string
		anomalies []DepartmentAnomalyKind
	}
	cases := map[string]want{
		// The agreed format.
		"Engineering":                  {dept: "Engineering"},
		"Engineering - DOPE":           {dept: "Engineering", squads: []string{"DOPE"}},
		"Engineering - DOPE, Platform": {dept: "Engineering", squads: []string{"DOPE", "Platform"}},

		// No department.
		"":     {},
		"   ":  {},
		"N/A":  {},
		"none": {},
		"TBD":  {},
		"-":    {},
		"?":    {},

		// Whitespace is normalized, not reported.
		"  Engineering  -  DOPE ":           {dept: "Engineering", squads: []string{"DOPE"}},
		"Engineering\u00a0-\u00a0DOPE":      {dept: "Engineering", squads: []string{"DOPE"}},
		"Engineering\t-\nDOPE":              {dept: "Engineering", squads: []string{"DOPE"}},
		"Eng\u200bineering - DOPE\ufeff":    {dept: "Engineering", squads: []string{"DOPE"}},
		"Engineering\u202f-\u2009DOPE, Ops": {dept: "Engineering", squads: []string{"DOPE", "Ops"}},

		// Look-alike dashes and missing spaces are read, and reported.
		"Engineering – DOPE":      {dept: "Engineering", squads: []string{"DOPE"}, anomalies: []DepartmentAnomalyKind{AnomalyDash}},
		"Engineering — DOPE":      {dept: "Engineering", squads: []string{"DOPE"}, anomalies: []DepartmentAnomalyKind{AnomalyDash}},
		"Engineering \u2212 DOPE": {dept: "Engineering", squads: []string{"DOPE"}, anomalies: []DepartmentAnomalyKind{AnomalyDash}},
		"Engineering \u2011 DOPE": {dept: "Engineering", squads: []string{"DOPE"}, anomalies: []DepartmentAnomalyKind{AnomalyDash}},
		"Engineering -DOPE":       {dept: "Engineering", squads: []string{"DOPE"}, anomalies: []DepartmentAnomalyKind{AnomalySpacing}},
		"Engineering- DOPE":       {dept: "Engineering", squads: []string{"DOPE"}, anomalies: []DepartmentAnomalyKind{AnomalySpacing}},
		"Engineering –DOPE":       {dept: "Engineering", squads: []string{"DOPE"}, anomalies: []DepartmentAnomalyKind{AnomalyDash, AnomalySpacing}},

		// A dash between letters is part of a name.
		"Engineering-DOPE":      {dept: "Engineering-DOPE"},
		"Engineering—DOPE":      {dept: "Engineering—DOPE"},
		"Back-office - Billing": {dept: "Back-office", squads: []string{"Billing"}},
		"E-commerce - Web-shop": {dept: "E-commerce", squads: []string{"Web-shop"}},

		// Only the first separator splits.
		"Engineering - Platform - Core": {dept: "Engineering", squads: []string{"Platform - Core"}, anomalies: []DepartmentAnomalyKind{AnomalySecondSeparator}},

		// The squad list.
		"Engineering - DOPE,Platform":        {dept: "Engineering", squads: []string{"DOPE", "Platform"}, anomalies: []DepartmentAnomalyKind{AnomalySpacing}},
		"Engineering - DOPE, , Platform,":    {dept: "Engineering", squads: []string{"DOPE", "Platform"}, anomalies: []DepartmentAnomalyKind{AnomalyEmptySquad}},
		"Engineering - DOPE,,Platform":       {dept: "Engineering", squads: []string{"DOPE", "Platform"}, anomalies: []DepartmentAnomalyKind{AnomalyEmptySquad, AnomalySpacing}},
		"Engineering - DOPE,, Platform":      {dept: "Engineering", squads: []string{"DOPE", "Platform"}, anomalies: []DepartmentAnomalyKind{AnomalyEmptySquad}},
		"Engineering - A,B;C":                {dept: "Engineering", squads: []string{"A", "B", "C"}, anomalies: []DepartmentAnomalyKind{AnomalySemicolon, AnomalySpacing}},
		"Engineering - DOPE, dope":           {dept: "Engineering", squads: []string{"DOPE"}, anomalies: []DepartmentAnomalyKind{AnomalyDuplicateSquad}},
		"Engineering - DOPE; Platform":       {dept: "Engineering", squads: []string{"DOPE", "Platform"}, anomalies: []DepartmentAnomalyKind{AnomalySemicolon}},
		"Engineering - DOPE;Platform":        {dept: "Engineering", squads: []string{"DOPE", "Platform"}, anomalies: []DepartmentAnomalyKind{AnomalySemicolon, AnomalySpacing}},
		"Engineering - Data & AI, R/D, Ops.": {dept: "Engineering", squads: []string{"Data & AI", "R/D", "Ops."}},

		// Odd shapes.
		"Engineering -": {dept: "Engineering", anomalies: []DepartmentAnomalyKind{AnomalySpacing, AnomalyEmptySquadList}},
		"Engineering-":  {dept: "Engineering", anomalies: []DepartmentAnomalyKind{AnomalySpacing, AnomalyEmptySquadList}},
		"- DOPE":        {anomalies: []DepartmentAnomalyKind{AnomalyNoDepartment}},
		"-DOPE":         {anomalies: []DepartmentAnomalyKind{AnomalyNoDepartment}},
		" – DOPE, Ops":  {anomalies: []DepartmentAnomalyKind{AnomalyNoDepartment}},

		// Commas in the department are kept.
		"Research, Development":            {dept: "Research, Development"},
		"Research, Development - Platform": {dept: "Research, Development", squads: []string{"Platform"}},

		// Non-English text.
		"Försäljning - Norden":    {dept: "Försäljning", squads: []string{"Norden"}},
		"Forsa\u0308ljning - Ost": {dept: "Fors\u00e4ljning", squads: []string{"Ost"}}, // a + combining diaeresis composes to ä (NFC)
	}
	for raw, w := range cases {
		got := ParseDepartment(raw)
		if got.Department != w.dept || !slices.Equal(got.Squads, w.squads) || !slices.Equal(got.Anomalies, w.anomalies) {
			t.Errorf("ParseDepartment(%q) = {%q %q %v}, want {%q %q %v}", raw, got.Department, got.Squads, got.Anomalies, w.dept, w.squads, w.anomalies)
		}
	}
}

func TestParseDepartmentCapsSquads(t *testing.T) {
	var squads []string
	for i := range maxDepartmentSquads + 3 {
		squads = append(squads, "S"+strings.Repeat("x", i))
	}
	got := ParseDepartment("Engineering - " + strings.Join(squads, ", "))
	if len(got.Squads) != maxDepartmentSquads || !slices.Equal(got.Anomalies, []DepartmentAnomalyKind{AnomalyTooManySquads}) {
		t.Fatalf("got %d squads, anomalies %v; want %d and too-many-squads", len(got.Squads), got.Anomalies, maxDepartmentSquads)
	}
}

// formatDepartment writes a parse result back in the agreed format.
func formatDepartment(p ParsedDepartment) string {
	if len(p.Squads) == 0 {
		return p.Department
	}
	return p.Department + " - " + strings.Join(p.Squads, ", ")
}

func FuzzParseDepartment(f *testing.F) {
	for _, seed := range []string{
		"Engineering - DOPE, Platform", "Back-office - Billing", "Engineering – DOPE;Ops,", "- DOPE",
		"Research, Development", "  \u00a0Eng\u200bineering—DOPE ", "N/A", "Engineering - Platform - Core",
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, raw string) {
		if !utf8.ValidString(raw) {
			t.Skip()
		}
		got := ParseDepartment(raw)
		clean := func(s string) bool {
			return s != "" && s == strings.TrimSpace(s) && !strings.Contains(s, "  ")
		}
		if got.Department == "" && len(got.Squads) > 0 {
			t.Fatalf("squads without a department: %+v", got)
		}
		if got.Department != "" && !clean(got.Department) {
			t.Fatalf("department %q isn't trimmed", got.Department)
		}
		for _, s := range got.Squads {
			if !clean(s) || strings.ContainsAny(s, ",;") {
				t.Fatalf("squad %q isn't clean", s)
			}
		}
		// A value in the agreed format reads back the same (idempotence).
		if got.Department == "" || strings.ContainsAny(got.Department, "-\u2010\u2011\u2012–—\u2212") {
			return
		}
		again := ParseDepartment(formatDepartment(got))
		if again.Department != got.Department || !slices.Equal(again.Squads, got.Squads) {
			t.Fatalf("re-reading %q gave %+v, want %+v", formatDepartment(got), again, got)
		}
	})
}
