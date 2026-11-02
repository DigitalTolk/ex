package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
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
	out := model.View{Type: model.ViewModal, CallbackID: in.CallbackID, PrivateMetadata: in.PrivateMetadata, ExternalID: in.ExternalID, NotifyOnClose: in.NotifyOnClose}
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
			nb, err = n.input(ctx, at, b)
			inputs++
		} else {
			nb, keep, err = n.block(ctx, at, b)
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

// input checks one form field: its label and hint, and its element.
func (n *blockNormalizer) input(ctx context.Context, at string, b model.Block) (model.Block, error) {
	if b.Label == nil || strings.TrimSpace(b.Label.Text) == "" {
		return model.Block{}, invalidView("%s: a field needs a label", at)
	}
	label, err := n.text(at+".label", *b.Label, maxLabelChars, true)
	if err != nil {
		return model.Block{}, err
	}
	out := model.Block{Type: model.BlockInput, Label: &label, Optional: b.Optional, DispatchAction: b.DispatchAction}
	if b.Hint != nil && strings.TrimSpace(b.Hint.Text) != "" {
		hint, err := n.text(at+".hint", *b.Hint, maxLabelChars, true)
		if err != nil {
			return model.Block{}, err
		}
		out.Hint = &hint
	}
	if b.Element == nil || !model.IsInputType(b.Element.Type) {
		return model.Block{}, invalidView("%s: a field needs an input element (text, number, email, url, date, time, select, users, checkboxes or radio buttons)", at)
	}
	el, err := n.valueElement(ctx, at+".element", *b.Element, placeInput)
	if err != nil {
		return model.Block{}, err
	}
	out.Element = &el
	if out.BlockID, err = n.blockID(at, b.BlockID); err != nil {
		return model.Block{}, err
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
