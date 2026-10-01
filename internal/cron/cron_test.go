package cron

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func mustParse(t *testing.T, spec string) Spec {
	t.Helper()
	s, err := Parse(spec)
	if err != nil {
		t.Fatalf("Parse(%q): %v", spec, err)
	}
	return s
}

func TestParse_Shapes(t *testing.T) {
	for _, tc := range []struct {
		spec                 string
		minutes, hours, dows []int
		domAny, dowAny       bool
		monthsLen, domsLen   int
	}{
		{spec: "* * * * *", minutes: nil, hours: nil, dows: nil, domAny: true, dowAny: true, monthsLen: 12, domsLen: 31},
		{spec: "0 8 * * *", minutes: []int{0}, hours: []int{8}, domAny: true, dowAny: true, monthsLen: 12, domsLen: 31},
		{spec: "30 9 * * 1-5", minutes: []int{30}, hours: []int{9}, dows: []int{1, 2, 3, 4, 5}, domAny: true, monthsLen: 12, domsLen: 31},
		// Lists, ranges and steps compose; 7 folds onto 0 (Sunday) and dedupes.
		{spec: "0,30 */6 1 1,6 0,7", minutes: []int{0, 30}, hours: []int{0, 6, 12, 18}, dows: []int{0}, monthsLen: 2, domsLen: 1},
		// A stepped range: every other weekday hour.
		{spec: "15 8-16/4 * * *", minutes: []int{15}, hours: []int{8, 12, 16}, domAny: true, dowAny: true, monthsLen: 12, domsLen: 31},
		// Out-of-order lists are sorted, so Next's ascending scan is correct
		// whatever order the author typed.
		{spec: "45,0,30 17,9 * * 5,1", minutes: []int{0, 30, 45}, hours: []int{9, 17}, dows: []int{1, 5}, domAny: true, monthsLen: 12, domsLen: 31},
	} {
		got := mustParse(t, tc.spec)
		if tc.minutes != nil && !equal(got.minutes, tc.minutes) {
			t.Errorf("%q minutes = %v, want %v", tc.spec, got.minutes, tc.minutes)
		}
		if tc.hours != nil && !equal(got.hours, tc.hours) {
			t.Errorf("%q hours = %v, want %v", tc.spec, got.hours, tc.hours)
		}
		if tc.dows != nil && !equal(got.dows, tc.dows) {
			t.Errorf("%q dows = %v, want %v", tc.spec, got.dows, tc.dows)
		}
		if got.domAny != tc.domAny || got.dowAny != tc.dowAny {
			t.Errorf("%q anyness = dom:%v dow:%v, want dom:%v dow:%v", tc.spec, got.domAny, got.dowAny, tc.domAny, tc.dowAny)
		}
		if len(got.months) != tc.monthsLen || len(got.doms) != tc.domsLen {
			t.Errorf("%q months=%d doms=%d, want %d/%d", tc.spec, len(got.months), len(got.doms), tc.monthsLen, tc.domsLen)
		}
	}
}

func TestParse_Rejects(t *testing.T) {
	for _, tc := range []struct{ spec, want string }{
		{"", "want 5 fields"},
		{"0 8 * *", "want 5 fields"},
		{"0 8 * * * *", "want 5 fields"},
		{"60 8 * * *", "minute out of range"},
		{"0 24 * * *", "hour out of range"},
		{"0 8 0 * *", "day of month out of range"},
		{"0 8 32 * *", "day of month out of range"},
		{"0 8 * 13 *", "month out of range"},
		{"0 8 * * 8", "day of week out of range"},
		{"5-1 8 * * *", "minute out of range"}, // inverted range
		{"x 8 * * *", `bad value "x"`},
		{"1-x 8 * * *", `bad range end "x"`},
		{"*/0 8 * * *", `bad step "0"`},
		{"*/-1 8 * * *", `bad step "-1"`},
		{"*/x 8 * * *", `bad step "x"`},
		{"0,, 8 * * *", `bad value ""`}, // a list with a hole
	} {
		_, err := Parse(tc.spec)
		if err == nil {
			t.Fatalf("Parse(%q) = nil error, want one", tc.spec)
		}
		if !errors.Is(err, ErrSpec) {
			t.Errorf("Parse(%q) error not ErrSpec: %v", tc.spec, err)
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Errorf("Parse(%q) = %q, want it to mention %q", tc.spec, err, tc.want)
		}
	}
}

