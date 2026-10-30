package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/model"
)

// ErrInvalidView refuses a form that breaks a rule; the message names the
// block. Apps get it as invalid_view.
var ErrInvalidView = errors.New("invalid view")

// Form limits (Slack's, where Slack has one).
const (
	maxViewBlocks           = 100
	maxViewTitleChars       = 24
	maxViewButtonChars      = 24
	maxPrivateMetadataChars = 3000
	maxCallbackIDChars      = 255
	maxLabelChars           = 2000
	maxPlaceholderChars     = 150
	maxInputChars           = 3000
	maxSelectOptions        = 100
	maxOptionTextChars      = 75
	maxOptionValueChars     = 150
	maxStoredViewBytes      = 128 * 1024
	dateLayout              = "2006-01-02"
)

func invalidView(format string, args ...any) error {
	return apperr.Reject(ErrInvalidView, format, args...)
}

// asInvalidView re-labels a block rule's refusal as the form's.
func asInvalidView(err error) error {
	if msg, ok := apperr.Message(err, ErrInvalidBlocks); ok {
		return invalidView("%s", msg)
	}
	return err
}

// view checks a form against the limits and returns it as ex keeps it:
// texts plain where they must be, every block and field named, and each
// input element holding only what its kind uses. Its ID and hash are the
// caller's to set.
func (n *blockNormalizer) view(ctx context.Context, in model.View) (model.View, error) {
	if in.Type != model.ViewModal {
		return model.View{}, invalidView(`view: type must be "modal"`)
	}
	out := model.View{Type: model.ViewModal, CallbackID: in.CallbackID, PrivateMetadata: in.PrivateMetadata, ExternalID: in.ExternalID}
	if utf8.RuneCountInString(in.CallbackID) > maxCallbackIDChars || utf8.RuneCountInString(in.ExternalID) > maxCallbackIDChars {
		return model.View{}, invalidView("view: callback_id and external_id can be at most %d characters", maxCallbackIDChars)
	}
	if utf8.RuneCountInString(in.PrivateMetadata) > maxPrivateMetadataChars {
		return model.View{}, invalidView("view: private_metadata can be at most %d characters", maxPrivateMetadataChars)
	}
	if strings.TrimSpace(in.Title.Text) == "" {
		return model.View{}, invalidView("view: a form needs a title")
	}
	var err error
	if out.Title, err = n.viewText("view.title", in.Title, maxViewTitleChars); err != nil {
		return model.View{}, err
	}
	for _, b := range []struct {
		at       string
		in       *model.TextObject
		out      **model.TextObject
		fallback string
	}{{"view.submit", in.Submit, &out.Submit, ""}, {"view.close", in.Close, &out.Close, "Cancel"}} {
		if b.in == nil || strings.TrimSpace(b.in.Text) == "" {
			if b.fallback != "" {
				*b.out = &model.TextObject{Type: model.TextPlain, Text: b.fallback}
			}
			continue
		}
		t, err := n.viewText(b.at, *b.in, maxViewButtonChars)
		if err != nil {
			return model.View{}, err
		}
		*b.out = &t
	}
	if len(in.Blocks) > maxViewBlocks {
		return model.View{}, invalidView("view: a form can hold at most %d blocks", maxViewBlocks)
	}
	n.reserveIDs(in.Blocks)
	inputs := 0
	for i, b := range in.Blocks {
		at := fmt.Sprintf("view.blocks[%d]", i)
		var nb model.Block
		keep := true
		if b.Type == model.BlockInput {
			nb, err = n.input(at, b)
			inputs++
		} else {
			nb, keep, err = n.block(ctx, at, b)
			if err == nil && keep {
				err = linksOnly(at, nb)
			}
		}
		if err != nil {
			return model.View{}, asInvalidView(err)
		}
		if keep {
			out.Blocks = append(out.Blocks, nb)
		}
	}
	if len(out.Blocks) == 0 {
		return model.View{}, invalidView("view: a form needs at least one block")
	}
	if inputs > 0 && out.Submit == nil {
		return model.View{}, invalidView("view: a form with fields needs a submit label")
	}
	if raw, _ := json.Marshal(out); len(raw) > maxStoredViewBytes {
		return model.View{}, invalidView("view: the form is larger than %d KB", maxStoredViewBytes/1024)
	}
	return out, nil
}

