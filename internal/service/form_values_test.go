package service

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// noUsers is a userCheck under which nobody can be picked.
func noUsers(string) bool { return false }

// onlyUsers is a userCheck under which only ids can be picked.
func onlyUsers(ids ...string) userCheck {
	return func(id string) bool {
		for _, ok := range ids {
			if id == ok {
				return true
			}
		}
		return false
	}
}

func TestRawValue_TakesAStringAListOrNull(t *testing.T) {
	for in, want := range map[string]RawValue{
		`"a"`:         {"a"},
		`["a","b"]`:   {"a", "b"},
		`[]`:          {},
		`null`:        {""},
		`{"v":"a"}`:   nil,
		`[1]`:         nil,
		`7`:           nil,
		`["a", null]`: {"a", ""},
	} {
		var got RawValue
		err := json.Unmarshal([]byte(in), &got)
		if want == nil {
			if err == nil || !strings.Contains(err.Error(), "a value must be a string or a list of strings") {
				t.Errorf("%s: want a refusal, got %v %v", in, got, err)
			}
			continue
		}
		if err != nil || strings.Join(got, "|") != strings.Join(want, "|") || len(got) != len(want) {
			t.Errorf("%s = %q %v, want %q", in, got, err, want)
		}
	}
}

func TestPickableUser_OnlyExistingActivePeople(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	f.svc.webhooks.SetUserResolver(fakeWebhookUsers{users: []*model.User{
		{ID: "u-1", Status: "active"}, {ID: "u-gone", Status: "deactivated"}, {ID: "u-new"},
	}})
	pick := f.svc.pickableUser(ctx)
	for id, want := range map[string]bool{"u-1": true, "u-new": true, "u-gone": false, "u-unknown": false, "": false} {
		if got := pick(id); got != want {
			t.Errorf("pickable(%q) = %v, want %v", id, got, want)
		}
	}
	f.svc.webhooks.users = nil
	if f.svc.pickableUser(ctx)("u-1") {
		t.Fatal("without a directory nobody can be picked")
	}
}

