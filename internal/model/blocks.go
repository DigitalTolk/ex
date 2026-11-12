package model

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// Block kinds a message can carry (Slack's Block Kit, the subset ex draws).
// The service layer drops any other kind when it normalizes a payload.
const (
	BlockSection = "section"
	BlockActions = "actions"
	BlockContext = "context"
	BlockDivider = "divider"
	BlockHeader  = "header"
	// BlockInput is a form field: a label, an optional hint, and one input
	// element. Forms (views) only; a message drops it.
	BlockInput = "input"
	// BlockImage is a picture with alt text and an optional title, drawn
	// through ex's image proxy.
	BlockImage = "image"
	// BlockRichText is formatted text built from parts rather than markdown:
	// paragraphs, headings, lists, quotes and code (Content), with styled
	// pieces — bold, colours, links, mentions, dates, pills — in each.
	BlockRichText = "rich_text"
	// BlockCallout is rich text in a tinted box with an emoji: a note, a
	// warning, a tip.
	BlockCallout = "callout"
	// BlockToggle is a summary line people click to show the blocks under it
	// (logs, details) — kept out of the way until wanted.
	BlockToggle = "toggle"
	// BlockTable is rows and columns of rich text: status matrices, rotas.
	BlockTable = "table"
	// BlockColumns lays 2 or 3 column blocks side by side (stacked when
	// narrow); BlockColumn is one of them, holding its own blocks.
	BlockColumns = "columns"
	BlockColumn  = "column"
	// BlockChart is a bar, line or donut chart ex draws from the app's
	// numbers — no image, nothing fetched.
	BlockChart = "chart"
)

// Chart kinds.
const (
	ChartBar   = "bar"
	ChartLine  = "line"
	ChartDonut = "donut"
)

// ChartSeries is one named series of a chart: a value per label.
type ChartSeries struct {
	Name   string    `json:"name,omitempty"`
	Values []float64 `json:"values"`
}

// IsColumnChild reports whether a block of kind t may sit in a column: the
// toggle's text-only kinds plus headers, callouts and charts — no buttons,
// pickers, images or further nesting.
func IsColumnChild(t string) bool {
	switch t {
	case BlockHeader, BlockCallout, BlockChart:
		return true
	}
	return IsToggleChild(t)
}

// IsToggleChild reports whether a block of kind t may sit inside a toggle:
// text only — no buttons, pickers or images, so what a click reaches and
// which images ex fetches stay in the message's top level.
func IsToggleChild(t string) bool {
	switch t {
	case BlockRichText, BlockTable, BlockDivider, BlockSection, BlockContext:
		return true
	}
	return false
}

// Table column alignments.
const (
	AlignLeft   = "left"
	AlignCenter = "center"
	AlignRight  = "right"
)

// TableColumn is a table's column: its plain header (may be empty) and how
// its cells align.
type TableColumn struct {
	Header string `json:"header,omitempty"`
	Align  string `json:"align,omitempty"`
}

// TableCell is one cell: rich text pieces. On the way in, Text is a plain
// shorthand for a single text piece; ex stores Spans.
type TableCell struct {
	Text  string     `json:"text,omitempty"`
	Spans []RichSpan `json:"spans,omitempty"`
}

// Rich text nodes: the paragraph-level parts of a rich_text block.
const (
	RichParagraph = "paragraph"
	RichHeading   = "heading"
	RichList      = "list"
	RichQuote     = "quote"
	RichCode      = "code"
)

// Rich text spans: the inline pieces of a paragraph, heading, quote or list
// item. A span with no type is text.
const (
	RichSpanText    = "text"
	RichSpanUser    = "user"
	RichSpanChannel = "channel"
	RichSpanEmoji   = "emoji"
	RichSpanDate    = "date"
	RichSpanPill    = "pill"
)

// List styles.
const (
	RichListBullet  = "bullet"
	RichListOrdered = "ordered"
)

// RichColors are the colours a span's text, highlight or a pill may take —
// names, never CSS, so an app can't style ex beyond the palette. The client
// maps each to a theme token for light and dark. (No pink: that is ex's
// brand accent, kept for unread and calls to action.)
var RichColors = []string{"gray", "brown", "orange", "yellow", "green", "blue", "purple", "red"}

// IsRichColor reports whether c names a palette colour.
func IsRichColor(c string) bool {
	for _, k := range RichColors {
		if k == c {
			return true
		}
	}
	return false
}

