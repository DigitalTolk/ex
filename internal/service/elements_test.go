package service

import (
	"context"
	"strconv"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// opts are options whose text is the value in capitals.
func opts(values ...string) []model.SelectOption {
	out := make([]model.SelectOption, len(values))
	for i, v := range values {
		out[i] = model.SelectOption{Text: *plain(strings.ToUpper(v)), Value: v}
	}
	return out
}

// row is an actions row holding es.
func row(es ...model.BlockElement) model.Blocks {
	return model.Blocks{{Type: model.BlockActions, Elements: es}}
}

// fieldForm is a form with one field holding e.
func fieldForm(e model.BlockElement) model.View {
	return model.View{Type: model.ViewModal, Title: *plain("Form"), Submit: plain("Send"), Blocks: model.Blocks{
		{Type: model.BlockInput, BlockID: "f", Label: plain("Field"), Element: &e},
	}}
}

func TestValueElement_AFormKeepsWhatEachKindUses(t *testing.T) {
	junk := func(e model.BlockElement) *model.BlockElement {
		// What no value element keeps: a button's settings, a confirm (forms
		// have none), and settings of other kinds — each kind drops those it
		// doesn't use.
		e.Text, e.Value, e.URL, e.Style, e.ExAction = plain("x"), "v", "https://ex.test", model.ButtonDanger, model.ExActionAck
		e.Confirm = &model.ConfirmDialog{Text: model.TextObject{Text: "Sure?"}}
		e.ImageURL, e.AltText = "https://img.ex.test/a.png", "alt"
		return &e
	}
	in := model.View{Type: model.ViewModal, Title: *plain("All kinds"), Submit: plain("Send"), Blocks: model.Blocks{
		{Type: model.BlockInput, BlockID: "num", Label: plain("Count"), DispatchAction: true, Element: junk(model.BlockElement{
			Type: model.ElementNumberInput, IsDecimalAllowed: true, MinValue: "-1.5", MaxValue: "10", InitialValue: "2.25", MaxLength: 4, Options: opts("x"),
		})},
		{Type: model.BlockInput, BlockID: "mail", Label: plain("Email"), Element: junk(model.BlockElement{Type: model.ElementEmailInput, InitialValue: "virpal@ex.test", MinValue: "1"})},
		{Type: model.BlockInput, BlockID: "link", Label: plain("Link"), Element: junk(model.BlockElement{Type: model.ElementURLInput, InitialValue: "https://ex.test/a", InitialDate: "2026-10-23"})},
		{Type: model.BlockInput, BlockID: "at", Label: plain("Time"), Element: junk(model.BlockElement{Type: model.ElementTimepicker, InitialTime: "09:30", InitialValue: "x"})},
		{Type: model.BlockInput, BlockID: "who", Label: plain("Owner"), Element: junk(model.BlockElement{Type: model.ElementUsersSelect, InitialUser: "virpal@ex.test", Placeholder: plain("Pick someone")})},
		{Type: model.BlockInput, BlockID: "team", Label: plain("Team"), Element: junk(model.BlockElement{
			Type: model.ElementMultiUsersSelect, InitialUsers: []string{"u-manisha", "virpal@ex.test", "u-manisha"}, MaxSelectedItems: 3, InitialUser: "u-x",
		})},
		{Type: model.BlockInput, BlockID: "tags", Label: plain("Tags"), Element: junk(model.BlockElement{
			Type: model.ElementMultiStaticSelect, Options: opts("a", "b", "c"), MaxSelectedItems: 2,
			InitialOptions: []model.SelectOption{{Text: *plain("whatever"), Value: "b"}}, InitialOption: &model.SelectOption{Value: "a"},
		})},
		{Type: model.BlockInput, BlockID: "checks", Label: plain("Checks"), Element: junk(model.BlockElement{
			Type:           model.ElementCheckboxes,
			Options:        []model.SelectOption{{Text: *md("**Tests**"), Value: "tests", Description: md("All _green_")}, {Text: *plain("Docs"), Value: "docs", Description: plain(" ")}},
			InitialOptions: []model.SelectOption{{Value: "docs"}}, MaxSelectedItems: 1,
		})},
		{Type: model.BlockInput, BlockID: "size", Label: plain("Size"), Element: junk(model.BlockElement{
			Type: model.ElementRadioButtons, Options: opts("s", "m", "l"), InitialOption: &model.SelectOption{Value: "m"},
		})},
	}}
	out, err := normalizeView(t, in)
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	el := func(i int) model.BlockElement {
		e := *out.Blocks[i].Element
		if e.ActionID != "value" || e.Text != nil || e.Value != "" || e.URL != "" || e.Style != "" || e.ExAction != "" || e.Confirm != nil || e.ImageURL != "" || e.AltText != "" {
			t.Fatalf("block %d kept what its kind doesn't use: %+v", i, e)
		}
		return e
	}
	if !out.Blocks[0].DispatchAction {
		t.Fatal("dispatch_action dropped")
	}
	if e := el(0); !e.IsDecimalAllowed || e.MinValue != "-1.5" || e.MaxValue != "10" || e.InitialValue != "2.25" || e.MaxLength != 0 || e.Options != nil {
		t.Fatalf("number = %+v", e)
	}
	if e := el(1); e.InitialValue != "virpal@ex.test" || e.MinValue != "" {
		t.Fatalf("email = %+v", e)
	}
	if e := el(2); e.InitialValue != "https://ex.test/a" || e.InitialDate != "" {
		t.Fatalf("url = %+v", e)
	}
	if e := el(3); e.InitialTime != "09:30" || e.InitialValue != "" {
		t.Fatalf("time = %+v", e)
	}
	// People are kept as ex user IDs, whether the app named them by ID or email.
	if e := el(4); e.InitialUser != "u-virpal" || e.Placeholder.Text != "Pick someone" {
		t.Fatalf("users_select = %+v", e)
	}
	if e := el(5); strings.Join(e.InitialUsers, ",") != "u-manisha,u-virpal,u-manisha" || e.MaxSelectedItems != 3 || e.InitialUser != "" {
		t.Fatalf("multi_users_select = %+v", e)
	}
	// Initial options are the element's own, not the copies the app sent.
	if e := el(6); len(e.Options) != 3 || e.MaxSelectedItems != 2 || len(e.InitialOptions) != 1 || e.InitialOptions[0].Text.Text != "B" || e.InitialOption != nil {
		t.Fatalf("multi_static_select = %+v", e)
	}
	// Checkboxes take markdown and a description; a blank description goes.
	e := el(7)
	if e.Options[0].Text.Type != model.TextMarkdown || e.Options[0].Description.Text != "All _green_" || e.Options[0].Description.Type != model.TextMarkdown ||
		e.Options[1].Description != nil || len(e.InitialOptions) != 1 || e.InitialOptions[0].Value != "docs" || e.MaxSelectedItems != 0 {
		t.Fatalf("checkboxes = %+v", e)
	}
	if e := el(8); e.InitialOption == nil || e.InitialOption.Text.Text != "M" {
		t.Fatalf("radio_buttons = %+v", e)
	}
}

func TestValueElement_AMessageKeepsPickersWithTheirConfirm(t *testing.T) {
	sel := model.BlockElement{Type: model.ElementStaticSelect, ActionID: "status", Options: opts("open", "done"), Placeholder: plain("Status"),
		Confirm: &model.ConfirmDialog{Text: model.TextObject{Text: "Change it?"}}}
	menu := model.BlockElement{Type: model.ElementOverflow, Options: []model.SelectOption{
		{Text: *plain("Open in tracker"), Value: "open", URL: "https://tracker.ex.test/A3"}, {Text: *plain("Snooze"), Value: "snooze"},
	}}
	date := model.BlockElement{Type: model.ElementDatepicker, InitialDate: "2026-10-23"}
	who := model.BlockElement{Type: model.ElementUsersSelect, ActionID: "who"}
	out, err := normalizeOne(t, model.Blocks{
		{Type: model.BlockSection, Text: plain("A3"), Accessory: &sel},
		{Type: model.BlockActions, Elements: []model.BlockElement{menu, date, who, btn("go", "Go")}},
	})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if acc := out[0].Accessory; acc.Type != model.ElementStaticSelect || acc.ActionID != "status" || acc.Confirm == nil || acc.Confirm.Title.Text != "Are you sure?" || acc.Placeholder.Text != "Status" {
		t.Fatalf("accessory = %+v", acc)
	}
	r := out[1].Elements
	// Unnamed elements are named a1, a2, … like buttons; a message's picker
	// is never named "value".
	if len(r) != 4 || r[0].ActionID != "a1" || r[0].Options[0].URL != "https://tracker.ex.test/A3" || r[1].ActionID != "a2" || r[1].InitialDate != "2026-10-23" || r[2].ActionID != "who" {
		t.Fatalf("row = %+v", r)
	}
}

func TestValueElement_Refusals(t *testing.T) {
	long := func(n int) string { return strings.Repeat("x", n) }
	many := func(n int) []model.SelectOption {
		out := make([]model.SelectOption, n)
		for i := range out {
			out[i] = model.SelectOption{Text: *plain("o"), Value: "v" + strconv.Itoa(i)}
		}
		return out
	}
	tooManyPeople := make([]string, maxAllowedUserLookups+1)
	for i := range tooManyPeople {
		tooManyPeople[i] = "u-" + strconv.Itoa(i)
	}
	type el = model.BlockElement
	for _, tc := range []struct {
		name string
		e    el
		want string
	}{
		// Every element.
		{"an action_id too long", el{Type: model.ElementStaticSelect, ActionID: long(maxBlockIDChars + 1), Options: opts("a")}, "action_id is longer than 255"},
		{"a placeholder too long", el{Type: model.ElementStaticSelect, Options: opts("a"), Placeholder: plain(long(maxPlaceholderChars + 1))}, ".placeholder: text is longer than 150"},
		{"a confirm without text", el{Type: model.ElementStaticSelect, Options: opts("a"), Confirm: &model.ConfirmDialog{}}, "elements[0].confirm: a confirm dialog needs text"},
		// Options.
		{"a select without options", el{Type: model.ElementStaticSelect}, "needs between 1 and 100 options"},
		{"a select with too many", el{Type: model.ElementMultiStaticSelect, Options: many(maxSelectOptions + 1)}, "needs between 1 and 100 options"},
		{"an overflow of one", el{Type: model.ElementOverflow, Options: opts("a")}, "an overflow menu needs 2 to 5 options"},
		{"an overflow of six", el{Type: model.ElementOverflow, Options: many(maxOverflowOptions + 1)}, "needs between 1 and 5 options"},
		{"eleven checkboxes", el{Type: model.ElementCheckboxes, Options: many(maxChoiceOptions + 1)}, "needs between 1 and 10 options"},
		{"eleven radio buttons", el{Type: model.ElementRadioButtons, Options: many(maxChoiceOptions + 1)}, "needs between 1 and 10 options"},
		{"a blank option value", el{Type: model.ElementRadioButtons, Options: []model.SelectOption{{Text: *plain("A"), Value: " "}}}, "options[0]: an option needs text and a value"},
		{"an option value twice", el{Type: model.ElementCheckboxes, Options: []model.SelectOption{opts("a")[0], opts("a")[0]}}, `options[1]: value "a" is used twice`},
		{"a description on a select", el{Type: model.ElementStaticSelect, Options: []model.SelectOption{{Text: *plain("A"), Value: "a", Description: plain("more")}}},
			"options[0]: only checkboxes and radio buttons have descriptions"},
		{"a description too long", el{Type: model.ElementCheckboxes, Options: []model.SelectOption{{Text: *plain("A"), Value: "a", Description: plain(long(maxOptionDescChars + 1))}}},
			"options[0].description: text is longer than 75"},
		{"a link on a select's option", el{Type: model.ElementStaticSelect, Options: []model.SelectOption{{Text: *plain("A"), Value: "a", URL: "https://ex.test"}}},
			"only an overflow menu's options can open a link"},
		{"a script link on an overflow", el{Type: model.ElementOverflow, Options: []model.SelectOption{{Text: *plain("A"), Value: "a", URL: "javascript:alert(1)"}, opts("b")[0]}},
			"options[0]: url must be an http or https address"},
		{"a link too long on an overflow", el{Type: model.ElementOverflow, Options: []model.SelectOption{{Text: *plain("A"), Value: "a", URL: "https://ex.test/" + long(maxButtonURLChars)}, opts("b")[0]}},
			"url must be an http or https address"},
		{"a radio initial_option not offered", el{Type: model.ElementRadioButtons, Options: opts("a"), InitialOption: &model.SelectOption{Value: "z"}}, "initial_option isn't one of the options"},
		{"a multi-select initial option not offered", el{Type: model.ElementMultiStaticSelect, Options: opts("a"), InitialOptions: []model.SelectOption{{Value: "z"}}},
			"initial_options names a value that isn't an option"},
		{"a checkbox initial option not offered", el{Type: model.ElementCheckboxes, Options: opts("a"), InitialOptions: []model.SelectOption{{Value: "z"}}},
			"initial_options names a value that isn't an option"},
		{"a negative max_selected_items", el{Type: model.ElementMultiStaticSelect, Options: opts("a"), MaxSelectedItems: -1}, "max_selected_items must be between 1 and 100"},
		{"too large a max_selected_items", el{Type: model.ElementMultiUsersSelect, MaxSelectedItems: maxSelectedItemsLimit + 1}, "max_selected_items must be between 1 and 100"},
		// People.
		{"an initial user who isn't one", el{Type: model.ElementUsersSelect, InitialUser: "nobody@else.test"}, ".initial_user: names someone who isn't an ex user"},
		{"initial users naming nobody", el{Type: model.ElementMultiUsersSelect, InitialUsers: []string{"u-1", "who@else.test"}}, "names someone who isn't an ex user"},
		{"too many people looked up", el{Type: model.ElementMultiUsersSelect, InitialUsers: tooManyPeople}, "names more than 100 people across the message"},
		// Dates, times, addresses.
		{"a bad initial date", el{Type: model.ElementDatepicker, InitialDate: "2026-13-01"}, "initial_date must be YYYY-MM-DD"},
		{"a bad initial time", el{Type: model.ElementTimepicker, InitialTime: "25:00"}, "initial_time must be HH:MM"},
		{"a bad initial email", el{Type: model.ElementEmailInput, InitialValue: "Virpal <virpal@ex.test>"}, "initial_value isn't an email address"},
		{"a script initial url", el{Type: model.ElementURLInput, InitialValue: "javascript:alert(1)"}, "initial_value must be an http or https address"},
		{"a too long initial url", el{Type: model.ElementURLInput, InitialValue: "https://ex.test/" + long(maxButtonURLChars)}, "initial_value must be an http or https address"},
		// Numbers.
		{"a min_value that isn't a number", el{Type: model.ElementNumberInput, MinValue: "1e3"}, "min_value isn't a whole number"},
		{"a decimal max_value of a whole field", el{Type: model.ElementNumberInput, MaxValue: "1.5"}, "max_value isn't a whole number"},
		{"a max_value that isn't a number", el{Type: model.ElementNumberInput, IsDecimalAllowed: true, MaxValue: "NaN"}, "max_value isn't a number"},
		{"min over max", el{Type: model.ElementNumberInput, MinValue: "10", MaxValue: "9"}, "min_value is more than max_value"},
		{"an initial value below min", el{Type: model.ElementNumberInput, MinValue: "1", InitialValue: "0"}, "initial_value isn't a whole number within the bounds"},
		{"an initial value above max", el{Type: model.ElementNumberInput, IsDecimalAllowed: true, MaxValue: "1", InitialValue: "1.01"}, "initial_value isn't a number within the bounds"},
		{"an initial value that isn't a number", el{Type: model.ElementNumberInput, InitialValue: "ten"}, "initial_value isn't a whole number"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// A form field refuses it (as invalid_view) …
			if model.IsInputType(tc.e.Type) {
				_, err := normalizeView(t, fieldForm(tc.e))
				if tc.e.Confirm == nil && !strings.Contains(errString(err), tc.want) {
					t.Fatalf("field: want %q, got %v", tc.want, err)
				}
				// A refusal never echoes an address: it would tell whoever
				// holds the webhook URL whether that address is someone's.
				if strings.Contains(errString(err), "else.test") {
					t.Fatalf("field refusal names the address: %v", err)
				}
			}
			// … and so does a message, where the element can go in one.
			if model.IsMessageInteractive(tc.e.Type) {
				_, err := normalizeOne(t, row(tc.e))
				wantInvalid(t, err, tc.want)
			}
		})
	}
}

