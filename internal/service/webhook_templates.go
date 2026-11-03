package service

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/model"
)

// Template limits. A filled template is then checked like any post, so these
// only bound the work of filling one.
const (
	maxTemplates          = 10
	maxTemplateBytes      = 16 << 10
	maxTemplatePlaceholds = 200
	maxTemplateData       = 50
	maxTemplateValueChars = 4000
	maxFilledTemplate     = 1 << 20
)

var (
	templateKeyPattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,39}$`)
	templateDataKey     = regexp.MustCompile(`^[A-Za-z0-9_]{1,40}$`)
	placeholderPattern  = regexp.MustCompile(`\{\{\s*([A-Za-z0-9_]{1,40})\s*\}\}`)
	wholePlaceholderPat = regexp.MustCompile(`^\{\{\s*([A-Za-z0-9_]{1,40})\s*\}\}$`)
)

// ErrTemplateNotFound: no template by that key on the webhook.
var ErrTemplateNotFound = apperr.Reject(apperr.ErrNotFound, "no template by that name on this webhook")

// SaveTemplate adds or replaces a rich webhook's template. The payload must be
// a JSON object; placeholders are checked when the template is used, against
// the data the app sends.
func (s *IncomingWebhookService) SaveTemplate(ctx context.Context, actor WebhookActor, id, key string, payload json.RawMessage) (*model.IncomingWebhook, error) {
	wh, err := s.templatesOf(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	if !templateKeyPattern.MatchString(key) {
		return nil, apperr.Invalid("webhook: a template's name is lowercase letters, digits, - and _, at most 40")
	}
	if len(payload) > maxTemplateBytes {
		return nil, apperr.Invalid("webhook: a template is at most %d KB", maxTemplateBytes>>10)
	}
	var tree map[string]any
	if err := json.Unmarshal(payload, &tree); err != nil || tree == nil {
		return nil, apperr.Invalid("webhook: a template is a JSON object: a webhook payload")
	}
	if n := len(placeholderPattern.FindAllIndex(payload, -1)); n > maxTemplatePlaceholds {
		return nil, apperr.Invalid("webhook: a template holds at most %d placeholders", maxTemplatePlaceholds)
	}
	compact, _ := json.Marshal(tree)
	saved := model.MessageTemplate{Key: key, Payload: compact, UpdatedAt: time.Now().UTC()}
	if t := wh.Template(key); t != nil {
		*t = saved
	} else {
		if len(wh.Templates) >= maxTemplates {
			return nil, apperr.Invalid("webhook: a webhook holds at most %d templates", maxTemplates)
		}
		wh.Templates = append(wh.Templates, saved)
	}
	return s.saveTemplates(ctx, wh)
}

// DeleteTemplate removes a rich webhook's template.
func (s *IncomingWebhookService) DeleteTemplate(ctx context.Context, actor WebhookActor, id, key string) (*model.IncomingWebhook, error) {
	wh, err := s.templatesOf(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	if wh.Template(key) == nil {
		return nil, ErrTemplateNotFound
	}
	wh.Templates = slices.DeleteFunc(wh.Templates, func(t model.MessageTemplate) bool { return t.Key == key })
	return s.saveTemplates(ctx, wh)
}

// templatesOf is the webhook whose templates the actor may manage: theirs
// (or any, for an admin), and rich — a classic webhook has no templates.
func (s *IncomingWebhookService) templatesOf(ctx context.Context, actor WebhookActor, id string) (*model.IncomingWebhook, error) {
	if err := actor.check(); err != nil {
		return nil, err
	}
	wh, err := s.owned(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	if !wh.IsRich() {
		return nil, apperr.Reject(ErrNotRichWebhook, "templates are for rich webhooks")
	}
	return wh, nil
}

func (s *IncomingWebhookService) saveTemplates(ctx context.Context, wh *model.IncomingWebhook) (*model.IncomingWebhook, error) {
	wh.UpdatedAt = time.Now()
	if err := s.store.Update(ctx, wh); err != nil {
		return nil, fmt.Errorf("webhook: save templates: %w", err)
	}
	s.publishChanged(ctx)
	return wh.Present(), nil
}

// fillTemplate turns a post that names a template into the post itself: the
// template's payload with every {{name}} replaced from data. Values go into
// strings the template already holds — after parsing — so data can never add
// JSON of its own. A string that is just "{{name}}" takes the value with its
// type (a number stays a number). The request still chooses where the post
// goes (channel, root_id); the template chooses everything else.
func fillTemplate(wh *model.IncomingWebhook, in IncomingWebhookPayload) (IncomingWebhookPayload, error) {
	tpl := wh.Template(in.Template)
	if tpl == nil {
		return in, apperr.Invalid("webhook: no template named %q on this webhook", in.Template)
	}
	if len(in.Data) > maxTemplateData {
		return in, apperr.Invalid("webhook: data holds at most %d values", maxTemplateData)
	}
	for k, v := range in.Data {
		if !templateDataKey.MatchString(k) {
			return in, apperr.Invalid("webhook: data names are letters, digits and _, at most 40")
		}
		switch v := v.(type) {
		case string:
			if utf8.RuneCountInString(v) > maxTemplateValueChars {
				return in, apperr.Invalid("webhook: data.%s is longer than %d characters", k, maxTemplateValueChars)
			}
		case float64, bool:
		default:
			return in, apperr.Invalid("webhook: data.%s must be text, a number or true/false", k)
		}
	}
	var tree any
	_ = json.Unmarshal(tpl.Payload, &tree) // saved by SaveTemplate: always an object
	filled, err := fillValue(tree, in.Data, in.Template)
	if err != nil {
		return in, err
	}
	raw, _ := json.Marshal(filled)
	if len(raw) > maxFilledTemplate {
		return in, apperr.Invalid("webhook: template %q filled is over 1 MB", in.Template)
	}
	var out IncomingWebhookPayload
	if err := json.Unmarshal(raw, &out); err != nil {
		return in, apperr.Invalid("webhook: template %q filled isn't a valid message: %s", in.Template, err.Error())
	}
	if in.Channel != "" {
		out.Channel = in.Channel
	}
	if in.RootID != "" {
		out.RootID = in.RootID
	}
	out.BotToken, out.Template, out.Data = in.BotToken, "", nil
	return out, nil
}

func fillValue(v any, data map[string]any, name string) (any, error) {
	switch t := v.(type) {
	case string:
		if m := wholePlaceholderPat.FindStringSubmatch(t); m != nil {
			val, ok := data[m[1]]
			if !ok {
				return nil, missingData(name, m[1])
			}
			return val, nil
		}
		var missing string
		out := placeholderPattern.ReplaceAllStringFunc(t, func(p string) string {
			key := placeholderPattern.FindStringSubmatch(p)[1]
			val, ok := data[key]
			if !ok {
				missing = key
				return ""
			}
			return templateText(val)
		})
		if missing != "" {
			return nil, missingData(name, missing)
		}
		return out, nil
	case []any:
		for i := range t {
			f, err := fillValue(t[i], data, name)
			if err != nil {
				return nil, err
			}
			t[i] = f
		}
		return t, nil
	case map[string]any:
		for k := range t {
			f, err := fillValue(t[k], data, name)
			if err != nil {
				return nil, err
			}
			t[k] = f
		}
		return t, nil
	default:
		return v, nil
	}
}

func missingData(name, key string) error {
	return apperr.Invalid("webhook: template %q needs data.%s", name, key)
}

// templateText is a data value as it reads inside text.
func templateText(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	default:
		return strconv.FormatBool(t.(bool))
	}
}