// RichNode is one paragraph-level part of a rich_text block:
//   - paragraph, quote: Spans.
//   - heading: Spans and a Level, 1 to 3.
//   - list: Items (each may hold Items of its own) and a Style, bullet or
//     ordered.
//   - code: Text, and an optional Language for highlighting.
type RichNode struct {
	Type     string     `json:"type"`
	Level    int        `json:"level,omitempty"`
	Style    string     `json:"style,omitempty"`
	Spans    []RichSpan `json:"spans,omitempty"`
	Items    []RichItem `json:"items,omitempty"`
	Language string     `json:"language,omitempty"`
	Text     string     `json:"text,omitempty"`
}

// RichItem is one list item: its text, and the items nested under it.
type RichItem struct {
	Spans []RichSpan `json:"spans,omitempty"`
	Items []RichItem `json:"items,omitempty"`
}

// RichSpan is an inline piece of rich text.
//   - text: Text, styled by Bold … Code, Color and Highlight; Link makes it a
//     link (http, https or mailto).
//   - user, channel: a mention. The app names it (User: an ID or an email;
//     Channel: a name or an ID); ex stores the ID it resolved to, with Name
//     (the person's display name, the channel's slug) for drawing.
//   - emoji: Name, like "rocket".
//   - date: Timestamp (Unix seconds) shown in each reader's own time zone
//     through Format's {date_short}, {date}, {date_long} and {time}, with
//     Fallback for places that can't.
//   - pill: Text in a small coloured label (Color).
type RichSpan struct {
	Type      string `json:"type,omitempty"`
	Text      string `json:"text,omitempty"`
	Bold      bool   `json:"bold,omitempty"`
	Italic    bool   `json:"italic,omitempty"`
	Strike    bool   `json:"strike,omitempty"`
	Underline bool   `json:"underline,omitempty"`
	Code      bool   `json:"code,omitempty"`
	Color     string `json:"color,omitempty"`
	Highlight string `json:"highlight,omitempty"`
	Link      string `json:"link,omitempty"`
	User      string `json:"user,omitempty"`
	Channel   string `json:"channel,omitempty"`
	Name      string `json:"name,omitempty"`
	Timestamp int64  `json:"timestamp,omitempty"`
	Format    string `json:"format,omitempty"`
	Fallback  string `json:"fallback,omitempty"`
}

// Text kinds. "mrkdwn" is accepted from Slack-shaped payloads and stored as
// "markdown": both mean ex markdown (**bold**), not Slack's *bold*.
const (
	TextPlain    = "plain_text"
	TextMarkdown = "markdown"
	TextMrkdwn   = "mrkdwn"
)

// ElementButton is a button: a link, a built-in action, or a call to the app.
const ElementButton = "button"

// ElementImage is a small picture: a section's accessory or a context row's.
const ElementImage = "image"

// Elements that take a value. Each one can sit in a form field; the ones
// IsMessageInteractive names can also sit in a message's actions row or a
// section's accessory, where using them calls the app.
const (
	ElementPlainTextInput    = "plain_text_input"
	ElementNumberInput       = "number_input"
	ElementEmailInput        = "email_text_input"
	ElementURLInput          = "url_text_input"
	ElementDatepicker        = "datepicker"
	ElementTimepicker        = "timepicker"
	ElementStaticSelect      = "static_select"
	ElementMultiStaticSelect = "multi_static_select"
	ElementUsersSelect       = "users_select"
	ElementMultiUsersSelect  = "multi_users_select"
	ElementCheckboxes        = "checkboxes"
	ElementRadioButtons      = "radio_buttons"
	// ElementOverflow is a ⋯ menu of up to five options (messages only).
	ElementOverflow = "overflow"
)

// IsInputType reports whether t names an element a form field can hold.
func IsInputType(t string) bool {
	switch t {
	case ElementPlainTextInput, ElementNumberInput, ElementEmailInput, ElementURLInput,
		ElementDatepicker, ElementTimepicker, ElementStaticSelect, ElementMultiStaticSelect,
		ElementUsersSelect, ElementMultiUsersSelect, ElementCheckboxes, ElementRadioButtons:
		return true
	}
	return false
}

// IsMessageInteractive reports whether t names an element a message can
// carry besides buttons: a pick that goes to the app.
func IsMessageInteractive(t string) bool {
	switch t {
	case ElementStaticSelect, ElementMultiStaticSelect, ElementUsersSelect, ElementOverflow,
		ElementDatepicker, ElementTimepicker, ElementCheckboxes, ElementRadioButtons:
		return true
	}
	return false
}