func errString(err error) string {
	if err == nil {
		return "<nil>"
	}
	return err.Error()
}

func TestValueElement_AFormHasNoConfirmsAndNoOverflowFields(t *testing.T) {
	// A confirm on a form field is dropped, not checked.
	out, err := normalizeView(t, fieldForm(model.BlockElement{Type: model.ElementStaticSelect, Options: opts("a"), Confirm: &model.ConfirmDialog{}}))
	if err != nil || out.Blocks[0].Element.Confirm != nil {
		t.Fatalf("confirm on a field: %+v %v", out.Blocks, err)
	}
	// Text fields and an overflow menu are a form's, or a message's, only.
	if _, err := normalizeView(t, fieldForm(model.BlockElement{Type: model.ElementOverflow, Options: opts("a", "b")})); !strings.Contains(errString(err), "a field needs an input element") {
		t.Fatalf("overflow field: %v", err)
	}
	out2, err := normalizeOne(t, row(model.BlockElement{Type: model.ElementPlainTextInput}, model.BlockElement{Type: model.ElementNumberInput}))
	if err != nil || out2 != nil {
		t.Fatalf("text fields in a message are not drawn: %+v %v", out2, err)
	}
}

func TestResolveUsers_LooksEachPersonUpOnce(t *testing.T) {
	lookups := 0
	n := newBlockNormalizer(func(s string) string { return s }, func(_ context.Context, ref string) string {
		lookups++
		if ref == "virpal@ex.test" {
			return "u-virpal"
		}
		return ""
	})
	ids, err := n.resolveUsers(context.Background(), "at", []string{"virpal@ex.test", " virpal@ex.test", "virpal@ex.test"})
	if err != nil || strings.Join(ids, ",") != "u-virpal,u-virpal,u-virpal" || lookups != 2 {
		t.Fatalf("ids %v, %d lookups, err %v", ids, lookups, err)
	}
	if ids, err := n.resolveUsers(context.Background(), "at", nil); err != nil || ids != nil {
		t.Fatalf("none: %v %v", ids, err)
	}
}