// viewText is a form's own plain text: its title or a button label.
func (n *blockNormalizer) viewText(at string, t model.TextObject, limit int) (model.TextObject, error) {
	out, err := n.text(at, t, limit, true)
	return out, asInvalidView(err)
}

// linksOnly keeps a form's buttons to links: a form submits as a whole, so
// a button that calls the app has no place in it (yet).
func linksOnly(at string, b model.Block) error {
	buttons := b.Elements
	if b.Accessory != nil {
		buttons = append([]model.BlockElement{*b.Accessory}, buttons...)
	}
	for _, e := range buttons {
		if e.Type == model.ElementButton && e.URL == "" {
			return invalidView("%s: a button in a form can only open a link", at)
		}
	}
	return nil
}

// input checks one form field: its label and hint, and its element.
func (n *blockNormalizer) input(at string, b model.Block) (model.Block, error) {
	if b.Label == nil || strings.TrimSpace(b.Label.Text) == "" {
		return model.Block{}, invalidView("%s: a field needs a label", at)
	}
	label, err := n.text(at+".label", *b.Label, maxLabelChars, true)
	if err != nil {
		return model.Block{}, err
	}
	out := model.Block{Type: model.BlockInput, Label: &label, Optional: b.Optional}
	if b.Hint != nil && strings.TrimSpace(b.Hint.Text) != "" {
		hint, err := n.text(at+".hint", *b.Hint, maxLabelChars, true)
		if err != nil {
			return model.Block{}, err
		}
		out.Hint = &hint
	}
	if b.Element == nil || !model.IsInputType(b.Element.Type) {
		return model.Block{}, invalidView("%s: a field needs a plain_text_input, datepicker or static_select element", at)
	}
	el, err := n.inputElement(at+".element", *b.Element)
	if err != nil {
		return model.Block{}, err
	}
	out.Element = &el
	if out.BlockID, err = n.blockID(at, b.BlockID); err != nil {
		return model.Block{}, err
	}
	return out, nil
}

// inputElement keeps what each kind of field uses, checked.
func (n *blockNormalizer) inputElement(at string, e model.BlockElement) (model.BlockElement, error) {
	out := model.BlockElement{Type: e.Type, ActionID: e.ActionID}
	if out.ActionID == "" {
		out.ActionID = "value"
	}
	if utf8.RuneCountInString(out.ActionID) > maxBlockIDChars {
		return model.BlockElement{}, invalidView("%s: action_id is longer than %d characters", at, maxBlockIDChars)
	}
	if e.Placeholder != nil && strings.TrimSpace(e.Placeholder.Text) != "" {
		p, err := n.text(at+".placeholder", *e.Placeholder, maxPlaceholderChars, true)
		if err != nil {
			return model.BlockElement{}, err
		}
		out.Placeholder = &p
	}
	switch e.Type {
	case model.ElementPlainTextInput:
		if e.MaxLength < 0 || e.MaxLength > maxInputChars || e.MinLength < 0 || e.MinLength > maxInputChars {
			return model.BlockElement{}, invalidView("%s: min_length and max_length must be between 0 and %d", at, maxInputChars)
		}
		if e.MaxLength > 0 && e.MinLength > e.MaxLength {
			return model.BlockElement{}, invalidView("%s: min_length is more than max_length", at)
		}
		if utf8.RuneCountInString(e.InitialValue) > maxLen(e.MaxLength) {
			return model.BlockElement{}, invalidView("%s: initial_value is longer than max_length", at)
		}
		out.Multiline, out.MinLength, out.MaxLength, out.InitialValue = e.Multiline, e.MinLength, e.MaxLength, e.InitialValue
	case model.ElementDatepicker:
		if e.InitialDate != "" {
			if _, err := time.Parse(dateLayout, e.InitialDate); err != nil {
				return model.BlockElement{}, invalidView("%s: initial_date must be YYYY-MM-DD", at)
			}
		}
		out.InitialDate = e.InitialDate
	default: // model.ElementStaticSelect
		opts, err := n.options(at, e.Options)
		if err != nil {
			return model.BlockElement{}, err
		}
		out.Options = opts
		if e.InitialOption != nil {
			o, ok := optionByValue(opts, e.InitialOption.Value)
			if !ok {
				return model.BlockElement{}, invalidView("%s: initial_option isn't one of the options", at)
			}
			out.InitialOption = &o
		}
	}
	return out, nil
}