// IsMultiValue reports whether t's value is a list.
func IsMultiValue(t string) bool {
	return t == ElementMultiStaticSelect || t == ElementMultiUsersSelect || t == ElementCheckboxes
}

// SelectOption is one choice of a select, overflow menu, checkbox or radio
// group. Description is a second line (checkboxes and radios); URL makes an
// overflow option open a link (http or https only).
type SelectOption struct {
	Text        TextObject  `json:"text"`
	Value       string      `json:"value"`
	Description *TextObject `json:"description,omitempty"`
	URL         string      `json:"url,omitempty"`
}

// Button styles.
const (
	ButtonPrimary = "primary"
	ButtonDanger  = "danger"
)

// Built-in actions: buttons ex handles itself, with no app server.
const (
	// ExActionAck records who acknowledged first; the button gives way to
	// "Acknowledged by …".
	ExActionAck = "ack"
	// ExActionVote toggles the clicker's vote and shows the count.
	ExActionVote = "vote"
)

// TextObject is a piece of text in a block: plain, or ex markdown.
type TextObject struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// ConfirmDialog asks before a button's click is sent. All four texts are
// plain text.
type ConfirmDialog struct {
	Title   TextObject `json:"title"`
	Text    TextObject `json:"text"`
	Confirm TextObject `json:"confirm"`
	Deny    TextObject `json:"deny"`
}

// BlockElement is a button (in an actions row or a section's accessory) or a
// text element (in a context row). On the wire a text element carries its
// text as a plain string — {"type":"markdown","text":"…"} — while a button's
// label is a TextObject; Content holds a text element's string.
type BlockElement struct {
	Type string `json:"type"`
	// Text is a button's label; on the wire a text element's text (Content)
	// takes its place as a plain string.
	Text     *TextObject    `json:"text,omitempty" tstype:"TextObject | string"`
	ActionID string         `json:"action_id,omitempty"`
	Value    string         `json:"value,omitempty"`
	Style    string         `json:"style,omitempty"`
	URL      string         `json:"url,omitempty"`
	Confirm  *ConfirmDialog `json:"confirm,omitempty"`
	// AllowedUsers are the ex user IDs that may see and click the button
	// (resolved from the emails or IDs the app gave). Empty: everyone who can
	// see the message.
	AllowedUsers []string `json:"allowed_users,omitempty"`
	// ExAction makes the button a built-in action (ExActionAck, ExActionVote).
	ExAction string `json:"ex_action,omitempty"`
	// Input elements (forms only): placeholder for all three; Multiline,
	// InitialValue and Min/MaxLength for text; InitialDate (YYYY-MM-DD) for
	// a date; Options and InitialOption for a select.
	Placeholder   *TextObject    `json:"placeholder,omitempty"`
	Multiline     bool           `json:"multiline,omitempty"`
	InitialValue  string         `json:"initial_value,omitempty"`
	MinLength     int            `json:"min_length,omitempty"`
	MaxLength     int            `json:"max_length,omitempty"`
	InitialDate   string         `json:"initial_date,omitempty"`
	Options       []SelectOption `json:"options,omitempty"`
	InitialOption *SelectOption  `json:"initial_option,omitempty"`
	// More value elements: InitialOptions (multi-select, checkboxes),
	// InitialTime (HH:MM), InitialUser(s) (ex user IDs), MaxSelectedItems
	// (multi-selects), and a number field's IsDecimalAllowed and Min/Max
	// (decimal strings, as Slack has them).
	InitialOptions   []SelectOption `json:"initial_options,omitempty"`
	InitialTime      string         `json:"initial_time,omitempty"`
	InitialUser      string         `json:"initial_user,omitempty"`
	InitialUsers     []string       `json:"initial_users,omitempty"`
	MaxSelectedItems int            `json:"max_selected_items,omitempty"`
	IsDecimalAllowed bool           `json:"is_decimal_allowed,omitempty"`
	MinValue         string         `json:"min_value,omitempty"`
	MaxValue         string         `json:"max_value,omitempty"`
	// An image element: its proxied URL, alt text and (once ex has fetched
	// it) intrinsic size.
	ImageURL    string `json:"image_url,omitempty"`
	AltText     string `json:"alt_text,omitempty"`
	ImageWidth  int    `json:"image_width,omitempty"`
	ImageHeight int    `json:"image_height,omitempty"`
	// Content is a text element's text.
	Content string `json:"-"`
}