func TestParseNumber(t *testing.T) {
	for _, tc := range []struct {
		raw     string
		decimal bool
		want    float64
		ok      bool
	}{
		{"42", false, 42, true},
		{" -7 ", false, -7, true},
		{"2.5", true, 2.5, true},
		{"-.5", true, -0.5, true},
		{"2.5", false, 0, false},
		{"1.2.3", true, 0, false},
		{"", true, 0, false},
		{"-", true, 0, false},
		{".", true, 0, false},
		{"1-2", true, 0, false},
		{"1e3", true, 0, false},
		{"0x1F", true, 0, false},
		{"NaN", true, 0, false},
		{"Inf", true, 0, false},
		{"+5", true, 0, false},
		{strings.Repeat("9", 33), true, 0, false},
		{strings.Repeat("9", 32), false, 99999999999999999999999999999999, true},
	} {
		got, ok := parseNumber(tc.raw, tc.decimal)
		if ok != tc.ok || got != tc.want {
			t.Errorf("parseNumber(%q, %v) = %v %v, want %v %v", tc.raw, tc.decimal, got, ok, tc.want, tc.ok)
		}
	}
}

func TestIsEmail(t *testing.T) {
	for raw, want := range map[string]bool{
		"virpal@ex.test":          true,
		"Virpal <virpal@ex.test>": false, // a name, not an address
		" virpal@ex.test":         false, // not as typed
		"virpal":                  false,
		"":                        false,
		strings.Repeat("a", 310) + "@ex.test.example": false,
	} {
		if got := isEmail(raw); got != want {
			t.Errorf("isEmail(%q) = %v, want %v", raw, got, want)
		}
	}
}

