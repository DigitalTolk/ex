package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/model"
)

// maxRawValues bounds a list a browser may send for one element: more than
// any element can hold, so a longer one is refused unread.
const maxRawValues = maxSelectedItemsLimit

// maxUserChecks bounds the people one request may ask about.
const maxUserChecks = 150

// RawValue is what a browser sends for one element: a string, or a list of
// strings for the elements that hold several (multi-selects, checkboxes).
// It is only ever a claim — readValue decides what it is worth.
type RawValue []string

// UnmarshalJSON takes a string, a list of strings, or null.
func (r *RawValue) UnmarshalJSON(b []byte) error {
	var one string
	if err := json.Unmarshal(b, &one); err == nil {
		*r = RawValue{one}
		return nil
	}
	var many []string
	if err := json.Unmarshal(b, &many); err != nil {
		return errors.New("a value must be a string or a list of strings")
	}
	if len(many) > maxRawValues {
		return fmt.Errorf("a value can list at most %d items", maxRawValues)
	}
	*r = many
	return nil
}

// ViewValue is one element's value as the app receives it, in Slack's
// shape. Options come from the stored element, never the browser.
type ViewValue struct {
	Type            string               `json:"type"`
	Value           *string              `json:"value,omitempty"`
	SelectedDate    *string              `json:"selected_date,omitempty"`
	SelectedTime    *string              `json:"selected_time,omitempty"`
	SelectedOption  *model.SelectOption  `json:"selected_option,omitempty"`
	SelectedOptions []model.SelectOption `json:"selected_options,omitempty"`
	SelectedUser    *string              `json:"selected_user,omitempty"`
	SelectedUsers   []string             `json:"selected_users,omitempty"`
}

// userCheck reports whether an ID names a person who can be picked: an
// existing, active ex user.
type userCheck func(id string) bool

// pickableUser is the userCheck for one request: each person is looked up
// once, and at most maxUserChecks of them — past that, no one more counts.
func (s *InteractionService) pickableUser(ctx context.Context) userCheck {
	seen := map[string]bool{}
	return func(id string) bool {
		if ok, done := seen[id]; done {
			return ok
		}
		if s.webhooks.users == nil || id == "" || len(seen) >= maxUserChecks {
			return false
		}
		u, err := s.webhooks.users.GetByID(ctx, id)
		ok := err == nil && u != nil && u.Status != "deactivated"
		seen[id] = ok
		return ok
	}
}

// readValue reads what a browser sent for element e. It returns the value
// for the app, whether nothing was chosen, and — when what was sent isn't
// a value e can hold — what the person should fix.
func readValue(e model.BlockElement, raw RawValue, users userCheck) (v ViewValue, empty bool, problem string) {
	v = ViewValue{Type: e.Type}
	if model.IsMultiValue(e.Type) {
		return readMulti(e, raw, users)
	}
	if len(raw) > 1 {
		return v, false, "Please choose one."
	}
	got := ""
	if len(raw) == 1 {
		got = raw[0]
	}
	if strings.TrimSpace(got) == "" {
		return v, true, ""
	}
	switch e.Type {
	case model.ElementPlainTextInput:
		n := utf8.RuneCountInString(got)
		if n > maxLen(e.MaxLength) {
			problem = fmt.Sprintf("Keep it to %d characters.", maxLen(e.MaxLength))
		} else if n < e.MinLength {
			problem = fmt.Sprintf("Use at least %d characters.", e.MinLength)
		}
		v.Value = &got
	case model.ElementNumberInput:
		got = strings.TrimSpace(got)
		problem = numberProblem(e, got)
		v.Value = &got
	case model.ElementEmailInput:
		got = strings.TrimSpace(got)
		if !isEmail(got) {
			problem = "Enter an email address like name@example.com."
		}
		v.Value = &got
	case model.ElementURLInput:
		got = strings.TrimSpace(got)
		if len(got) > maxButtonURLChars || !isWebURL(got) {
			problem = "Enter a link that starts with https://"
		}
		v.Value = &got
	case model.ElementDatepicker:
		if _, err := time.Parse(dateLayout, got); err != nil {
			problem = "That isn't a date."
		}
		v.SelectedDate = &got
	case model.ElementTimepicker:
		if _, err := time.Parse(timeLayout, got); err != nil {
			problem = "That isn't a time."
		}
		v.SelectedTime = &got
	case model.ElementUsersSelect:
		if !users(got) {
			problem = "Pick someone from the list."
		}
		v.SelectedUser = &got
	default: // static_select, radio_buttons, overflow
		o, ok := optionByValue(e.Options, got)
		if !ok {
			problem = "Please choose one of the options."
		}
		v.SelectedOption = &o
	}
	return v, false, problem
}