func (n *blockNormalizer) options(at string, in []model.SelectOption) ([]model.SelectOption, error) {
	if len(in) == 0 || len(in) > maxSelectOptions {
		return nil, invalidView("%s: a select needs between 1 and %d options", at, maxSelectOptions)
	}
	out := make([]model.SelectOption, 0, len(in))
	seen := map[string]bool{}
	for i, o := range in {
		oat := fmt.Sprintf("%s.options[%d]", at, i)
		// A blank value can never be chosen: a submission's empty is "none".
		if strings.TrimSpace(o.Text.Text) == "" || strings.TrimSpace(o.Value) == "" {
			return nil, invalidView("%s: an option needs text and a value", oat)
		}
		if utf8.RuneCountInString(o.Value) > maxOptionValueChars {
			return nil, invalidView("%s: value is longer than %d characters", oat, maxOptionValueChars)
		}
		if seen[o.Value] {
			return nil, invalidView("%s: value %q is used twice", oat, o.Value)
		}
		seen[o.Value] = true
		t, err := n.text(oat+".text", o.Text, maxOptionTextChars, true)
		if err != nil {
			return nil, err
		}
		out = append(out, model.SelectOption{Text: t, Value: o.Value})
	}
	return out, nil
}

func optionByValue(opts []model.SelectOption, value string) (model.SelectOption, bool) {
	for _, o := range opts {
		if o.Value == value {
			return o, true
		}
	}
	return model.SelectOption{}, false
}

// maxLen is a text field's limit: its max_length, or the most a field holds.
func maxLen(max int) int {
	if max > 0 {
		return max
	}
	return maxInputChars
}

// ---- submissions

// ViewValue is one field's value as the app receives it, in Slack's shape:
// value for text, selected_date for a date, selected_option for a select;
// none for an optional field left empty.
type ViewValue struct {
	Type           string              `json:"type"`
	Value          *string             `json:"value,omitempty"`
	SelectedDate   *string             `json:"selected_date,omitempty"`
	SelectedOption *model.SelectOption `json:"selected_option,omitempty"`
}

// readSubmission checks what a person entered against the form ex stored —
// required fields, lengths, dates, options — and returns the values the app
// gets, or the message to show under each field that needs fixing. The
// browser sends only each field's raw value; a select's option comes from
// the stored form, never from the browser.
func readSubmission(v model.View, raw map[string]map[string]string) (map[string]map[string]ViewValue, map[string]string) {
	values := map[string]map[string]ViewValue{}
	problems := map[string]string{}
	for _, b := range v.Blocks {
		if b.Type != model.BlockInput {
			continue
		}
		e := b.Element
		got := raw[b.BlockID][e.ActionID]
		val := ViewValue{Type: e.Type}
		if strings.TrimSpace(got) == "" {
			if !b.Optional {
				problems[b.BlockID] = map[string]string{
					model.ElementPlainTextInput: "Please fill this in.",
					model.ElementDatepicker:     "Please pick a date.",
					model.ElementStaticSelect:   "Please choose one.",
				}[e.Type]
			}
			values[b.BlockID] = map[string]ViewValue{e.ActionID: val}
			continue
		}
		switch e.Type {
		case model.ElementPlainTextInput:
			n := utf8.RuneCountInString(got)
			if n > maxLen(e.MaxLength) {
				problems[b.BlockID] = fmt.Sprintf("Keep it to %d characters.", maxLen(e.MaxLength))
			} else if n < e.MinLength {
				problems[b.BlockID] = fmt.Sprintf("Use at least %d characters.", e.MinLength)
			}
			val.Value = &got
		case model.ElementDatepicker:
			if _, err := time.Parse(dateLayout, got); err != nil {
				problems[b.BlockID] = "That isn't a date."
			}
			val.SelectedDate = &got
		default:
			o, ok := optionByValue(e.Options, got)
			if !ok {
				problems[b.BlockID] = "Please choose one of the options."
			}
			val.SelectedOption = &o
		}
		values[b.BlockID] = map[string]ViewValue{e.ActionID: val}
	}
	if len(problems) > 0 {
		return nil, problems
	}
	return values, nil
}