func TestImages_KeptWithAltTextAndRefusedWithout(t *testing.T) {
	pic := model.BlockElement{Type: model.ElementImage, ImageURL: " https://img.ex.test/a.png ", AltText: " a chart ", ActionID: "dropped", Text: plain("dropped")}
	out, err := normalizeOne(t, model.Blocks{
		{Type: model.BlockImage, ImageURL: "https://img.ex.test/big.png", AltText: "Burn-down", Text: md("Sprint **12**")},
		{Type: model.BlockImage, ImageURL: "https://img.ex.test/untitled.png", AltText: "x", Text: plain(" ")},
		{Type: model.BlockSection, Text: plain("A3"), Accessory: &pic},
		{Type: model.BlockContext, Elements: []model.BlockElement{pic, {Type: model.TextPlain, Content: "by Virpal"}}},
	})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	// An image block's title is plain text.
	if b := out[0]; b.ImageURL != "https://img.ex.test/big.png" || b.AltText != "Burn-down" || b.Text == nil || *b.Text != (model.TextObject{Type: model.TextPlain, Text: "Sprint **12**"}) || b.BlockID != "b1" {
		t.Fatalf("image block = %+v", b)
	}
	if out[1].Text != nil {
		t.Fatalf("a blank title is no title: %+v", out[1].Text)
	}
	want := model.BlockElement{Type: model.ElementImage, ImageURL: "https://img.ex.test/a.png", AltText: "a chart"}
	if acc := out[2].Accessory; acc == nil || acc.ImageURL != want.ImageURL || acc.AltText != want.AltText || acc.ActionID != "" || acc.Text != nil {
		t.Fatalf("accessory = %+v", acc)
	}
	if ctx := out[3].Elements; len(ctx) != 2 || ctx[0].ImageURL != want.ImageURL || ctx[0].AltText != want.AltText || ctx[1].Content != "by Virpal" {
		t.Fatalf("context = %+v", ctx)
	}

	pics := make([]model.BlockElement, maxContextElements+1)
	for i := range pics {
		pics[i] = pic
	}
	for _, tc := range []struct {
		name   string
		blocks model.Blocks
		want   string
	}{
		{"an image block without a url", model.Blocks{{Type: model.BlockImage, AltText: "x"}}, "blocks[0]: image_url must be an http or https address"},
		{"a script image", model.Blocks{{Type: model.BlockImage, ImageURL: "javascript:alert(1)", AltText: "x"}}, "image_url must be an http or https address"},
		{"an image url too long", model.Blocks{{Type: model.BlockImage, ImageURL: "https://img.ex.test/" + strings.Repeat("x", maxButtonURLChars), AltText: "x"}}, "image_url must be"},
		{"an image without alt text", model.Blocks{{Type: model.BlockImage, ImageURL: "https://img.ex.test/a.png", AltText: " "}}, "an image needs alt_text of at most 2000 characters"},
		{"alt text too long", model.Blocks{{Type: model.BlockImage, ImageURL: "https://img.ex.test/a.png", AltText: strings.Repeat("x", maxAltTextChars+1)}}, "an image needs alt_text"},
		{"a title too long", model.Blocks{{Type: model.BlockImage, ImageURL: "https://img.ex.test/a.png", AltText: "x", Text: plain(strings.Repeat("x", maxImageTitleChars+1))}},
			"blocks[0].title: text is longer than 2000"},
		{"a bad image accessory", model.Blocks{{Type: model.BlockSection, Text: plain("s"), Accessory: &model.BlockElement{Type: model.ElementImage, ImageURL: "https://img.ex.test/a.png"}}},
			"blocks[0].accessory: an image needs alt_text"},
		{"a bad picker accessory", model.Blocks{{Type: model.BlockSection, Text: plain("s"), Accessory: &model.BlockElement{Type: model.ElementOverflow}}},
			"blocks[0].accessory.elements[0]: needs between 1 and 5 options"},
		{"a bad context image", model.Blocks{{Type: model.BlockContext, Elements: []model.BlockElement{{Type: model.ElementImage, AltText: "x"}}}},
			"blocks[0].elements[0]: image_url must be"},
		{"too many context images", model.Blocks{{Type: model.BlockContext, Elements: pics}}, "a context row can hold at most 10 elements"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := normalizeOne(t, tc.blocks)
			wantInvalid(t, err, tc.want)
		})
	}
}