func TestNext_DailyAndWeekday(t *testing.T) {
	sthlm, err := time.LoadLocation("Europe/Stockholm")
	if err != nil {
		t.Skipf("tzdata unavailable: %v", err)
	}
	// Wednesday 2026-09-23, 10:00 local.
	now := time.Date(2026, 9, 23, 10, 0, 0, 0, sthlm)

	daily := mustParse(t, "0 8 * * *")
	next, ok := daily.Next(now, sthlm)
	if !ok || !next.Equal(time.Date(2026, 9, 24, 8, 0, 0, 0, sthlm)) {
		t.Fatalf("daily next = %v (%v), want 2026-09-24 08:00", next, ok)
	}
	// Before the hour on the same day → today.
	early := time.Date(2026, 9, 23, 6, 30, 0, 0, sthlm)
	if next, _ := daily.Next(early, sthlm); !next.Equal(time.Date(2026, 9, 23, 8, 0, 0, 0, sthlm)) {
		t.Fatalf("daily from 06:30 = %v, want today 08:00", next)
	}
	// Exactly at the firing minute → the NEXT one, never the same instant twice.
	at := time.Date(2026, 9, 23, 8, 0, 0, 0, sthlm)
	if next, _ := daily.Next(at, sthlm); !next.Equal(time.Date(2026, 9, 24, 8, 0, 0, 0, sthlm)) {
		t.Fatalf("daily from 08:00 = %v, want tomorrow", next)
	}

	// Weekdays only: Friday 18:00 → Monday 08:00, skipping the weekend.
	weekdays := mustParse(t, "0 8 * * 1-5")
	friday := time.Date(2026, 9, 25, 18, 0, 0, 0, sthlm)
	next, ok = weekdays.Next(friday, sthlm)
	if !ok || !next.Equal(time.Date(2026, 9, 28, 8, 0, 0, 0, sthlm)) {
		t.Fatalf("weekday next = %v (%v), want Monday 2026-09-28 08:00", next, ok)
	}
	if next.Weekday() != time.Monday {
		t.Fatalf("weekday next landed on %v", next.Weekday())
	}
}

func TestNext_DomDowUnionAndMonths(t *testing.T) {
	utc := time.UTC
	// Both restricted → EITHER matches (the crontab quirk): the 1st of the
	// month OR any Monday.
	union := mustParse(t, "0 0 1 * 1")
	from := time.Date(2026, 9, 23, 0, 0, 0, 0, utc) // Wednesday
	next, _ := union.Next(from, utc)
	if !next.Equal(time.Date(2026, 9, 28, 0, 0, 0, 0, utc)) { // the next Monday
		t.Fatalf("union next = %v, want Monday 2026-09-28", next)
	}
	// From just before month end, the 1st wins even though it isn't a Monday.
	next, _ = union.Next(time.Date(2026, 9, 30, 12, 0, 0, 0, utc), utc)
	if !next.Equal(time.Date(2026, 10, 1, 0, 0, 0, 0, utc)) {
		t.Fatalf("union month-boundary next = %v, want 2026-10-01", next)
	}
	// Month restriction crosses the year.
	yearly := mustParse(t, "0 9 1 1 *")
	next, ok := yearly.Next(time.Date(2026, 6, 1, 0, 0, 0, 0, utc), utc)
	if !ok || !next.Equal(time.Date(2027, 1, 1, 9, 0, 0, 0, utc)) {
		t.Fatalf("yearly next = %v (%v), want 2027-01-01 09:00", next, ok)
	}
	// A day-of-month restriction with dow "*" uses the dom.
	monthly := mustParse(t, "0 7 15 * *")
	next, _ = monthly.Next(time.Date(2026, 9, 20, 0, 0, 0, 0, utc), utc)
	if !next.Equal(time.Date(2026, 10, 15, 7, 0, 0, 0, utc)) {
		t.Fatalf("monthly next = %v, want 2026-10-15 07:00", next)
	}
}

func TestNext_Unsatisfiable(t *testing.T) {
	// February 30th never comes; the lookahead bound must end the search.
	never := mustParse(t, "0 0 30 2 *")
	if _, ok := never.Next(time.Now(), time.UTC); ok {
		t.Fatal("February 30th reported a firing")
	}
	// A zero Spec (never parsed) is inert rather than panicking.
	if _, ok := (Spec{}).Next(time.Now(), time.UTC); ok {
		t.Fatal("zero Spec reported a firing")
	}
}

