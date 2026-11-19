package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func normalizeView(t *testing.T, v model.View) (model.View, error) {
	t.Helper()
	return testNormalizer().view(context.Background(), v)
}

func TestView_KeepsWhatEachFieldUses(t *testing.T) {
	link := model.BlockElement{Type: model.ElementButton, Text: plain("Agenda"), URL: "https://ex.test/agenda"}
	in := model.View{
		Type: model.ViewModal, CallbackID: "cb", PrivateMetadata: "meta", ExternalID: "ext",
		Title:  *md("**Stand-up**"),
		Submit: md("Send"),
		Close:  plain("  "), // blank: the default label
		Blocks: model.Blocks{
			{Type: "video"}, // not drawn: skipped
			{Type: model.BlockSection, Text: md("hi <!here>"), Accessory: &link},
			{Type: model.BlockActions, Elements: []model.BlockElement{link}},
			{Type: model.BlockContext, Elements: []model.BlockElement{{Type: model.TextPlain, Content: "small print"}}},
			{Type: model.BlockInput, Label: md("Notes"), Hint: plain("A line or two"), Element: &model.BlockElement{
				Type: model.ElementPlainTextInput, Placeholder: plain("Type here"), Multiline: true, MinLength: 2, MaxLength: 10, InitialValue: "draft",
				Options: []model.SelectOption{{Text: *plain("x"), Value: "x"}}, InitialDate: "2026-10-23", URL: "https://ex.test",
			}},
			{Type: model.BlockInput, BlockID: "due", Label: plain("Due"), Hint: plain(" "), Optional: true, Element: &model.BlockElement{
				Type: model.ElementDatepicker, ActionID: "date", InitialDate: "2026-10-23", Multiline: true, InitialValue: "x", Placeholder: plain(" "),
			}},
			{Type: model.BlockInput, BlockID: "mood", Label: plain("Mood"), Element: &model.BlockElement{
				Type: model.ElementStaticSelect, Options: []model.SelectOption{{Text: *md("**Good**"), Value: "good"}, {Text: *plain("Meh"), Value: "meh"}},
				InitialOption: &model.SelectOption{Text: *plain("whatever the app says"), Value: "meh"}, MaxLength: 5,
			}},
		},
	}
	out, err := normalizeView(t, in)
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	if out.ID != "" || out.Hash != "" || out.CallbackID != "cb" || out.PrivateMetadata != "meta" || out.ExternalID != "ext" {
		t.Fatalf("identity = %+v", out)
	}
	if out.Title != (model.TextObject{Type: model.TextPlain, Text: "**Stand-up**"}) || out.Submit.Type != model.TextPlain || out.Close.Text != "Cancel" {
		t.Fatalf("labels = %+v %+v %+v", out.Title, out.Submit, out.Close)
	}
	if len(out.Blocks) != 6 || out.Blocks[0].Text.Text != "hi @here" || out.Blocks[0].Accessory.URL == "" {
		t.Fatalf("blocks = %+v", out.Blocks)
	}
	text, date, sel := out.Blocks[3], out.Blocks[4], out.Blocks[5]
	// Unnamed blocks are named around the app's own IDs.
	if text.BlockID != "b4" || date.BlockID != "due" || sel.BlockID != "mood" || text.Label.Type != model.TextPlain || text.Hint.Text != "A line or two" || date.Hint != nil {
		t.Fatalf("fields = %+v / %+v / %+v", text, date, sel)
	}
	if e := text.Element; e.ActionID != "value" || e.Placeholder.Text != "Type here" || !e.Multiline || e.MinLength != 2 || e.MaxLength != 10 || e.InitialValue != "draft" ||
		e.Options != nil || e.InitialDate != "" || e.URL != "" {
		t.Fatalf("text element = %+v", e)
	}
	if e := date.Element; e.ActionID != "date" || e.InitialDate != "2026-10-23" || e.Multiline || e.InitialValue != "" || e.Placeholder != nil || !date.Optional {
		t.Fatalf("date element = %+v", e)
	}
	// The initial option is the form's own, not the copy the app sent.
	if e := sel.Element; e.MaxLength != 0 || len(e.Options) != 2 || e.Options[0].Text != (model.TextObject{Type: model.TextPlain, Text: "**Good**"}) ||
		e.InitialOption == nil || e.InitialOption.Text.Text != "Meh" {
		t.Fatalf("select element = %+v", e)
	}

	// A form with no fields needs no submit label.
	readOnly, err := normalizeView(t, model.View{Type: model.ViewModal, Title: *plain("Done"), Blocks: model.Blocks{{Type: model.BlockDivider}}})
	if err != nil || readOnly.Submit != nil || readOnly.Close.Text != "Cancel" {
		t.Fatalf("read-only form: %+v %v", readOnly, err)
	}
}

