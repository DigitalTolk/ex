package service

import (
	"context"
	"fmt"
	"net/mail"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/model"
)

// Element limits (Slack's, where Slack has one).
const (
	maxOverflowOptions    = 5
	maxChoiceOptions      = 10 // checkboxes, radio buttons
	maxOptionDescChars    = 75
	maxAltTextChars       = 2000
	maxImageTitleChars    = 2000
	maxSelectedItemsLimit = 100
	timeLayout            = "15:04"
	// maxImages bounds the images one message or form carries: each one is
	// a fetch ex makes on the app's behalf.
	maxImages = 20
)

// place is where an element sits, which decides the kinds it may be.
type place int

const (
	placeMessage place = iota // a message's (or form's) actions row or section accessory
	placeInput                // a form field
)

// valueElement checks an element that takes a value — a select, a picker,
// checkboxes, a text field — and keeps only what its kind uses. Every rule
// here is one the server enforces again when a value comes back
// (readValue): the browser never decides what is valid. Its callers pass
// only kinds that may sit where: IsMessageInteractive in a message,
// IsInputType in a form field.
func (n *blockNormalizer) valueElement(ctx context.Context, at string, e model.BlockElement, where place) (model.BlockElement, error) {
	out := model.BlockElement{Type: e.Type, ActionID: e.ActionID}
	if out.ActionID == "" && where == placeInput {
		out.ActionID = "value"
	}
	if utf8.RuneCountInString(out.ActionID) > maxBlockIDChars {
		return model.BlockElement{}, invalidBlocks("%s: action_id is longer than %d characters", at, maxBlockIDChars)
	}
	if e.Placeholder != nil && strings.TrimSpace(e.Placeholder.Text) != "" {
		p, err := n.text(at+".placeholder", *e.Placeholder, maxPlaceholderChars, true)
		if err != nil {
			return model.BlockElement{}, err
		}
		out.Placeholder = &p
	}
	if e.Confirm != nil && where == placeMessage {
		c, err := n.confirm(at+".confirm", *e.Confirm)
		if err != nil {
			return model.BlockElement{}, err
		}
		out.Confirm = &c
	}
	if err := n.elementValues(ctx, at, e, &out); err != nil {
		return model.BlockElement{}, err
	}
	return out, nil
}

// elementValues checks each kind's own settings and starting value.
func (n *blockNormalizer) elementValues(ctx context.Context, at string, e model.BlockElement, out *model.BlockElement) error {
	switch e.Type {
	case model.ElementPlainTextInput:
		if e.MaxLength < 0 || e.MaxLength > maxInputChars || e.MinLength < 0 || e.MinLength > maxInputChars {
			return invalidBlocks("%s: min_length and max_length must be between 0 and %d", at, maxInputChars)
		}
		if e.MaxLength > 0 && e.MinLength > e.MaxLength {
			return invalidBlocks("%s: min_length is more than max_length", at)
		}
		if utf8.RuneCountInString(e.InitialValue) > maxLen(e.MaxLength) {
			return invalidBlocks("%s: initial_value is longer than max_length", at)
		}
		out.Multiline, out.MinLength, out.MaxLength, out.InitialValue = e.Multiline, e.MinLength, e.MaxLength, e.InitialValue
	case model.ElementNumberInput:
		return numberSettings(at, e, out)
	case model.ElementEmailInput:
		if e.InitialValue != "" && !isEmail(e.InitialValue) {
			return invalidBlocks("%s: initial_value isn't an email address", at)
		}
		out.InitialValue = e.InitialValue
	case model.ElementURLInput:
		if e.InitialValue != "" && (!isWebURL(e.InitialValue) || len(e.InitialValue) > maxButtonURLChars) {
			return invalidBlocks("%s: initial_value must be an http or https address", at)
		}
		out.InitialValue = e.InitialValue
	case model.ElementDatepicker:
		if e.InitialDate != "" {
			if _, err := time.Parse(dateLayout, e.InitialDate); err != nil {
				return invalidBlocks("%s: initial_date must be YYYY-MM-DD", at)
			}
		}
		out.InitialDate = e.InitialDate
	case model.ElementTimepicker:
		if e.InitialTime != "" {
			if _, err := time.Parse(timeLayout, e.InitialTime); err != nil {
				return invalidBlocks("%s: initial_time must be HH:MM", at)
			}
		}
		out.InitialTime = e.InitialTime
	case model.ElementUsersSelect:
		if e.InitialUser != "" {
			ids, err := n.resolveUsers(ctx, at+".initial_user", []string{e.InitialUser})
			if err != nil {
				return err
			}
			out.InitialUser = ids[0]
		}
	case model.ElementMultiUsersSelect:
		if err := maxSelected(at, e.MaxSelectedItems); err != nil {
			return err
		}
		out.MaxSelectedItems = e.MaxSelectedItems
		ids, err := n.resolveUsers(ctx, at, e.InitialUsers)
		if err != nil {
			return err
		}
		out.InitialUsers = ids
	default: // the option kinds: selects, overflow, checkboxes, radio buttons
		return n.optionSettings(at, e, out)
	}
	return nil
}