func TestReadValue_EachKindAgainstTheStoredElement(t *testing.T) {
	type el = model.BlockElement
	str := func(s string) *string { return &s }
	optA := opts("a")[0]
	for _, tc := range []struct {
		name    string
		e       el
		raw     RawValue
		want    ViewValue
		empty   bool
		problem string
	}{
		{"nothing", el{Type: model.ElementPlainTextInput}, nil, ViewValue{Type: model.ElementPlainTextInput}, true, ""},
		{"blank", el{Type: model.ElementStaticSelect}, RawValue{"  "}, ViewValue{Type: model.ElementStaticSelect}, true, ""},
		{"two for one", el{Type: model.ElementStaticSelect, Options: opts("a", "b")}, RawValue{"a", "b"}, ViewValue{Type: model.ElementStaticSelect}, false, "Please choose one."},
		{"text", el{Type: model.ElementPlainTextInput, MinLength: 2, MaxLength: 5}, RawValue{"héllo"}, ViewValue{Type: model.ElementPlainTextInput, Value: str("héllo")}, false, ""},
		{"text too long", el{Type: model.ElementPlainTextInput, MaxLength: 4}, RawValue{"héllo"}, ViewValue{Type: model.ElementPlainTextInput, Value: str("héllo")}, false, "Keep it to 4 characters."},
		{"text too short", el{Type: model.ElementPlainTextInput, MinLength: 3}, RawValue{"ok"}, ViewValue{Type: model.ElementPlainTextInput, Value: str("ok")}, false, "Use at least 3 characters."},
		{"number", el{Type: model.ElementNumberInput, MinValue: "1", MaxValue: "10"}, RawValue{"10"}, ViewValue{Type: model.ElementNumberInput, Value: str("10")}, false, ""},
		{"number not whole", el{Type: model.ElementNumberInput}, RawValue{"1.5"}, ViewValue{Type: model.ElementNumberInput, Value: str("1.5")}, false, "Enter a whole number."},
		{"number not a number", el{Type: model.ElementNumberInput, IsDecimalAllowed: true}, RawValue{"1e3"}, ViewValue{Type: model.ElementNumberInput, Value: str("1e3")}, false, "Enter a number."},
		{"number below min", el{Type: model.ElementNumberInput, IsDecimalAllowed: true, MinValue: "0.5"}, RawValue{"0.25"}, ViewValue{Type: model.ElementNumberInput, Value: str("0.25")}, false, "Use at least 0.5."},
		{"number above max", el{Type: model.ElementNumberInput, MaxValue: "-1"}, RawValue{"0"}, ViewValue{Type: model.ElementNumberInput, Value: str("0")}, false, "Use at most -1."},
		{"email", el{Type: model.ElementEmailInput}, RawValue{"virpal@ex.test"}, ViewValue{Type: model.ElementEmailInput, Value: str("virpal@ex.test")}, false, ""},
		{"not an email", el{Type: model.ElementEmailInput}, RawValue{"virpal"}, ViewValue{Type: model.ElementEmailInput, Value: str("virpal")}, false, "Enter an email address like name@example.com."},
		{"url", el{Type: model.ElementURLInput}, RawValue{"https://ex.test"}, ViewValue{Type: model.ElementURLInput, Value: str("https://ex.test")}, false, ""},
		{"not a web url", el{Type: model.ElementURLInput}, RawValue{"ftp://ex.test"}, ViewValue{Type: model.ElementURLInput, Value: str("ftp://ex.test")}, false, "Enter a link that starts with https://"},
		{"url too long", el{Type: model.ElementURLInput}, RawValue{"https://ex.test/" + strings.Repeat("x", maxButtonURLChars)}, ViewValue{Type: model.ElementURLInput, Value: str("https://ex.test/" + strings.Repeat("x", maxButtonURLChars))}, false, "Enter a link that starts with https://"},
		{"date", el{Type: model.ElementDatepicker}, RawValue{"2026-10-23"}, ViewValue{Type: model.ElementDatepicker, SelectedDate: str("2026-10-23")}, false, ""},
		{"not a date", el{Type: model.ElementDatepicker}, RawValue{"23.10.2026"}, ViewValue{Type: model.ElementDatepicker, SelectedDate: str("23.10.2026")}, false, "That isn't a date."},
		{"time", el{Type: model.ElementTimepicker}, RawValue{"23:59"}, ViewValue{Type: model.ElementTimepicker, SelectedTime: str("23:59")}, false, ""},
		{"not a time", el{Type: model.ElementTimepicker}, RawValue{"24:00"}, ViewValue{Type: model.ElementTimepicker, SelectedTime: str("24:00")}, false, "That isn't a time."},
		{"a person", el{Type: model.ElementUsersSelect}, RawValue{"u-1"}, ViewValue{Type: model.ElementUsersSelect, SelectedUser: str("u-1")}, false, ""},
		{"nobody pickable", el{Type: model.ElementUsersSelect}, RawValue{"u-gone"}, ViewValue{Type: model.ElementUsersSelect, SelectedUser: str("u-gone")}, false, "Pick someone from the list."},
		{"an option", el{Type: model.ElementRadioButtons, Options: opts("a")}, RawValue{"a"}, ViewValue{Type: model.ElementRadioButtons, SelectedOption: &optA}, false, ""},
		{"an option not offered", el{Type: model.ElementOverflow, Options: opts("a", "b")}, RawValue{"z"}, ViewValue{Type: model.ElementOverflow, SelectedOption: &model.SelectOption{}}, false, "Please choose one of the options."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, empty, problem := readValue(tc.e, tc.raw, onlyUsers("u-1"))
			gotJSON, _ := json.Marshal(got)
			wantJSON, _ := json.Marshal(tc.want)
			if string(gotJSON) != string(wantJSON) || empty != tc.empty || problem != tc.problem {
				t.Fatalf("got %s empty=%v %q, want %s empty=%v %q", gotJSON, empty, problem, wantJSON, tc.empty, tc.problem)
			}
		})
	}
}