// readMulti reads the elements that hold several values.
func readMulti(e model.BlockElement, raw RawValue, users userCheck) (v ViewValue, empty bool, problem string) {
	v = ViewValue{Type: e.Type}
	if len(raw) > maxRawValues {
		return v, false, fmt.Sprintf("Choose at most %d.", maxRawValues)
	}
	var picked []string
	seen := map[string]bool{}
	for _, r := range raw {
		if strings.TrimSpace(r) != "" && !seen[r] {
			seen[r] = true
			picked = append(picked, r)
		}
	}
	if len(picked) == 0 {
		return v, true, ""
	}
	if limit := e.MaxSelectedItems; limit > 0 && len(picked) > limit {
		return v, false, fmt.Sprintf("Choose at most %d.", limit)
	}
	if e.Type == model.ElementMultiUsersSelect {
		// At most maxRawValues (maxSelectedItemsLimit) people: a longer
		// list was refused above, before any lookup.
		for _, id := range picked {
			if !users(id) {
				return v, false, "Pick people from the list."
			}
		}
		v.SelectedUsers = picked
		return v, false, ""
	}
	for _, val := range picked {
		o, ok := optionByValue(e.Options, val)
		if !ok {
			return v, false, "Please choose from the options."
		}
		v.SelectedOptions = append(v.SelectedOptions, o)
	}
	return v, false, ""
}

func numberProblem(e model.BlockElement, got string) string {
	n, ok := parseNumber(got, e.IsDecimalAllowed)
	if !ok {
		if e.IsDecimalAllowed {
			return "Enter a number."
		}
		return "Enter a whole number."
	}
	if minV, ok := parseNumber(e.MinValue, true); ok && n < minV {
		return "Use at least " + e.MinValue + "."
	}
	if maxV, ok := parseNumber(e.MaxValue, true); ok && n > maxV {
		return "Use at most " + e.MaxValue + "."
	}
	return ""
}

// emptyProblem is what an empty required field says.
func emptyProblem(elementType string) string {
	switch elementType {
	case model.ElementDatepicker:
		return "Please pick a date."
	case model.ElementTimepicker:
		return "Please pick a time."
	case model.ElementStaticSelect, model.ElementRadioButtons, model.ElementUsersSelect:
		return "Please choose one."
	case model.ElementMultiStaticSelect, model.ElementMultiUsersSelect, model.ElementCheckboxes:
		return "Please choose at least one."
	}
	return "Please fill this in."
}

// readSubmission checks what a person entered against the form ex stored
// and returns the values the app gets — or, for a submission, the message
// to show under each field that needs fixing. lenient reads a form still
// being filled in (a change sent to the app, a form closed): required
// fields may be empty, and a value that isn't valid is left out rather
// than reported.
func readSubmission(v model.View, raw map[string]map[string]RawValue, users userCheck, lenient bool) (map[string]map[string]ViewValue, map[string]string) {
	values := map[string]map[string]ViewValue{}
	problems := map[string]string{}
	for _, b := range v.Blocks {
		if b.Type != model.BlockInput {
			continue
		}
		e := *b.Element
		val, empty, problem := readValue(e, raw[b.BlockID][e.ActionID], users)
		switch {
		case problem != "" && lenient:
			continue
		case problem != "":
			problems[b.BlockID] = problem
		case empty && !b.Optional && !lenient:
			problems[b.BlockID] = emptyProblem(e.Type)
		}
		values[b.BlockID] = map[string]ViewValue{e.ActionID: val}
	}
	if len(problems) > 0 {
		return nil, problems
	}
	return values, nil
}