// optionSettings checks an option element's options and initial choice(s).
func (n *blockNormalizer) optionSettings(at string, e model.BlockElement, out *model.BlockElement) error {
	limit, rich := maxSelectOptions, false
	switch e.Type {
	case model.ElementOverflow:
		limit = maxOverflowOptions
	case model.ElementCheckboxes, model.ElementRadioButtons:
		limit, rich = maxChoiceOptions, true
	}
	opts, err := n.optionList(at, e.Options, limit, rich, e.Type == model.ElementOverflow)
	if err != nil {
		return err
	}
	if e.Type == model.ElementOverflow && len(opts) < 2 {
		return invalidBlocks("%s: an overflow menu needs 2 to %d options", at, maxOverflowOptions)
	}
	out.Options = opts
	switch e.Type {
	case model.ElementStaticSelect, model.ElementRadioButtons:
		if e.InitialOption != nil {
			o, ok := optionByValue(opts, e.InitialOption.Value)
			if !ok {
				return invalidBlocks("%s: initial_option isn't one of the options", at)
			}
			out.InitialOption = &o
		}
	case model.ElementMultiStaticSelect, model.ElementCheckboxes:
		if e.Type == model.ElementMultiStaticSelect {
			if err := maxSelected(at, e.MaxSelectedItems); err != nil {
				return err
			}
			out.MaxSelectedItems = e.MaxSelectedItems
		}
		for _, io := range e.InitialOptions {
			o, ok := optionByValue(opts, io.Value)
			if !ok {
				return invalidBlocks("%s: initial_options names a value that isn't an option", at)
			}
			out.InitialOptions = append(out.InitialOptions, o)
		}
	}
	return nil
}

func maxSelected(at string, n int) error {
	if n < 0 || n > maxSelectedItemsLimit {
		return invalidBlocks("%s: max_selected_items must be between 1 and %d", at, maxSelectedItemsLimit)
	}
	return nil
}

// numberSettings checks a number field: its bounds and starting value are
// numbers of the kind it takes (whole, unless decimals are allowed).
func numberSettings(at string, e model.BlockElement, out *model.BlockElement) error {
	var minV, maxV *float64
	for _, b := range []struct {
		name, raw string
		into      **float64
	}{{"min_value", e.MinValue, &minV}, {"max_value", e.MaxValue, &maxV}} {
		if b.raw == "" {
			continue
		}
		v, ok := parseNumber(b.raw, e.IsDecimalAllowed)
		if !ok {
			return invalidBlocks("%s: %s isn't a %s", at, b.name, numberKind(e.IsDecimalAllowed))
		}
		*b.into = &v
	}
	if minV != nil && maxV != nil && *minV > *maxV {
		return invalidBlocks("%s: min_value is more than max_value", at)
	}
	if e.InitialValue != "" {
		v, ok := parseNumber(e.InitialValue, e.IsDecimalAllowed)
		if !ok || (minV != nil && v < *minV) || (maxV != nil && v > *maxV) {
			return invalidBlocks("%s: initial_value isn't a %s within the bounds", at, numberKind(e.IsDecimalAllowed))
		}
	}
	out.IsDecimalAllowed, out.MinValue, out.MaxValue, out.InitialValue = e.IsDecimalAllowed, e.MinValue, e.MaxValue, e.InitialValue
	return nil
}

func numberKind(decimal bool) string {
	if decimal {
		return "number"
	}
	return "whole number"
}