// IsText reports whether e is a text element rather than a button.
func (e BlockElement) IsText() bool { return IsTextType(e.Type) }

// IsTextType reports whether t names a text kind.
func IsTextType(t string) bool { return t == TextPlain || t == TextMarkdown || t == TextMrkdwn }

// blockElementJSON is BlockElement's wire shape; its text's shape depends on
// the kind (a string, or a TextObject).
type blockElementJSON struct {
	Type         string         `json:"type"`
	Text         any            `json:"text,omitempty"`
	ActionID     string         `json:"action_id,omitempty"`
	Value        string         `json:"value,omitempty"`
	Style        string         `json:"style,omitempty"`
	URL          string         `json:"url,omitempty"`
	Confirm      *ConfirmDialog `json:"confirm,omitempty"`
	AllowedUsers []string       `json:"allowed_users,omitempty"`
	ExAction     string         `json:"ex_action,omitempty"`

	Placeholder   *TextObject    `json:"placeholder,omitempty"`
	Multiline     bool           `json:"multiline,omitempty"`
	InitialValue  string         `json:"initial_value,omitempty"`
	MinLength     int            `json:"min_length,omitempty"`
	MaxLength     int            `json:"max_length,omitempty"`
	InitialDate   string         `json:"initial_date,omitempty"`
	Options       []SelectOption `json:"options,omitempty"`
	InitialOption *SelectOption  `json:"initial_option,omitempty"`

	InitialOptions   []SelectOption `json:"initial_options,omitempty"`
	InitialTime      string         `json:"initial_time,omitempty"`
	InitialUser      string         `json:"initial_user,omitempty"`
	InitialUsers     []string       `json:"initial_users,omitempty"`
	MaxSelectedItems int            `json:"max_selected_items,omitempty"`
	IsDecimalAllowed bool           `json:"is_decimal_allowed,omitempty"`
	MinValue         string         `json:"min_value,omitempty"`
	MaxValue         string         `json:"max_value,omitempty"`
	ImageURL         string         `json:"image_url,omitempty"`
	AltText          string         `json:"alt_text,omitempty"`
	ImageWidth       int            `json:"image_width,omitempty"`
	ImageHeight      int            `json:"image_height,omitempty"`
}

// elementJSON is e's wire shape, but for its text.
func (e BlockElement) elementJSON() blockElementJSON {
	return blockElementJSON{
		Type: e.Type, ActionID: e.ActionID, Value: e.Value, Style: e.Style, URL: e.URL,
		Confirm: e.Confirm, AllowedUsers: e.AllowedUsers, ExAction: e.ExAction,
		Placeholder: e.Placeholder, Multiline: e.Multiline, InitialValue: e.InitialValue,
		MinLength: e.MinLength, MaxLength: e.MaxLength, InitialDate: e.InitialDate,
		Options: e.Options, InitialOption: e.InitialOption,
		InitialOptions: e.InitialOptions, InitialTime: e.InitialTime, InitialUser: e.InitialUser,
		InitialUsers: e.InitialUsers, MaxSelectedItems: e.MaxSelectedItems, IsDecimalAllowed: e.IsDecimalAllowed,
		MinValue: e.MinValue, MaxValue: e.MaxValue, ImageURL: e.ImageURL, AltText: e.AltText,
		ImageWidth: e.ImageWidth, ImageHeight: e.ImageHeight,
	}
}

// MarshalJSON writes a text element's text as a string, a button's as a
// TextObject.
func (e BlockElement) MarshalJSON() ([]byte, error) {
	out := e.elementJSON()
	if e.IsText() {
		out.Text = e.Content
	} else if e.Text != nil {
		out.Text = e.Text
	}
	return json.Marshal(out)
}