func TestView_RefusesFormsThatBreakARule(t *testing.T) {
	long := func(n int) string { return strings.Repeat("x", n) }
	field := func(e model.BlockElement) model.Block {
		return model.Block{Type: model.BlockInput, Label: plain("Field"), Element: &e}
	}
	text := func(mut func(*model.BlockElement)) model.Block {
		e := model.BlockElement{Type: model.ElementPlainTextInput}
		mut(&e)
		return field(e)
	}
	sel := func(opts ...model.SelectOption) model.Block {
		return field(model.BlockElement{Type: model.ElementStaticSelect, Options: opts})
	}
	opt := func(text, value string) model.SelectOption {
		return model.SelectOption{Text: *plain(text), Value: value}
	}
	many := func(n int, b model.Block) model.Blocks {
		out := make(model.Blocks, n)
		for i := range out {
			out[i] = b
		}
		return out
	}
	manyOpts := make([]model.SelectOption, maxSelectOptions+1)
	for i := range manyOpts {
		manyOpts[i] = opt("o", long(i+1))
	}
	ackButton := btn("ack", "Ack")
	ackButton.ExAction = model.ExActionAck

	for _, tc := range []struct {
		name string
		mut  func(*model.View)
		want string
	}{
		{"not a modal", func(v *model.View) { v.Type = "home" }, `type must be "modal"`},
		{"callback_id too long", func(v *model.View) { v.CallbackID = long(maxCallbackIDChars + 1) }, "callback_id and external_id"},
		{"external_id too long", func(v *model.View) { v.ExternalID = long(maxCallbackIDChars + 1) }, "callback_id and external_id"},
		{"private_metadata too long", func(v *model.View) { v.PrivateMetadata = long(maxPrivateMetadataChars + 1) }, "private_metadata can be at most 3000"},
		{"no title", func(v *model.View) { v.Title.Text = "  " }, "a form needs a title"},
		{"title too long", func(v *model.View) { v.Title.Text = long(maxViewTitleChars + 1) }, "view.title: text is longer than 24"},
		{"submit too long", func(v *model.View) { v.Submit = plain(long(maxViewButtonChars + 1)) }, "view.submit: text is longer than 24"},
		{"close too long", func(v *model.View) { v.Close = plain(long(maxViewButtonChars + 1)) }, "view.close: text is longer than 24"},
		{"too many blocks", func(v *model.View) { v.Blocks = many(maxViewBlocks+1, model.Block{Type: model.BlockDivider}) }, "at most 100 blocks"},
		{"no blocks it can draw", func(v *model.View) { v.Blocks = model.Blocks{{Type: "video"}} }, "at least one block"},
		{"fields but no submit", func(v *model.View) { v.Submit = plain(" ") }, "needs a submit label"},
		{"too large", func(v *model.View) {
			v.Blocks = many(50, model.Block{Type: model.BlockSection, Text: plain(long(maxSectionChars))})
		}, "larger than 128 KB"},
		{"a bad message block", func(v *model.View) { v.Blocks = model.Blocks{{Type: model.BlockHeader}} }, "view.blocks[0]: a header needs text"},
		{"an option whose value is blank", func(v *model.View) {
			v.Blocks = model.Blocks{{Type: model.BlockInput, Label: plain("Pick"), Element: &model.BlockElement{Type: model.ElementStaticSelect, Options: []model.SelectOption{opt("Space", "  ")}}}}
		}, "an option needs text and a value"},
		{"a bad button in an actions row", func(v *model.View) {
			v.Blocks = model.Blocks{{Type: model.BlockActions, Elements: []model.BlockElement{btn("go", " ")}}}
		}, "view.blocks[0].elements[0]: a button needs a label"},
		{"a bad picker as an accessory", func(v *model.View) {
			b := model.BlockElement{Type: model.ElementStaticSelect, ActionID: "pick"}
			v.Blocks = model.Blocks{{Type: model.BlockSection, Text: plain("s"), Accessory: &b}}
		}, "view.blocks[0].accessory.elements[0]: needs between 1 and 100 options"},
		{"a bad built-in action", func(v *model.View) {
			loud := ackButton
			loud.Style = "loud"
			v.Blocks = model.Blocks{{Type: model.BlockActions, Elements: []model.BlockElement{loud}}}
		}, "style must be primary or danger"},
		{"an overflow menu as a field", func(v *model.View) {
			v.Blocks = model.Blocks{field(model.BlockElement{Type: model.ElementOverflow})}
		}, "a field needs an input element"},
		{"a field without a label", func(v *model.View) { v.Blocks[1].Label = nil }, "view.blocks[1]: a field needs a label"},
		{"a blank label", func(v *model.View) { v.Blocks[1].Label = plain(" ") }, "a field needs a label"},
		{"a label too long", func(v *model.View) { v.Blocks[1].Label = plain(long(maxLabelChars + 1)) }, "view.blocks[1].label: text is longer than 2000"},
		{"a hint too long", func(v *model.View) { v.Blocks[1].Hint = plain(long(maxLabelChars + 1)) }, "view.blocks[1].hint: text is longer than 2000"},
		{"a field without an element", func(v *model.View) { v.Blocks[1].Element = nil }, "view.blocks[1]: a field needs an input element"},
		{"a field holding a button", func(v *model.View) { v.Blocks = model.Blocks{field(btn("go", "Go"))} }, "a field needs an input element"},
		{"an action_id too long", func(v *model.View) {
			v.Blocks = model.Blocks{text(func(e *model.BlockElement) { e.ActionID = long(maxBlockIDChars + 1) })}
		}, "action_id is longer than 255"},
		{"a placeholder too long", func(v *model.View) {
			v.Blocks = model.Blocks{text(func(e *model.BlockElement) { e.Placeholder = plain(long(maxPlaceholderChars + 1)) })}
		}, "element.placeholder: text is longer than 150"},
		{"a negative max_length", func(v *model.View) { v.Blocks = model.Blocks{text(func(e *model.BlockElement) { e.MaxLength = -1 })} }, "between 0 and 3000"},
		{"a max_length too large", func(v *model.View) {
			v.Blocks = model.Blocks{text(func(e *model.BlockElement) { e.MaxLength = maxInputChars + 1 })}
		}, "between 0 and 3000"},
		{"a negative min_length", func(v *model.View) { v.Blocks = model.Blocks{text(func(e *model.BlockElement) { e.MinLength = -1 })} }, "between 0 and 3000"},
		{"a min_length too large", func(v *model.View) {
			v.Blocks = model.Blocks{text(func(e *model.BlockElement) { e.MinLength = maxInputChars + 1 })}
		}, "between 0 and 3000"},
		{"min over max", func(v *model.View) {
			v.Blocks = model.Blocks{text(func(e *model.BlockElement) { e.MinLength, e.MaxLength = 5, 4 })}
		}, "min_length is more than max_length"},
		{"an initial value over max_length", func(v *model.View) {
			v.Blocks = model.Blocks{text(func(e *model.BlockElement) { e.MaxLength, e.InitialValue = 3, "four" })}
		}, "initial_value is longer than max_length"},
		{"an initial value over what a field holds", func(v *model.View) {
			v.Blocks = model.Blocks{text(func(e *model.BlockElement) { e.InitialValue = long(maxInputChars + 1) })}
		}, "initial_value is longer than max_length"},
		{"a bad initial date", func(v *model.View) {
			v.Blocks = model.Blocks{field(model.BlockElement{Type: model.ElementDatepicker, InitialDate: "23/10/2026"})}
		}, "initial_date must be YYYY-MM-DD"},
		{"a select without options", func(v *model.View) { v.Blocks = model.Blocks{sel()} }, "view.blocks[0].element: needs between 1 and 100 options"},
		{"a select with too many options", func(v *model.View) { v.Blocks = model.Blocks{sel(manyOpts...)} }, "view.blocks[0].element: needs between 1 and 100 options"},
		{"an option without text", func(v *model.View) { v.Blocks = model.Blocks{sel(opt(" ", "a"))} }, "options[0]: an option needs text and a value"},
		{"an option without a value", func(v *model.View) { v.Blocks = model.Blocks{sel(opt("A", ""))} }, "an option needs text and a value"},
		{"an option value too long", func(v *model.View) { v.Blocks = model.Blocks{sel(opt("A", long(maxOptionValueChars+1)))} }, "value is longer than 150"},
		{"an option value twice", func(v *model.View) { v.Blocks = model.Blocks{sel(opt("A", "a"), opt("B", "a"))} }, `options[1]: value "a" is used twice`},
		{"an option text too long", func(v *model.View) { v.Blocks = model.Blocks{sel(opt(long(maxOptionTextChars+1), "a"))} }, "options[0].text: text is longer than 75"},
		{"an initial option not offered", func(v *model.View) {
			b := sel(opt("A", "a"))
			b.Element.InitialOption = &model.SelectOption{Text: *plain("Z"), Value: "z"}
			v.Blocks = model.Blocks{b}
		}, "initial_option isn't one of the options"},
		{"a block_id too long", func(v *model.View) { v.Blocks[1].BlockID = long(maxBlockIDChars + 1) }, "block_id is longer than 255"},
		{"a block_id twice", func(v *model.View) { v.Blocks[2].BlockID = "did" }, `block_id "did" is used twice`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := standupForm()
			tc.mut(&v)
			_, err := normalizeView(t, v)
			// A block rule's refusal reads as the form's: apps get invalid_view.
			if !errors.Is(err, ErrInvalidView) || errors.Is(err, ErrInvalidBlocks) || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want invalid_view naming %q, got %v", tc.want, err)
			}
		})
	}
}