// parseNumber reads a plain decimal number — no exponents, hex, infinities
// or NaN, which ParseFloat would otherwise take.
func parseNumber(raw string, decimal bool) (float64, bool) {
	s := strings.TrimSpace(raw)
	if s == "" || len(s) > 32 {
		return 0, false
	}
	digits, dot := 0, false
	for i, r := range s {
		switch {
		case r >= '0' && r <= '9':
			digits++
		case r == '-' && i == 0:
		case r == '.' && decimal && !dot:
			dot = true
		default:
			return 0, false
		}
	}
	if digits == 0 {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	return v, err == nil
}

func isEmail(s string) bool {
	if len(s) > 320 {
		return false
	}
	a, err := mail.ParseAddress(s)
	return err == nil && a.Name == "" && a.Address == s
}

// optionList checks a list of options: text (markdown only where rich),
// unique non-blank values, an optional description (rich only), and a link
// only on an overflow menu's options.
func (n *blockNormalizer) optionList(at string, in []model.SelectOption, limit int, rich, links bool) ([]model.SelectOption, error) {
	if len(in) == 0 || len(in) > limit {
		return nil, invalidBlocks("%s: needs between 1 and %d options", at, limit)
	}
	out := make([]model.SelectOption, 0, len(in))
	seen := map[string]bool{}
	for i, o := range in {
		oat := fmt.Sprintf("%s.options[%d]", at, i)
		// A blank value can never be chosen: a submission's empty is "none".
		if strings.TrimSpace(o.Text.Text) == "" || strings.TrimSpace(o.Value) == "" {
			return nil, invalidBlocks("%s: an option needs text and a value", oat)
		}
		if utf8.RuneCountInString(o.Value) > maxOptionValueChars {
			return nil, invalidBlocks("%s: value is longer than %d characters", oat, maxOptionValueChars)
		}
		if seen[o.Value] {
			return nil, invalidBlocks("%s: value %q is used twice", oat, o.Value)
		}
		seen[o.Value] = true
		t, err := n.text(oat+".text", o.Text, maxOptionTextChars, !rich)
		if err != nil {
			return nil, err
		}
		opt := model.SelectOption{Text: t, Value: o.Value}
		if o.Description != nil && strings.TrimSpace(o.Description.Text) != "" {
			if !rich {
				return nil, invalidBlocks("%s: only checkboxes and radio buttons have descriptions", oat)
			}
			d, err := n.text(oat+".description", *o.Description, maxOptionDescChars, false)
			if err != nil {
				return nil, err
			}
			opt.Description = &d
		}
		if o.URL != "" {
			if !links {
				return nil, invalidBlocks("%s: only an overflow menu's options can open a link", oat)
			}
			if len(o.URL) > maxButtonURLChars || !isWebURL(o.URL) {
				return nil, invalidBlocks("%s: url must be an http or https address", oat)
			}
			opt.URL = o.URL
		}
		out = append(out, opt)
	}
	return out, nil
}

// resolveUsers turns a list of ex user IDs or emails into user IDs, each
// one a real user.
func (n *blockNormalizer) resolveUsers(ctx context.Context, at string, refs []string) ([]string, error) {
	var ids []string
	for _, ref := range refs {
		id, seen := n.resolved[ref]
		if !seen {
			if len(n.resolved) >= maxAllowedUserLookups {
				return nil, invalidBlocks("%s: names more than %d people across the message", at, maxAllowedUserLookups)
			}
			id = n.user(ctx, strings.TrimSpace(ref))
			n.resolved[ref] = id
		}
		if id == "" {
			// Which entry isn't said: the answer would tell anyone holding the
			// webhook URL whether an address belongs to someone here.
			return nil, invalidBlocks("%s: names someone who isn't an ex user", at)
		}
		ids = append(ids, id)
	}
	return ids, nil
}

// image checks an image: an http(s) address and alt text. ex proxies it
// (and measures it) before anyone sees it, so no client ever loads the
// app's own server.
func (n *blockNormalizer) image(at, rawURL, alt string) (string, string, error) {
	if n.images++; n.images > maxImages {
		return "", "", invalidBlocks("%s: a message or form can hold at most %d images", at, maxImages)
	}
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" || len(rawURL) > maxButtonURLChars || !isWebURL(rawURL) {
		return "", "", invalidBlocks("%s: image_url must be an http or https address", at)
	}
	alt = strings.TrimSpace(alt)
	if alt == "" || utf8.RuneCountInString(alt) > maxAltTextChars {
		return "", "", invalidBlocks("%s: an image needs alt_text of at most %d characters", at, maxAltTextChars)
	}
	return rawURL, alt, nil
}

// imageElement is a small picture in a section's accessory or a context row.
func (n *blockNormalizer) imageElement(at string, e model.BlockElement) (model.BlockElement, error) {
	u, alt, err := n.image(at, e.ImageURL, e.AltText)
	if err != nil {
		return model.BlockElement{}, err
	}
	return model.BlockElement{Type: model.ElementImage, ImageURL: u, AltText: alt}, nil
}

// imageBlock is a picture on its own, with an optional plain title.
func (n *blockNormalizer) imageBlock(at string, b model.Block, out *model.Block) error {
	u, alt, err := n.image(at, b.ImageURL, b.AltText)
	if err != nil {
		return err
	}
	out.ImageURL, out.AltText = u, alt
	if b.Text != nil && strings.TrimSpace(b.Text.Text) != "" {
		t, err := n.text(at+".title", *b.Text, maxImageTitleChars, true)
		if err != nil {
			return err
		}
		out.Text = &t
	}
	return nil
}
