// Package cron parses the five-field cron specs that drive scheduled agent
// orders ("0 8 * * 1-5" — 08:00 on weekdays) and computes the next firing in
// a given timezone.
//
// Deliberately a SUBSET of crontab syntax: minute, hour, day-of-month, month
// and day-of-week, each accepting "*", a number, a "a-b" range, a "*/n" or
// "a-b/n" step, and comma-separated lists of those. No @macros, no names
// ("MON"), no seconds field — the orchestrator ticks every 15s, so minute
// precision is the floor, and anything richer would be syntax nobody in the
// product can discover. Keeping the grammar small also keeps Next() bounded
// and cheap: it runs for every schedule on every reconcile tick.
package cron

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// ErrSpec reports an unusable cron spec. Callers wrap it in their own
// validation error so the API answers 400 rather than 500.
var ErrSpec = errors.New("cron: invalid spec")

// Spec is a parsed cron expression: the allowed values per field, sorted
// ascending. A day fires when (dom matches OR dow matches) — with the crontab
// quirk that when BOTH are restricted, either one matching is enough.
type Spec struct {
	minutes []int
	hours   []int
	doms    []int
	months  []int
	dows    []int
	// domAny/dowAny record whether the field was "*" — the OR-vs-AND rule
	// above needs to know "unrestricted", which the value list alone can't
	// express (a "*" dom and a "1-31" dom allow the same days).
	domAny bool
	dowAny bool
}

type fieldDef struct {
	name     string
	min, max int
}

var fields = []fieldDef{
	{"minute", 0, 59},
	{"hour", 0, 23},
	{"day of month", 1, 31},
	{"month", 1, 12},
	{"day of week", 0, 7}, // 7 and 0 both mean Sunday
}

// maxLookahead bounds Next's search. A spec like "0 0 30 2 *" (February 30th)
// never fires; without a bound the loop would run forever.
const maxLookahead = 366 * 2

// Parse reads a five-field spec. Whitespace between fields is any run of
// spaces or tabs.
func Parse(spec string) (Spec, error) {
	parts := strings.Fields(strings.TrimSpace(spec))
	if len(parts) != 5 {
		return Spec{}, fmt.Errorf("%w: want 5 fields (minute hour day-of-month month day-of-week), got %d", ErrSpec, len(parts))
	}
	var out Spec
	lists := make([][]int, 5)
	for i, part := range parts {
		vals, err := parseField(part, fields[i])
		if err != nil {
			return Spec{}, err
		}
		lists[i] = vals
	}
	out.minutes, out.hours, out.doms, out.months, out.dows = lists[0], lists[1], lists[2], lists[3], lists[4]
	out.domAny = parts[2] == "*"
	out.dowAny = parts[4] == "*"
	// Normalize Sunday: crontab accepts 0 and 7; Go's time.Weekday only has 0.
	for i, d := range out.dows {
		if d == 7 {
			out.dows[i] = 0
		}
	}
	out.dows = dedupe(out.dows)
	return out, nil
}

// parseField expands one comma-separated field into its sorted, deduped
// values.
// A field is never empty here (strings.Fields drops blanks) and an empty
// LIST element ("0,,5") reaches parseTerm, which rejects it — so this has no
// empty-string guard of its own.
func parseField(field string, def fieldDef) ([]int, error) {
	var out []int
	for _, part := range strings.Split(field, ",") {
		vals, err := parseTerm(part, def)
		if err != nil {
			return nil, err
		}
		out = append(out, vals...)
	}
	return dedupe(out), nil
}

// parseTerm expands ONE term: "*", "*/n", "a", "a-b" or "a-b/n".
func parseTerm(term string, def fieldDef) ([]int, error) {
	step := 1
	if base, stepStr, ok := strings.Cut(term, "/"); ok {
		n, err := strconv.Atoi(stepStr)
		if err != nil || n <= 0 {
			return nil, fmt.Errorf("%w: bad step %q in %s field", ErrSpec, stepStr, def.name)
		}
		step = n
		term = base
	}
	lo, hi := def.min, def.max
	if term != "*" {
		loStr, hiStr, isRange := strings.Cut(term, "-")
		n, err := strconv.Atoi(loStr)
		if err != nil {
			return nil, fmt.Errorf("%w: bad value %q in %s field", ErrSpec, loStr, def.name)
		}
		lo, hi = n, n
		if isRange {
			m, err := strconv.Atoi(hiStr)
			if err != nil {
				return nil, fmt.Errorf("%w: bad range end %q in %s field", ErrSpec, hiStr, def.name)
			}
			hi = m
		}
	}
	if lo < def.min || hi > def.max || lo > hi {
		return nil, fmt.Errorf("%w: %s out of range (%d-%d)", ErrSpec, def.name, def.min, def.max)
	}
	var out []int
	for v := lo; v <= hi; v += step {
		out = append(out, v)
	}
	return out, nil
}

