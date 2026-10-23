// Package cron parses the five-field cron specs that drive scheduled agent
// orders ("0 8 * * 1-5" — 08:00 on weekdays) and computes the next firing in
// a given timezone.
//
// Parsing is github.com/robfig/cron/v3's standard five-field parser (minute,
// hour, day-of-month, month, day-of-week; "*", numbers, names, "a-b" ranges,
// "/n" steps and lists). This package adds the product's rules on top: no
// @descriptors and no TZ= prefix (the timezone is a separate setting on the
// schedule), crontab's 7-for-Sunday, an unknown timezone falling back to UTC,
// a next-firing search that fires each wall-clock time once across DST
// changes (see Next), and Describe for UIs. The orchestrator ticks every 15s,
// so minute precision is the floor.
package cron

import (
	"errors"
	"fmt"
	"math/bits"
	"strconv"
	"strings"
	"time"

	robfig "github.com/robfig/cron/v3"
)

// ErrSpec reports an unusable cron spec. Callers wrap it in their own
// validation error so the API answers 400 rather than 500.
var ErrSpec = errors.New("cron: invalid spec")

// parser is robfig's standard five-field parser minus descriptors: @daily
// and @every are syntax nobody in the product can discover, and @every has
// no wall-clock meaning for Describe to phrase.
var parser = robfig.NewParser(robfig.Minute | robfig.Hour | robfig.Dom | robfig.Month | robfig.Dow)

// starBit is the flag robfig sets on a field written as "*" (or "?"). The
// crontab day rule depends on it: a day fires when dom AND dow match, unless
// both are restricted — then EITHER matching is enough.
const starBit = 1 << 63

// Spec is a parsed cron expression. The zero Spec never fires.
type Spec struct {
	sched *robfig.SpecSchedule
}

// Parse reads a five-field spec. Whitespace between fields is any run of
// spaces or tabs.
func Parse(spec string) (Spec, error) {
	spec = strings.TrimSpace(spec)
	// The timezone is the schedule's own setting. robfig would also read a
	// TZ= / CRON_TZ= prefix, and panics slicing one that has nothing after it.
	if strings.HasPrefix(spec, "TZ=") || strings.HasPrefix(spec, "CRON_TZ=") {
		return Spec{}, fmt.Errorf("%w: the timezone is set separately, not as a TZ= prefix", ErrSpec)
	}
	fields := strings.Fields(spec)
	if len(fields) == 5 {
		fields[4] = sevenAsSunday(fields[4])
	}
	sched, err := parser.Parse(strings.Join(fields, " "))
	if err != nil {
		return Spec{}, fmt.Errorf("%w: %v", ErrSpec, err)
	}
	// Without the Descriptor option every schedule robfig returns is a
	// *SpecSchedule (only @every builds anything else).
	return Spec{sched: sched.(*robfig.SpecSchedule)}, nil
}

// sevenAsSunday folds crontab's alternate Sunday (7), which robfig's 0-6
// day-of-week range rejects, into 0: a term that reaches 7 ("7", "5-7",
// "1-7/2") is spelled out as its days with Sunday as 0. Every other term
// passes through for the parser to judge.
func sevenAsSunday(dow string) string {
	terms := strings.Split(dow, ",")
	for i, term := range terms {
		rng, stepStr, hasStep := strings.Cut(term, "/")
		loStr, hiStr, isRange := strings.Cut(rng, "-")
		if !isRange {
			hiStr = loStr // "7" and "7/n" are the single day 7
		}
		lo, errLo := strconv.Atoi(loStr)
		step, errStep := 1, error(nil)
		if hasStep {
			step, errStep = strconv.Atoi(stepStr)
		}
		if hiStr != "7" || errLo != nil || errStep != nil || step <= 0 || lo > 7 {
			continue
		}
		var days []string
		for d := lo; d <= 7; d += step {
			days = append(days, strconv.Itoa(d%7))
		}
		terms[i] = strings.Join(days, ",")
	}
	return strings.Join(terms, ",")
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

// maxLookahead bounds Next's search. A spec like "0 0 30 2 *" (February 30th)
// never fires; without a bound the loop would run forever.
const maxLookahead = 366 * 2

// Next returns the first firing strictly after `after`, evaluated in loc.
// The second result is false when the spec can never fire again within the
// lookahead window (e.g. February 30th).
//
// Search is date-first: whole days that don't match dom/month/dow are skipped
// without touching their 1440 minutes, so the worst case is ~366 day checks
// plus one day's hour/minute scan.
//
// This is deliberately not robfig's SpecSchedule.Next, whose DST handling
// would drop or duplicate a scheduled order. Each matching day yields each
// wall-clock time once, through time.Date: a time that doesn't exist on a
// spring-forward day still fires that day, at the instant time.Date
// normalizes it to (Stockholm 02:30 → 03:30 CEST, New York 02:30 → 01:30
// EST) rather than being skipped, and an ambiguous fall-back time resolves to
// ONE of its two instants, so it fires once, not on each pass through the
// repeated hour.
func (s Spec) Next(after time.Time, loc *time.Location) (time.Time, bool) {
	if s.sched == nil {
		return time.Time{}, false // zero Spec (never parsed)
	}
	hours, minutes := fieldValues(s.sched.Hour), fieldValues(s.sched.Minute)
	// Start from the minute AFTER `after` — a firing exactly at `after` has
	// already happened.
	start := after.In(loc).Truncate(time.Minute).Add(time.Minute)
	day := time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, loc)
	for i := 0; i < maxLookahead; i++ {
		if s.matchesDay(day) {
			for _, h := range hours {
				for _, m := range minutes {
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
	sc := s.sched
	if sc.Month&(1<<uint(day.Month())) == 0 {
		return false
	}
	domOK := sc.Dom&(1<<uint(day.Day())) != 0
	dowOK := sc.Dow&(1<<uint(day.Weekday())) != 0
	domAny, dowAny := sc.Dom&starBit != 0, sc.Dow&starBit != 0
	switch {
	case domAny && dowAny:
		return true
	case domAny:
		return dowOK
	case dowAny:
		return domOK
	default:
		return domOK || dowOK
	}
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
	s := parsed.sched
	hours, minutes := fieldValues(s.Hour), fieldValues(s.Minute)
	if len(hours) != 1 || len(minutes) != 1 || len(fieldValues(s.Month)) != 12 {
		return spec + zone
	}
	at := fmt.Sprintf("%02d:%02d", hours[0], minutes[0])
	domAny, dowAny := s.Dom&starBit != 0, s.Dow&starBit != 0
	switch {
	case domAny && dowAny:
		return "daily at " + at + zone
	case domAny:
		return at + " on " + weekdayList(fieldValues(s.Dow)) + zone
	default:
		return spec + zone
	}
}

// fieldValues lists the values a robfig field bitmask allows, ascending.
func fieldValues(mask uint64) []int {
	mask &^= starBit
	out := make([]int, 0, bits.OnesCount64(mask))
	for mask != 0 {
		v := bits.TrailingZeros64(mask)
		out = append(out, v)
		mask &^= 1 << v
	}
	return out
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