func TestReadMulti_ListsAgainstTheStoredElement(t *testing.T) {
	type el = model.BlockElement
	manyPeople := make(RawValue, maxSelectedItemsLimit+1)
	for i := range manyPeople {
		manyPeople[i] = "u-" + strconv.Itoa(i)
	}
	for _, tc := range []struct {
		name    string
		e       el
		raw     RawValue
		want    string
		empty   bool
		problem string
	}{
		{"nothing ticked", el{Type: model.ElementCheckboxes, Options: opts("a")}, RawValue{" ", ""}, `{"type":"checkboxes"}`, true, ""},
		{"options in the order picked, once each", el{Type: model.ElementMultiStaticSelect, Options: opts("a", "b", "c")}, RawValue{"c", "a", "c", " "},
			`{"type":"multi_static_select","selected_options":[{"text":{"type":"plain_text","text":"C"},"value":"c"},{"text":{"type":"plain_text","text":"A"},"value":"a"}]}`, false, ""},
		{"an option not offered", el{Type: model.ElementCheckboxes, Options: opts("a")}, RawValue{"a", "z"}, "", false, "Please choose from the options."},
		{"over the element's limit", el{Type: model.ElementMultiStaticSelect, Options: opts("a", "b"), MaxSelectedItems: 1}, RawValue{"a", "b"}, "", false, "Choose at most 1."},
		{"people", el{Type: model.ElementMultiUsersSelect}, RawValue{"u-1", "u-2", "u-1"}, `{"type":"multi_users_select","selected_users":["u-1","u-2"]}`, false, ""},
		{"someone not pickable", el{Type: model.ElementMultiUsersSelect}, RawValue{"u-1", "u-gone"}, "", false, "Pick people from the list."},
		{"more people than any list holds", el{Type: model.ElementMultiUsersSelect}, manyPeople, "", false, "Choose at most 100."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, empty, problem := readValue(tc.e, tc.raw, onlyUsers("u-1", "u-2"))
			gotJSON, _ := json.Marshal(got)
			// With a problem the value goes nowhere: the pick is refused.
			if (tc.problem == "" && string(gotJSON) != tc.want) || empty != tc.empty || problem != tc.problem {
				t.Fatalf("got %s empty=%v %q, want %s empty=%v %q", gotJSON, empty, problem, tc.want, tc.empty, tc.problem)
			}
		})
	}
}

func TestEmptyProblem(t *testing.T) {
	for kind, want := range map[string]string{
		model.ElementPlainTextInput: "Please fill this in.", model.ElementNumberInput: "Please fill this in.",
		model.ElementEmailInput: "Please fill this in.", model.ElementURLInput: "Please fill this in.",
		model.ElementDatepicker: "Please pick a date.", model.ElementTimepicker: "Please pick a time.",
		model.ElementStaticSelect: "Please choose one.", model.ElementRadioButtons: "Please choose one.", model.ElementUsersSelect: "Please choose one.",
		model.ElementMultiStaticSelect: "Please choose at least one.", model.ElementMultiUsersSelect: "Please choose at least one.", model.ElementCheckboxes: "Please choose at least one.",
	} {
		if got := emptyProblem(kind); got != want {
			t.Errorf("%s: %q, want %q", kind, got, want)
		}
	}
}

func TestReadSubmission_LenientReadsAFormStillBeingFilledIn(t *testing.T) {
	form, err := normalizeView(t, model.View{Type: model.ViewModal, Title: *plain("Plan"), Submit: plain("Save"), Blocks: model.Blocks{
		{Type: model.BlockSection, Text: plain("Plan the week")},
		{Type: model.BlockInput, BlockID: "count", Label: plain("Count"), Element: &model.BlockElement{Type: model.ElementNumberInput, ActionID: "n"}},
		{Type: model.BlockInput, BlockID: "team", Label: plain("Team"), Element: &model.BlockElement{Type: model.ElementMultiUsersSelect}},
		{Type: model.BlockInput, BlockID: "when", Label: plain("When"), Element: &model.BlockElement{Type: model.ElementTimepicker}},
	}})
	if err != nil {
		t.Fatalf("form: %v", err)
	}
	raw := map[string]map[string]RawValue{"count": {"n": {"many"}}, "team": {"value": {"u-1"}}}

	// Submitting: a bad value and an empty required field are problems.
	values, problems := readSubmission(form, raw, onlyUsers("u-1"), false)
	if values != nil || len(problems) != 2 || problems["count"] != "Enter a whole number." || problems["when"] != "Please pick a time." {
		t.Fatalf("strict: %v %v", values, problems)
	}
	// Lenient: the bad value is left out, the empty field is just empty.
	values, problems = readSubmission(form, raw, onlyUsers("u-1"), true)
	if problems != nil || len(values) != 2 {
		t.Fatalf("lenient: %v %v", values, problems)
	}
	if _, ok := values["count"]; ok {
		t.Fatalf("a value that isn't valid reached the app: %v", values)
	}
	if team := values["team"]["value"]; strings.Join(team.SelectedUsers, ",") != "u-1" {
		t.Fatalf("team = %+v", team)
	}
	if when := values["when"]["value"]; when.Type != model.ElementTimepicker || when.SelectedTime != nil {
		t.Fatalf("when = %+v", when)
	}
}