func dedupe(in []int) []int {
	seen := make(map[int]bool, len(in))
	out := make([]int, 0, len(in))
	for _, v := range in {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	// Insertion sort: fields hold at most 60 values.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// Location resolves an IANA timezone name, falling back to UTC for an empty
// or unknown zone — a schedule with a stale tz must still fire, just in UTC.
func Location(tz string) *time.Location {
	if tz == "" {
		return time.UTC
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return time.UTC
	}
	return loc
}

// Next returns the first firing strictly after `after`, evaluated in loc.
// The second result is false when the spec can never fire again within the
// lookahead window (e.g. February 30th).
//
// Search is date-first: whole days that don't match dom/month/dow are skipped
// without touching their 1440 minutes, so the worst case is ~366 day checks
// plus one day's hour/minute scan.
//
// DST: the local wall-clock time is what's asked for ("08:00 in Stockholm"),
// so time.Date does the conversion. A time that doesn't exist on a
// spring-forward day normalizes forward (08:00 → 09:00 rather than skipped);
// an ambiguous fall-back time resolves to one of the two instants. Both are
// once-a-year, one-hour effects on a daily schedule.
func (s Spec) Next(after time.Time, loc *time.Location) (time.Time, bool) {
	if len(s.minutes) == 0 || len(s.hours) == 0 || len(s.months) == 0 {
		return time.Time{}, false // zero Spec (never parsed)
	}
	// Start from the minute AFTER `after` — a firing exactly at `after` has
	// already happened.
	start := after.In(loc).Truncate(time.Minute).Add(time.Minute)
	day := time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, loc)
	for i := 0; i < maxLookahead; i++ {
		if s.matchesDay(day) {
			for _, h := range s.hours {
				for _, m := range s.minutes {
					candidate := time.Date(day.Year(), day.Month(), day.Day(), h, m, 0, 0, loc)
					if !candidate.Before(start) {
						return candidate, true
					}
				}
			}
		}
		day = day.AddDate(0, 0, 1)
	}
	return time.Time{}, false
}

// matchesDay applies the crontab day rule: month must match, then dom/dow —
// if both are restricted EITHER matching fires (the documented crontab
// quirk); otherwise the restricted one decides.
func (s Spec) matchesDay(day time.Time) bool {
	if !contains(s.months, int(day.Month())) {
		return false
	}
	domOK := contains(s.doms, day.Day())
	dowOK := contains(s.dows, int(day.Weekday()))
	switch {
	case s.domAny && s.dowAny:
		return true
	case s.domAny:
		return dowOK
	case s.dowAny:
		return domOK
	default:
		return domOK || dowOK
	}
}

func contains(vals []int, v int) bool {
	for _, x := range vals {
		if x == v {
			return true
		}
	}
	return false
}

// Due reports whether a schedule whose last firing was `last` is due at
// `now`, i.e. its next firing after `last` has arrived. `last` is the
// creation time for a schedule that has never run, so a new schedule never
// fires retroactively.
func Due(spec, tz string, last, now time.Time) bool {
	parsed, err := Parse(spec)
	if err != nil {
		return false
	}
	next, ok := parsed.Next(last, Location(tz))
	return ok && !next.After(now)
}

// Describe renders a spec as a short human sentence for UIs and logs
// ("08:00 Mon-Fri"). Falls back to the raw spec for shapes too rich to
// phrase, which is still more useful than nothing.
func Describe(spec, tz string) string {
	parsed, err := Parse(spec)
	if err != nil {
		return spec
	}
	zone := ""
	if tz != "" {
		zone = " " + tz
	}
	if len(parsed.hours) != 1 || len(parsed.minutes) != 1 {
		return spec + zone
	}
	at := fmt.Sprintf("%02d:%02d", parsed.hours[0], parsed.minutes[0])
	switch {
	case parsed.domAny && parsed.dowAny && len(parsed.months) == 12:
		return "daily at " + at + zone
	case parsed.domAny && !parsed.dowAny:
		return at + " on " + weekdayList(parsed.dows) + zone
	default:
		return spec + zone
	}
}

var dayNames = [...]string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"}

func weekdayList(dows []int) string {
	if len(dows) == 5 && dows[0] == 1 && dows[4] == 5 {
		return "Mon-Fri"
	}
	names := make([]string, 0, len(dows))
	for _, d := range dows {
		names = append(names, dayNames[d])
	}
	return strings.Join(names, ", ")
}
