package model

import (
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

func sampleBlocks() Blocks {
	return Blocks{
		{Type: BlockHeader, BlockID: "h", Text: &TextObject{Type: TextPlain, Text: "Review"}},
		{Type: BlockSection, BlockID: "s", Text: &TextObject{Type: TextMarkdown, Text: "**A3** due"},
			Accessory: &BlockElement{Type: ElementButton, ActionID: "use", Value: "m:A3", Text: &TextObject{Type: TextPlain, Text: "Use Fri"}}},
		{Type: BlockActions, BlockID: "a", Elements: []BlockElement{
			{Type: ElementButton, ActionID: "ok", Style: ButtonPrimary, ExAction: ExActionAck, AllowedUsers: []string{"u1"},
				Text:    &TextObject{Type: TextPlain, Text: "Ack"},
				Confirm: &ConfirmDialog{Title: TextObject{Type: TextPlain, Text: "Sure?"}}},
		}},
		{Type: BlockContext, BlockID: "c", Elements: []BlockElement{{Type: TextMarkdown, Content: "_via MeetingMind_"}}},
	}
}

func TestBlockElementJSON_TextElementsCarryAStringButtonsAnObject(t *testing.T) {
	raw, err := json.Marshal(sampleBlocks())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(raw)
	if !strings.Contains(s, `{"type":"markdown","text":"_via MeetingMind_"}`) {
		t.Fatalf("context text element not a plain string: %s", s)
	}
	if !strings.Contains(s, `"text":{"type":"plain_text","text":"Use Fri"}`) {
		t.Fatalf("button label not an object: %s", s)
	}
	var back Blocks
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back[3].Elements[0].Content != "_via MeetingMind_" || back[1].Accessory.Text.Text != "Use Fri" {
		t.Fatalf("round trip lost text: %#v", back)
	}
	if back[2].Elements[0].ExAction != ExActionAck || back[2].Elements[0].AllowedUsers[0] != "u1" || back[2].Elements[0].Confirm.Title.Text != "Sure?" {
		t.Fatalf("round trip lost button fields: %#v", back[2])
	}
}

func TestBlockElementJSON_EdgeCases(t *testing.T) {
	var e BlockElement
	// A button without a label, and an explicit null label.
	for _, in := range []string{`{"type":"button","action_id":"x"}`, `{"type":"button","text":null}`} {
		if err := json.Unmarshal([]byte(in), &e); err != nil || e.Text != nil {
			t.Fatalf("%s: err=%v text=%v", in, err, e.Text)
		}
	}
	// Malformed input is an error, not a silent zero value.
	for _, in := range []string{`[1]`, `{"type":"markdown","text":{"a":1}}`, `{"type":"button","text":"label"}`} {
		if err := json.Unmarshal([]byte(in), &e); err == nil {
			t.Fatalf("%s: want an error", in)
		}
	}
	if !(BlockElement{Type: TextMrkdwn}).IsText() || (BlockElement{Type: ElementButton}).IsText() {
		t.Fatal("IsText")
	}
}

func TestBlocksDynamoDB_StoredAsOneStringAndLeftOutWhenEmpty(t *testing.T) {
	msg := Message{ID: "m1", Blocks: sampleBlocks(), MessageAttachments: []MessageAttachment{{Text: "card"}}}
	item, err := attributevalue.MarshalMap(msg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if _, ok := item["blocks"].(*types.AttributeValueMemberS); !ok {
		t.Fatalf("blocks stored as %T, want one string", item["blocks"])
	}
	var back Message
	if err := attributevalue.UnmarshalMap(item, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(back.Blocks) != 4 || back.Blocks[3].Elements[0].Content != "_via MeetingMind_" {
		t.Fatalf("round trip: %#v", back.Blocks)
	}

	// No blocks — on the message or its card — writes no attribute at all.
	empty, err := attributevalue.MarshalMap(Message{ID: "m2", MessageAttachments: []MessageAttachment{{Text: "card"}}})
	if err != nil {
		t.Fatalf("marshal empty: %v", err)
	}
	if _, present := empty["blocks"]; present {
		t.Fatalf("empty blocks written: %#v", empty["blocks"])
	}
	card := empty["messageAttachments"].(*types.AttributeValueMemberL).Value[0].(*types.AttributeValueMemberM).Value
	if _, present := card["blocks"]; present {
		t.Fatalf("empty card blocks written")
	}
	var none Message
	if err := attributevalue.UnmarshalMap(empty, &none); err != nil || none.Blocks != nil {
		t.Fatalf("unmarshal empty: %v %#v", err, none.Blocks)
	}
}

func TestBlocksDynamoDB_Errors(t *testing.T) {
	var b Blocks
	// Anything but a string reads as no blocks (a NULL the SDK hands over).
	if err := b.UnmarshalDynamoDBAttributeValue(&types.AttributeValueMemberNULL{Value: true}); err != nil || b != nil {
		t.Fatalf("NULL: %v %#v", err, b)
	}
	if err := b.UnmarshalDynamoDBAttributeValue(&types.AttributeValueMemberS{Value: "{bad"}); err == nil {
		t.Fatal("corrupt JSON: want an error")
	}
	// Asked directly (a caller without omitempty), no blocks is a NULL.
	av, err := Blocks(nil).MarshalDynamoDBAttributeValue()
	if _, isNull := av.(*types.AttributeValueMemberNULL); err != nil || !isNull {
		t.Fatalf("empty blocks: %T %v", av, err)
	}
}

func TestTombstoneKeepsBlocksOutOfSight(t *testing.T) {
	m := Message{Body: "x", Blocks: sampleBlocks(), ActionTallies: []ActionTally{{BlockID: "a", ActionID: "ok"}}}
	m.Tombstone()
	if m.Blocks != nil || m.ActionTallies != nil || len(m.DeletedContent.Blocks) != 4 {
		t.Fatalf("tombstone: blocks=%v tallies=%v kept=%d", m.Blocks, m.ActionTallies, len(m.DeletedContent.Blocks))
	}
	// A message with only blocks keeps them too.
	only := Message{Blocks: sampleBlocks()}
	only.Tombstone()
	if only.DeletedContent == nil || len(only.DeletedContent.Blocks) != 4 {
		t.Fatalf("blocks-only tombstone lost them")
	}
}

func TestBlockTexts_ReadsBlocksThenCardsInOrder(t *testing.T) {
	blocks := append(sampleBlocks(), Block{Type: BlockSection, Fields: []TextObject{{Type: TextMarkdown, Text: "Owner"}, {Type: TextPlain, Text: "Virpal"}}})
	cards := []MessageAttachment{{Text: "no blocks"}, {Blocks: Blocks{{Type: BlockDivider}, {Type: BlockHeader, Text: &TextObject{Type: TextPlain, Text: "Card"}}}}}
	got := strings.Join(BlockTexts(blocks, cards), "|")
	// Buttons and dividers carry no readable text of their own.
	if want := "Review|**A3** due|_via MeetingMind_|Owner|Virpal|Card"; got != want {
		t.Fatalf("BlockTexts = %q, want %q", got, want)
	}
	if BlockTexts(nil, nil) != nil {
		t.Fatal("no blocks should read as nothing")
	}
}

func TestIncomingWebhookPresent_SaysWhatIsIssuedWithoutTheValues(t *testing.T) {
	w := (&IncomingWebhook{ID: "wh"}).Present()
	if w.HasBotToken || w.HasSigningSecret {
		t.Fatalf("nothing issued: %+v", w)
	}
	w = (&IncomingWebhook{ID: "wh", BotTokenHash: "abc", SecretVersion: 2}).Present()
	if !w.HasBotToken || !w.HasSigningSecret {
		t.Fatalf("both issued: %+v", w)
	}
	raw, _ := json.Marshal(w)
	if strings.Contains(string(raw), "abc") {
		t.Fatalf("the token hash reached JSON: %s", raw)
	}
}

// sampleView is a form with one field of each input kind.
func sampleView() View {
	monday := SelectOption{Text: TextObject{Type: TextPlain, Text: "Monday"}, Value: "mon"}
	return View{
		ID: "V1", Type: ViewModal, CallbackID: "review", ExternalID: "ext-1", PrivateMetadata: `{"m":"A3"}`, Hash: "h1",
		Title:  TextObject{Type: TextPlain, Text: "Review"},
		Submit: &TextObject{Type: TextPlain, Text: "Save"},
		Close:  &TextObject{Type: TextPlain, Text: "Cancel"},
		Blocks: Blocks{
			{Type: BlockInput, BlockID: "notes", Label: &TextObject{Type: TextPlain, Text: "Notes"}, Hint: &TextObject{Type: TextPlain, Text: "Be brief"}, Optional: true,
				Element: &BlockElement{Type: ElementPlainTextInput, ActionID: "text", Placeholder: &TextObject{Type: TextPlain, Text: "Type…"},
					Multiline: true, InitialValue: "draft", MinLength: 2, MaxLength: 500}},
			{Type: BlockInput, BlockID: "due", Label: &TextObject{Type: TextPlain, Text: "Due"},
				Element: &BlockElement{Type: ElementDatepicker, ActionID: "date", InitialDate: "2026-10-30"}},
			{Type: BlockInput, BlockID: "day", Label: &TextObject{Type: TextPlain, Text: "Day"},
				Element: &BlockElement{Type: ElementStaticSelect, ActionID: "pick", Options: []SelectOption{monday, {Text: TextObject{Type: TextPlain, Text: "Friday"}, Value: "fri"}}, InitialOption: &monday}},
		},
	}
}

func TestViewJSON_InputFieldsRoundTrip(t *testing.T) {
	want := sampleView()
	raw, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(raw)
	for _, wire := range []string{
		`"placeholder":{"type":"plain_text","text":"Type…"}`, `"multiline":true`, `"initial_value":"draft"`,
		`"min_length":2`, `"max_length":500`, `"initial_date":"2026-10-30"`,
		`"initial_option":{"text":{"type":"plain_text","text":"Monday"},"value":"mon"}`,
		`"label":{"type":"plain_text","text":"Notes"}`, `"hint":{"type":"plain_text","text":"Be brief"}`, `"optional":true`,
		`"callback_id":"review"`, `"external_id":"ext-1"`, `"private_metadata":"{\"m\":\"A3\"}"`, `"hash":"h1"`,
	} {
		if !strings.Contains(s, wire) {
			t.Errorf("wire form lacks %s: %s", wire, s)
		}
	}
	var back View
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !reflect.DeepEqual(back, want) {
		t.Fatalf("round trip:\n got %#v\nwant %#v", back, want)
	}
}

func TestBlocksDynamoDB_InputFieldsRoundTrip(t *testing.T) {
	want := sampleView().Blocks
	av, err := want.MarshalDynamoDBAttributeValue()
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back Blocks
	if err := back.UnmarshalDynamoDBAttributeValue(av); err != nil || !reflect.DeepEqual(back, want) {
		t.Fatalf("round trip: %v\n got %#v\nwant %#v", err, back, want)
	}
}

func TestElementKinds(t *testing.T) {
	// A form field holds any value element; overflow menus, buttons, images
	// and text never.
	inputs := []string{ElementPlainTextInput, ElementNumberInput, ElementEmailInput, ElementURLInput,
		ElementDatepicker, ElementTimepicker, ElementStaticSelect, ElementMultiStaticSelect,
		ElementUsersSelect, ElementMultiUsersSelect, ElementCheckboxes, ElementRadioButtons}
	for _, typ := range inputs {
		if !IsInputType(typ) {
			t.Errorf("%s is an input", typ)
		}
	}
	for _, typ := range []string{ElementButton, ElementOverflow, ElementImage, TextPlain, TextMarkdown, "conversations_select", ""} {
		if IsInputType(typ) {
			t.Errorf("%q is not an input", typ)
		}
	}

	// What a message can carry besides buttons: picks that go to the app.
	// Free text, and the many-people picker, stay in forms.
	for _, typ := range []string{ElementStaticSelect, ElementMultiStaticSelect, ElementUsersSelect, ElementOverflow,
		ElementDatepicker, ElementTimepicker, ElementCheckboxes, ElementRadioButtons} {
		if !IsMessageInteractive(typ) {
			t.Errorf("%s belongs in a message", typ)
		}
	}
	for _, typ := range []string{ElementButton, ElementPlainTextInput, ElementNumberInput, ElementEmailInput,
		ElementURLInput, ElementMultiUsersSelect, ElementImage, ""} {
		if IsMessageInteractive(typ) {
			t.Errorf("%q isn't a message pick", typ)
		}
	}

	// Lists: the multi-selects and checkboxes, nothing else.
	multi := map[string]bool{ElementMultiStaticSelect: true, ElementMultiUsersSelect: true, ElementCheckboxes: true}
	for _, typ := range append(inputs, ElementOverflow, ElementButton) {
		if IsMultiValue(typ) != multi[typ] {
			t.Errorf("IsMultiValue(%s) = %v", typ, !multi[typ])
		}
	}
}

// fillAll sets every field of v (a struct) to something non-zero, so a
// round trip that drops any field shows.
func fillAll(t *testing.T, v reflect.Value, seed *int) {
	t.Helper()
	for i := 0; i < v.NumField(); i++ {
		fillValue(t, v.Type().Field(i).Name, v.Field(i), seed)
	}
}

func fillValue(t *testing.T, name string, f reflect.Value, seed *int) {
	t.Helper()
	*seed++
	switch f.Kind() {
	case reflect.String:
		f.SetString(name + "-" + strconv.Itoa(*seed))
	case reflect.Bool:
		f.SetBool(true)
	case reflect.Int:
		f.SetInt(int64(*seed))
	case reflect.Pointer:
		f.Set(reflect.New(f.Type().Elem()))
		fillValue(t, name, f.Elem(), seed)
	case reflect.Struct:
		fillAll(t, f, seed)
	case reflect.Slice:
		f.Set(reflect.MakeSlice(f.Type(), 2, 2))
		for i := 0; i < 2; i++ {
			fillValue(t, name, f.Index(i), seed)
		}
	default:
		t.Fatalf("fillValue: %s is a %s", name, f.Kind())
	}
}

// Every field an element has survives its custom JSON — the wire shape
// lists each one by hand, so a field added to one side only would vanish.
func TestBlockElementJSON_EveryFieldRoundTrips(t *testing.T) {
	var want BlockElement
	seed := 0
	fillAll(t, reflect.ValueOf(&want).Elem(), &seed)
	want.Type = ElementMultiStaticSelect
	want.Content = "" // a text element's text; this one isn't text

	raw, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back BlockElement
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !reflect.DeepEqual(back, want) {
		t.Fatalf("round trip lost a field:\n got %#v\nwant %#v", back, want)
	}
	s := string(raw)
	for _, key := range []string{`"initial_options":[`, `"initial_time":`, `"initial_user":`, `"initial_users":[`,
		`"max_selected_items":`, `"is_decimal_allowed":true`, `"min_value":`, `"max_value":`,
		`"image_url":`, `"alt_text":`, `"image_width":`, `"image_height":`, `"description":{`, `"url":"URL-`} {
		if !strings.Contains(s, key) {
			t.Errorf("wire form lacks %s: %s", key, s)
		}
	}
}

// richView is a stacked form with the newer kinds of field: a time, a
// number, checkboxes with descriptions, a people picker that tells the app
// as it changes, and a picture.
func richView() View {
	early := SelectOption{Text: TextObject{Type: TextPlain, Text: "Early"}, Value: "early", Description: &TextObject{Type: TextPlain, Text: "Before 9"}}
	return View{
		ID: "V2", Type: ViewModal, CallbackID: "shift", Hash: "h2", Title: TextObject{Type: TextPlain, Text: "Shift"},
		NotifyOnClose: true, PreviousViewID: "V1", RootViewID: "V0",
		Blocks: Blocks{
			{Type: BlockImage, BlockID: "pic", ImageURL: "https://chat.test/img/p", AltText: "Rota", ImageWidth: 640, ImageHeight: 480,
				Text: &TextObject{Type: TextPlain, Text: "This week"}},
			{Type: BlockInput, BlockID: "at", Label: &TextObject{Type: TextPlain, Text: "Start"},
				Element: &BlockElement{Type: ElementTimepicker, ActionID: "time", InitialTime: "08:30"}},
			{Type: BlockInput, BlockID: "hours", Label: &TextObject{Type: TextPlain, Text: "Hours"},
				Element: &BlockElement{Type: ElementNumberInput, ActionID: "n", IsDecimalAllowed: true, MinValue: "0.5", MaxValue: "12"}},
			{Type: BlockInput, BlockID: "slots", Label: &TextObject{Type: TextPlain, Text: "Slots"},
				Element: &BlockElement{Type: ElementCheckboxes, ActionID: "c", Options: []SelectOption{early, {Text: TextObject{Type: TextPlain, Text: "Late"}, Value: "late"}}, InitialOptions: []SelectOption{early}}},
			{Type: BlockInput, BlockID: "who", Label: &TextObject{Type: TextPlain, Text: "Cover"}, DispatchAction: true,
				Element: &BlockElement{Type: ElementMultiUsersSelect, ActionID: "users", InitialUsers: []string{"u1", "u2"}, MaxSelectedItems: 3}},
			{Type: BlockActions, BlockID: "more", Elements: []BlockElement{
				{Type: ElementOverflow, ActionID: "menu", Options: []SelectOption{{Text: TextObject{Type: TextPlain, Text: "Docs"}, Value: "docs", URL: "https://example.com/docs"}}},
				{Type: ElementUsersSelect, ActionID: "lead", InitialUser: "u3"},
				{Type: ElementImage, ImageURL: "https://chat.test/img/i", AltText: "icon", ImageWidth: 16, ImageHeight: 16},
			}},
		},
	}
}

func TestViewJSON_NewerFieldsRoundTrip(t *testing.T) {
	want := richView()
	raw, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(raw)
	for _, wire := range []string{
		`"notify_on_close":true`, `"previous_view_id":"V1"`, `"root_view_id":"V0"`, `"dispatch_action":true`,
		`"type":"image","block_id":"pic"`, `"image_url":"https://chat.test/img/p","alt_text":"Rota","image_width":640,"image_height":480`,
		`"initial_time":"08:30"`, `"is_decimal_allowed":true,"min_value":"0.5","max_value":"12"`,
		`"description":{"type":"plain_text","text":"Before 9"}`, `"url":"https://example.com/docs"`,
		`"initial_users":["u1","u2"],"max_selected_items":3`, `"initial_user":"u3"`,
	} {
		if !strings.Contains(s, wire) {
			t.Errorf("wire form lacks %s: %s", wire, s)
		}
	}
	var back View
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !reflect.DeepEqual(back, want) {
		t.Fatalf("round trip:\n got %#v\nwant %#v", back, want)
	}
	// A form ex hasn't stacked or asked to hear about says nothing of it.
	plain, _ := json.Marshal(sampleView())
	for _, absent := range []string{"notify_on_close", "previous_view_id", "root_view_id", "dispatch_action", "image_"} {
		if strings.Contains(string(plain), absent) {
			t.Errorf("a plain form carries %s: %s", absent, plain)
		}
	}
}

func TestBlocksDynamoDB_NewerFieldsRoundTrip(t *testing.T) {
	want := richView().Blocks
	av, err := want.MarshalDynamoDBAttributeValue()
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back Blocks
	if err := back.UnmarshalDynamoDBAttributeValue(av); err != nil || !reflect.DeepEqual(back, want) {
		t.Fatalf("round trip: %v\n got %#v\nwant %#v", err, back, want)
	}
}

// Rich text reads as plain lines for search and notifications: lists keep
// their markers and nesting, mentions keep ex's mention syntax (so a message
// that stands on this text still mentions them), dates their fallback.
func TestRichTextPlain(t *testing.T) {
	nodes := []RichNode{
		{Type: RichHeading, Level: 1, Spans: []RichSpan{{Type: RichSpanText, Text: "Release 1.43"}}},
		{Type: RichParagraph, Spans: []RichSpan{
			{Type: RichSpanText, Text: "Ship it "},
			{Type: RichSpanUser, User: "u-alice", Name: "Alice"},
			{Type: RichSpanText, Text: " in "},
			{Type: RichSpanChannel, Channel: "c-builds", Name: "builds"},
			{Type: RichSpanText, Text: " "},
			{Type: RichSpanEmoji, Name: "rocket"},
			{Type: RichSpanText, Text: " by "},
			{Type: RichSpanDate, Timestamp: 1, Fallback: "Friday"},
			{Type: RichSpanText, Text: " "},
			{Type: RichSpanPill, Text: "Passed", Color: "green"},
		}},
		{Type: RichQuote, Spans: []RichSpan{{Type: RichSpanText, Text: "No Friday deploys"}}},
		{Type: RichList, Style: RichListBullet, Items: []RichItem{
			{Spans: []RichSpan{{Type: RichSpanText, Text: "Build"}}, Items: []RichItem{{Spans: []RichSpan{{Type: RichSpanText, Text: "Lint"}}}}},
		}},
		{Type: RichList, Style: RichListOrdered, Items: []RichItem{
			{Spans: []RichSpan{{Type: RichSpanText, Text: "One"}}}, {Spans: []RichSpan{{Type: RichSpanText, Text: "Two"}}},
		}},
		{Type: RichCode, Language: "go", Text: "go test ./..."},
	}
	want := "Release 1.43\nShip it @[u-alice|Alice] in ~[c-builds|builds] :rocket: by Friday Passed\n> No Friday deploys\n• Build\n  • Lint\n1. One\n2. Two\ngo test ./..."
	if got := RichTextPlain(nodes); got != want {
		t.Fatalf("RichTextPlain:\n got %q\nwant %q", got, want)
	}
	if got := RichTextPlain([]RichNode{{Type: RichCode, Text: "only code"}}); got != "only code" {
		t.Fatalf("code alone = %q", got)
	}
	texts := BlockTexts(Blocks{{Type: BlockRichText, Content: nodes[:1]}}, nil)
	if len(texts) != 1 || texts[0] != "Release 1.43" {
		t.Fatalf("BlockTexts = %q, want the rich text", texts)
	}
}

func TestIsRichColor(t *testing.T) {
	for _, c := range RichColors {
		if !IsRichColor(c) {
			t.Errorf("%s should be a palette colour", c)
		}
	}
	for _, c := range []string{"", "pink", "#ff0000", "Red"} {
		if IsRichColor(c) {
			t.Errorf("%q should not be a palette colour", c)
		}
	}
}

// Callouts, toggles (summary and children) and tables are readable text for
// search and notifications too; a table reads a row per line.
func TestBlockTexts_LayoutBlocks(t *testing.T) {
	text := func(s string) []RichSpan { return []RichSpan{{Type: RichSpanText, Text: s}} }
	got := BlockTexts(Blocks{
		{Type: BlockCallout, Content: []RichNode{{Type: RichParagraph, Spans: text("Freeze starts Friday")}}},
		{Type: BlockToggle, Summary: text("Show logs"), Blocks: Blocks{
			{Type: BlockRichText, Content: []RichNode{{Type: RichCode, Text: "panic: nil map"}}},
		}},
		{Type: BlockTable, Rows: [][]TableCell{
			{{Spans: text("api")}, {Spans: []RichSpan{{Type: RichSpanPill, Text: "Live"}}}},
			{{Spans: text("web")}, {}},
		}},
	}, nil)
	want := []string{"Freeze starts Friday", "Show logs", "panic: nil map", "api · Live", "web · "}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("BlockTexts = %q, want %q", got, want)
	}
}

func TestIsToggleChild(t *testing.T) {
	for _, k := range []string{BlockRichText, BlockTable, BlockDivider, BlockSection, BlockContext} {
		if !IsToggleChild(k) {
			t.Errorf("%s should fit in a toggle", k)
		}
	}
	for _, k := range []string{BlockActions, BlockImage, BlockToggle, BlockCallout, BlockHeader, BlockInput} {
		if IsToggleChild(k) {
			t.Errorf("%s should not fit in a toggle", k)
		}
	}
}

// A chart reads as its title and series names; columns read through to the
// blocks inside them.
func TestBlockTexts_ColumnsAndCharts(t *testing.T) {
	got := BlockTexts(Blocks{
		{Type: BlockColumns, Blocks: Blocks{
			{Type: BlockColumn, Blocks: Blocks{{Type: BlockHeader, Text: &TextObject{Type: TextPlain, Text: "Revenue"}}}},
			{Type: BlockColumn, Blocks: Blocks{{Type: BlockChart, Kind: ChartLine, Text: &TextObject{Type: TextPlain, Text: "Signups"},
				Series: []ChartSeries{{Name: "web", Values: []float64{1}}, {Values: []float64{2}}}}}},
		}},
	}, nil)
	if want := []string{"Revenue", "Signups", "web"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("BlockTexts = %q, want %q", got, want)
	}
}

func TestIsColumnChild(t *testing.T) {
	for _, k := range []string{BlockHeader, BlockCallout, BlockChart, BlockRichText, BlockTable, BlockDivider, BlockSection, BlockContext} {
		if !IsColumnChild(k) {
			t.Errorf("%s should fit in a column", k)
		}
	}
	for _, k := range []string{BlockActions, BlockImage, BlockToggle, BlockColumns, BlockColumn, BlockInput} {
		if IsColumnChild(k) {
			t.Errorf("%s should not fit in a column", k)
		}
	}
}