// UnmarshalJSON reads either shape of text (see MarshalJSON).
func (e *BlockElement) UnmarshalJSON(data []byte) error {
	var in struct {
		blockElementJSON
		Text json.RawMessage `json:"text,omitempty"`
	}
	if err := json.Unmarshal(data, &in); err != nil {
		return err
	}
	j := in.blockElementJSON
	*e = BlockElement{
		Type: j.Type, ActionID: j.ActionID, Value: j.Value, Style: j.Style, URL: j.URL,
		Confirm: j.Confirm, AllowedUsers: j.AllowedUsers, ExAction: j.ExAction,
		Placeholder: j.Placeholder, Multiline: j.Multiline, InitialValue: j.InitialValue,
		MinLength: j.MinLength, MaxLength: j.MaxLength, InitialDate: j.InitialDate,
		Options: j.Options, InitialOption: j.InitialOption,
		InitialOptions: j.InitialOptions, InitialTime: j.InitialTime, InitialUser: j.InitialUser,
		InitialUsers: j.InitialUsers, MaxSelectedItems: j.MaxSelectedItems, IsDecimalAllowed: j.IsDecimalAllowed,
		MinValue: j.MinValue, MaxValue: j.MaxValue, ImageURL: j.ImageURL, AltText: j.AltText,
		ImageWidth: j.ImageWidth, ImageHeight: j.ImageHeight,
	}
	if len(in.Text) == 0 || string(in.Text) == "null" {
		return nil
	}
	if e.IsText() {
		return json.Unmarshal(in.Text, &e.Content)
	}
	e.Text = &TextObject{}
	return json.Unmarshal(in.Text, e.Text)
}

// Block is one piece of a message's layout.
//   - section: Text and/or Fields, and an optional Accessory button.
//   - actions: a row of buttons (Elements).
//   - context: small text (Elements are text elements).
//   - divider: a rule.
//   - header: Text, plain.
//   - input (forms only): Label, an optional Hint, Optional, and one
//     input Element; DispatchAction sends each change to the app.
//   - image: ImageURL, AltText, an optional plain Title (Text), and the
//     intrinsic size ex measured.
//   - rich_text: Content, its paragraph-level parts.
//   - callout: Content in a box tinted Color, with an Icon (an emoji name).
//   - toggle: Summary (rich text pieces) over child Blocks (text-only kinds,
//     see IsToggleChild), shown when opened; Open starts it open.
//   - table: Columns and Rows of cells.
//   - columns: child column Blocks; column: a Width (1 to 3, a share of the
//     row) and its own Blocks (see IsColumnChild).
//   - chart: a Kind (bar, line, donut), an optional plain title (Text),
//     Labels, Series (a value per label) and a Unit for its numbers.
type Block struct {
	Type      string         `json:"type"`
	BlockID   string         `json:"block_id,omitempty"`
	Text      *TextObject    `json:"text,omitempty"`
	Fields    []TextObject   `json:"fields,omitempty"`
	Accessory *BlockElement  `json:"accessory,omitempty"`
	Elements  []BlockElement `json:"elements,omitempty"`
	Label     *TextObject    `json:"label,omitempty"`
	Hint      *TextObject    `json:"hint,omitempty"`
	Optional  bool           `json:"optional,omitempty"`
	Element   *BlockElement  `json:"element,omitempty"`
	// DispatchAction (input only) sends the field's changes to the app as
	// they happen, so it can reshape the form.
	DispatchAction bool `json:"dispatch_action,omitempty"`
	// Image block.
	ImageURL    string `json:"image_url,omitempty"`
	AltText     string `json:"alt_text,omitempty"`
	ImageWidth  int    `json:"image_width,omitempty"`
	ImageHeight int    `json:"image_height,omitempty"`
	// Rich text, callout.
	Content []RichNode `json:"content,omitempty"`
	Icon    string     `json:"icon,omitempty"`
	Color   string     `json:"color,omitempty"`
	// Toggle.
	Summary []RichSpan `json:"summary,omitempty"`
	Blocks  Blocks     `json:"blocks,omitempty"`
	Open    bool       `json:"open,omitempty"`
	// Table.
	Columns []TableColumn `json:"columns,omitempty"`
	Rows    [][]TableCell `json:"rows,omitempty"`
	// Column.
	Width int `json:"width,omitempty"`
	// Chart.
	Kind   string        `json:"kind,omitempty"`
	Labels []string      `json:"labels,omitempty"`
	Series []ChartSeries `json:"series,omitempty"`
	Unit   string        `json:"unit,omitempty"`
}

// Blocks is a message's (or an attachment's) layout. DynamoDB stores it as
// one JSON string: a nested list of maps of every block and element would
// cost far more item size and marshal time, and nothing queries into it.
type Blocks []Block