func TestReadSubmission_ChecksEachFieldAgainstTheStoredForm(t *testing.T) {
	form, err := normalizeView(t, standupForm())
	if err != nil {
		t.Fatalf("form: %v", err)
	}
	// A field limited only by what a field holds.
	form.Blocks = append(form.Blocks, model.Block{Type: model.BlockInput, BlockID: "essay", Optional: true, Label: plain("Essay"),
		Element: &model.BlockElement{Type: model.ElementPlainTextInput, ActionID: "value"}})
	with := func(block, action, value string) map[string]map[string]RawValue {
		raw := standupAnswers()
		raw[block] = map[string]RawValue{action: {value}}
		return raw
	}
	for _, tc := range []struct {
		name  string
		raw   map[string]map[string]RawValue
		block string
		want  string
	}{
		{"required text empty", with("did", "text", ""), "did", "Please fill this in."},
		{"required date empty", with("due", "value", " "), "due", "Please pick a date."},
		{"a value under another action", with("did", "other", "Shipped forms"), "did", "Please fill this in."},
		{"text too short", with("did", "text", "ok"), "did", "Use at least 3 characters."},
		{"text over max_length", with("did", "text", strings.Repeat("é", 21)), "did", "Keep it to 20 characters."},
		{"text over what a field holds", with("essay", "value", strings.Repeat("x", maxInputChars+1)), "essay", "Keep it to 3000 characters."},
		{"not a date", with("due", "value", "2026-02-30"), "due", "That isn't a date."},
		{"an option the form doesn't offer", with("mood", "pick", "ecstatic"), "mood", "Please choose one of the options."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			values, problems := readSubmission(form, tc.raw, noUsers, false)
			if values != nil || len(problems) != 1 || problems[tc.block] != tc.want {
				t.Fatalf("problems = %v (values %v), want %s: %q", problems, values, tc.block, tc.want)
			}
		})
	}

	// A required select left empty.
	form.Blocks[3].Optional = false
	raw := standupAnswers()
	delete(raw, "mood")
	if _, problems := readSubmission(form, raw, noUsers, false); problems["mood"] != "Please choose one." {
		t.Fatalf("required select: %v", problems)
	}

	values, problems := readSubmission(form, standupAnswers(), noUsers, false)
	if problems != nil {
		t.Fatalf("valid: %v", problems)
	}
	did, due, mood, essay := values["did"]["text"], values["due"]["value"], values["mood"]["pick"], values["essay"]["value"]
	if *did.Value != "Shipped forms" || did.Type != model.ElementPlainTextInput || *due.SelectedDate != "2026-10-23" ||
		mood.SelectedOption.Text.Text != "**Good**" || essay.Value != nil || essay.Type != model.ElementPlainTextInput {
		t.Fatalf("values = %+v %+v %+v %+v", did, due, mood, essay)
	}
	if _, ok := values["b1"]; ok {
		t.Fatal("a non-field block got a value")
	}
}

func TestTruncateRunes(t *testing.T) {
	if got := truncateRunes("héllo", 5); got != "héllo" {
		t.Fatalf("within the limit: %q", got)
	}
	if got := truncateRunes("héllo!", 5); got != "héll…" {
		t.Fatalf("over the limit: %q", got)
	}
}
