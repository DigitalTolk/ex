package model

import (
	"encoding/json"
	"reflect"
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

func TestIsInputType(t *testing.T) {
	for _, typ := range []string{ElementPlainTextInput, ElementDatepicker, ElementStaticSelect} {
		if !IsInputType(typ) {
			t.Errorf("%s is an input", typ)
		}
	}
	for _, typ := range []string{ElementButton, TextPlain, TextMarkdown, "multi_static_select", ""} {
		if IsInputType(typ) {
			t.Errorf("%q is not an input", typ)
		}
	}
}