// MarshalDynamoDBAttributeValue stores the blocks as a JSON string; none as
// NULL, which `omitempty` leaves out of the item.
func (b Blocks) MarshalDynamoDBAttributeValue() (types.AttributeValue, error) {
	if len(b) == 0 {
		return &types.AttributeValueMemberNULL{Value: true}, nil
	}
	// Blocks are plain data: marshalling them can't fail.
	raw, err := json.Marshal([]Block(b))
	return &types.AttributeValueMemberS{Value: string(raw)}, err
}

// UnmarshalDynamoDBAttributeValue reads what MarshalDynamoDBAttributeValue
// wrote.
func (b *Blocks) UnmarshalDynamoDBAttributeValue(av types.AttributeValue) error {
	s, ok := av.(*types.AttributeValueMemberS)
	if !ok {
		*b = nil
		return nil
	}
	var out []Block
	if err := json.Unmarshal([]byte(s.Value), &out); err != nil {
		return fmt.Errorf("blocks: unmarshal: %w", err)
	}
	*b = out
	return nil
}

// ActionTally is the state of one built-in action on a message: who
// acknowledged (the first clicker) or who voted, and when it last changed.
type ActionTally struct {
	BlockID  string    `json:"blockID" dynamodbav:"blockID"`
	ActionID string    `json:"actionID" dynamodbav:"actionID"`
	UserIDs  []string  `json:"userIDs" dynamodbav:"userIDs"`
	At       time.Time `json:"at" dynamodbav:"at"`
}

// BlockTexts lists the readable text of a message's blocks and its cards'
// blocks — headers, sections, fields, context and rich text, in order.
// Search indexes it, and a message with blocks but no text stands on it.
func BlockTexts(blocks Blocks, attachments []MessageAttachment) []string {
	var out []string
	var collect func(bs Blocks)
	collect = func(bs Blocks) {
		for _, b := range bs {
			if b.Text != nil {
				out = append(out, b.Text.Text)
			}
			for _, f := range b.Fields {
				out = append(out, f.Text)
			}
			for _, e := range b.Elements {
				if e.IsText() {
					out = append(out, e.Content)
				}
			}
			if len(b.Content) > 0 {
				out = append(out, RichTextPlain(b.Content))
			}
			if len(b.Summary) > 0 {
				out = append(out, RichSpansPlain(b.Summary))
			}
			collect(b.Blocks)
			for _, s := range b.Series {
				if s.Name != "" {
					out = append(out, s.Name)
				}
			}
			for _, row := range b.Rows {
				cells := make([]string, len(row))
				for i, c := range row {
					cells[i] = RichSpansPlain(c.Spans)
				}
				out = append(out, strings.Join(cells, " · "))
			}
		}
	}
	collect(blocks)
	for _, a := range attachments {
		collect(a.Blocks)
	}
	return out
}

// RichTextPlain is rich text as plain lines: list items bulleted or
// numbered, mentions in ex's mention syntax (so a message that stands on
// this text still mentions them), dates as their fallback, emoji by name.
func RichTextPlain(nodes []RichNode) string {
	var b strings.Builder
	line := func(prefix string, spans []RichSpan) {
		if b.Len() > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(prefix)
		b.WriteString(RichSpansPlain(spans))
	}
	var items func(depth int, ordered bool, list []RichItem)
	items = func(depth int, ordered bool, list []RichItem) {
		for i, it := range list {
			marker := "• "
			if ordered {
				marker = strconv.Itoa(i+1) + ". "
			}
			line(strings.Repeat("  ", depth)+marker, it.Spans)
			items(depth+1, ordered, it.Items)
		}
	}
	for _, n := range nodes {
		switch n.Type {
		case RichList:
			items(0, n.Style == RichListOrdered, n.Items)
		case RichCode:
			if b.Len() > 0 {
				b.WriteByte('\n')
			}
			b.WriteString(n.Text)
		case RichQuote:
			line("> ", n.Spans)
		default:
			line("", n.Spans)
		}
	}
	return b.String()
}

func RichSpansPlain(spans []RichSpan) string {
	var b strings.Builder
	for _, s := range spans {
		b.WriteString(richSpanPlain(s))
	}
	return b.String()
}

func richSpanPlain(s RichSpan) string {
	switch s.Type {
	case RichSpanUser:
		return "@[" + s.User + "|" + s.Name + "]"
	case RichSpanChannel:
		return "~[" + s.Channel + "|" + s.Name + "]"
	case RichSpanEmoji:
		return ":" + s.Name + ":"
	case RichSpanDate:
		return s.Fallback
	default:
		return s.Text
	}
}