func TestNext_AcrossDSTKeepsWallClock(t *testing.T) {
	sthlm, err := time.LoadLocation("Europe/Stockholm")
	if err != nil {
		t.Skipf("tzdata unavailable: %v", err)
	}
	daily := mustParse(t, "0 8 * * *")
	// 2026-10-25 is the European fall-back Sunday. A daily 08:00 order must
	// still fire at 08:00 wall-clock on both sides of the change, even though
	// the UTC offset differs.
	before := time.Date(2026, 10, 24, 12, 0, 0, 0, sthlm)
	next, _ := daily.Next(before, sthlm)
	if h, m := next.Hour(), next.Minute(); h != 8 || m != 0 {
		t.Fatalf("across DST fired at %02d:%02d local, want 08:00", h, m)
	}
	if next.Day() != 25 {
		t.Fatalf("across DST landed on day %d, want 25", next.Day())
	}
}

func TestDue(t *testing.T) {
	utc := time.UTC
	last := time.Date(2026, 9, 23, 8, 0, 0, 0, utc)
	// The 08:00 daily order is not due again until the next 08:00.
	if Due("0 8 * * *", "UTC", last, time.Date(2026, 9, 23, 23, 0, 0, 0, utc)) {
		t.Fatal("daily order reported due the same day")
	}
	if !Due("0 8 * * *", "UTC", last, time.Date(2026, 9, 24, 8, 0, 0, 0, utc)) {
		t.Fatal("daily order not due at the next firing")
	}
	// A long outage fires ONCE on return, not once per missed day.
	if !Due("0 8 * * *", "UTC", last, time.Date(2026, 9, 30, 12, 0, 0, 0, utc)) {
		t.Fatal("order not due after an outage")
	}
	// Timezone is honoured: 08:00 Stockholm is 06:00 UTC in summer.
	if !Due("0 8 * * *", "Europe/Stockholm", last, time.Date(2026, 9, 24, 6, 5, 0, 0, utc)) {
		t.Fatal("Stockholm 08:00 not due at 06:05 UTC")
	}
	// An unparseable spec is never due (it was rejected at write time; this
	// is the belt-and-braces arm for a row that predates validation).
	if Due("not a cron", "UTC", last, time.Date(2030, 1, 1, 0, 0, 0, 0, utc)) {
		t.Fatal("garbage spec reported due")
	}
	// An unsatisfiable spec is never due.
	if Due("0 0 30 2 *", "UTC", last, time.Date(2030, 1, 1, 0, 0, 0, 0, utc)) {
		t.Fatal("February 30th reported due")
	}
}

func TestLocation(t *testing.T) {
	if Location("").String() != "UTC" {
		t.Fatal("empty tz should be UTC")
	}
	if Location("Nowhere/Fake").String() != "UTC" {
		t.Fatal("unknown tz should fall back to UTC")
	}
	if loc := Location("Europe/Stockholm"); loc.String() != "Europe/Stockholm" && loc.String() != "UTC" {
		t.Fatalf("named tz resolved to %s", loc)
	}
}

func TestDescribe(t *testing.T) {
	for _, tc := range []struct{ spec, tz, want string }{
		{"0 8 * * *", "Europe/Stockholm", "daily at 08:00 Europe/Stockholm"},
		{"30 17 * * *", "", "daily at 17:30"},
		{"0 8 * * 1-5", "UTC", "08:00 on Mon-Fri UTC"},
		{"0 9 * * 1,3", "UTC", "09:00 on Mon, Wed UTC"},
		{"0 9 * * 0", "UTC", "09:00 on Sun UTC"},
		// Shapes too rich to phrase fall back to the raw spec.
		{"*/15 * * * *", "UTC", "*/15 * * * * UTC"},
		{"0 9 1 * *", "UTC", "0 9 1 * * UTC"},
		{"0 9 1 1 *", "", "0 9 1 1 *"},
		{"nonsense", "UTC", "nonsense"},
	} {
		if got := Describe(tc.spec, tc.tz); got != tc.want {
			t.Errorf("Describe(%q, %q) = %q, want %q", tc.spec, tc.tz, got, tc.want)
		}
	}
}

func equal(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
