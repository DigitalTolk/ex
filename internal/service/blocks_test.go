package service

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func plain(s string) *model.TextObject { return &model.TextObject{Type: model.TextPlain, Text: s} }
func md(s string) *model.TextObject    { return &model.TextObject{Type: model.TextMrkdwn, Text: s} }
func btn(id, label string) model.BlockElement {
	return model.BlockElement{Type: model.ElementButton, ActionID: id, Text: plain(label)}
}

// testNormalizer rewrites markdown visibly and resolves u-* IDs and
// *@ex.test emails; anything else matches nobody.
func testNormalizer() *blockNormalizer {
	return newBlockNormalizer(
		func(s string) string { return strings.ReplaceAll(s, "<!here>", "@here") },
		func(_ context.Context, ref string) string {
			switch {
			case strings.HasPrefix(ref, "u-"):
				return ref
			case strings.HasSuffix(ref, "@ex.test"):
				return "u-" + strings.TrimSuffix(ref, "@ex.test")
			}
			return ""
		},
	)
}

func normalizeOne(t *testing.T, blocks model.Blocks) (model.Blocks, error) {
	t.Helper()
	return testNormalizer().normalizeMessage(context.Background(), blocks, nil)
}

func wantInvalid(t *testing.T, err error, fragment string) {
	t.Helper()
	if !errors.Is(err, ErrInvalidBlocks) || !strings.Contains(err.Error(), fragment) {
		t.Fatalf("want invalid_blocks naming %q, got %v", fragment, err)
	}
}

func TestNormalizeBlocks_KeepsWhatExDrawsAndNamesIt(t *testing.T) {
	out, err := normalizeOne(t, model.Blocks{
		{Type: "image"}, // not drawn by ex: skipped
		{Type: model.BlockHeader, Text: md("Review **now**")},
		{Type: model.BlockSection, BlockID: "b2", Text: md("hi <!here>"), Fields: []model.TextObject{{Type: "weird", Text: "f"}},
			Accessory: &model.BlockElement{Type: model.ElementButton, Text: md("Go"), URL: "https://ex.test/x"}},
		{Type: model.BlockSection, Text: plain("no button"), Accessory: &model.BlockElement{Type: "datepicker"}},
		{Type: model.BlockActions, Elements: []model.BlockElement{
			{Type: "static_select"}, // skipped
			{Type: model.ElementButton, ActionID: "a1", Text: plain("given a1"), Style: model.ButtonDanger},
			{Type: model.ElementButton, Text: plain("named a2"), ExAction: model.ExActionVote},
			{Type: model.ElementButton, Text: plain("ack"), ExAction: model.ExActionAck, Style: model.ButtonPrimary,
				Confirm: &model.ConfirmDialog{Text: model.TextObject{Text: "Really?"}}},
		}},
		{Type: model.BlockActions, Elements: []model.BlockElement{{Type: "overflow"}}}, // empty after skipping: dropped
		{Type: model.BlockContext, Elements: []model.BlockElement{{Type: model.ElementButton}, {Type: model.TextMarkdown, Content: " "}, {Type: model.TextMrkdwn, Content: "_by_ <!here>"}}},
		{Type: model.BlockContext, Elements: []model.BlockElement{{Type: model.TextPlain, Content: ""}}}, // empty: dropped
		{Type: model.BlockDivider},
	})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if len(out) != 6 {
		t.Fatalf("kept %d blocks, want 6: %#v", len(out), out)
	}
	// Generated IDs skip the app's own (b2 is the section's).
	if ids := []string{out[0].BlockID, out[1].BlockID, out[2].BlockID, out[3].BlockID, out[4].BlockID, out[5].BlockID}; strings.Join(ids, ",") != "b1,b2,b3,b4,b5,b6" {
		t.Fatalf("block IDs = %v", ids)
	}
	if out[0].Text.Type != model.TextPlain || out[0].Text.Text != "Review **now**" {
		t.Fatalf("header must be plain text: %#v", out[0].Text)
	}
	if out[1].Text.Type != model.TextMarkdown || out[1].Text.Text != "hi @here" || out[1].Fields[0].Type != model.TextPlain {
		t.Fatalf("section text: %#v %#v", out[1].Text, out[1].Fields)
	}
	if acc := out[1].Accessory; acc == nil || acc.ActionID != "a1" || acc.Text.Type != model.TextPlain || acc.URL != "https://ex.test/x" {
		t.Fatalf("accessory: %#v", acc)
	}
	if out[2].Accessory != nil {
		t.Fatalf("a non-button accessory must be dropped: %#v", out[2].Accessory)
	}
	row := out[3].Elements
	if len(row) != 3 || row[0].ActionID != "a1" || row[1].ActionID != "a2" || row[2].ActionID != "a3" {
		t.Fatalf("action IDs: %#v", row)
	}
	if c := row[2].Confirm; c.Title.Text != "Are you sure?" || c.Confirm.Text != "Confirm" || c.Deny.Text != "Cancel" || c.Text.Text != "Really?" {
		t.Fatalf("confirm defaults: %#v", c)
	}
	if ctx := out[4].Elements; len(ctx) != 1 || ctx[0].Type != model.TextMarkdown || ctx[0].Content != "_by_ @here" {
		t.Fatalf("context: %#v", ctx)
	}
	if out[5].Type != model.BlockDivider {
		t.Fatalf("divider kept last: %#v", out[5])
	}
}

func TestNormalizeBlocks_NothingDrawnIsNoBlocks(t *testing.T) {
	out, err := normalizeOne(t, model.Blocks{{Type: "image"}})
	if err != nil || out != nil {
		t.Fatalf("got %#v %v", out, err)
	}
	if out, err := normalizeOne(t, nil); err != nil || out != nil {
		t.Fatalf("nil: %#v %v", out, err)
	}
}

func TestNormalizeBlocks_GeneratedIDsSkipIDsUsedAnywhereInTheMessage(t *testing.T) {
	attachments := []model.MessageAttachment{{Blocks: model.Blocks{{Type: model.BlockDivider, BlockID: "b1"}}}}
	out, err := testNormalizer().normalizeMessage(context.Background(), model.Blocks{{Type: model.BlockDivider}}, attachments)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if out[0].BlockID != "b2" || attachments[0].Blocks[0].BlockID != "b1" {
		t.Fatalf("IDs: top %q, card %q", out[0].BlockID, attachments[0].Blocks[0].BlockID)
	}
}

func TestNormalizeBlocks_ActionIDsSkipTheRowsOwn(t *testing.T) {
	out, err := normalizeOne(t, model.Blocks{{Type: model.BlockActions, Elements: []model.BlockElement{
		btn("", "first"), btn("a1", "given"),
	}}})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if got := out[0].Elements; got[0].ActionID != "a2" || got[1].ActionID != "a1" {
		t.Fatalf("action IDs: %q %q", got[0].ActionID, got[1].ActionID)
	}
}

func TestNormalizeBlocks_ResolvesAllowedUsers(t *testing.T) {
	b := btn("take", "Take it")
	b.AllowedUsers = []string{"virpal@ex.test", "u-virpal", " u-manisha ", "nobody@else.test"}
	other := btn("mine", "Mine")
	other.AllowedUsers = []string{"virpal@ex.test"} // looked up once
	out, err := normalizeOne(t, model.Blocks{{Type: model.BlockActions, Elements: []model.BlockElement{b, other}}})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if got := strings.Join(out[0].Elements[0].AllowedUsers, ","); got != "u-virpal,u-manisha" {
		t.Fatalf("allowed users = %s", got)
	}
	if got := out[0].Elements[1].AllowedUsers; len(got) != 1 || got[0] != "u-virpal" {
		t.Fatalf("second button = %v", got)
	}
}

func TestNormalizeBlocks_Refusals(t *testing.T) {
	long := func(n int) string { return strings.Repeat("x", n) }
	section := func(text string) model.Block {
		return model.Block{Type: model.BlockSection, Text: plain(text)}
	}
	row := func(es ...model.BlockElement) model.Block { return model.Block{Type: model.BlockActions, Elements: es} }
	withBtn := func(mutate func(*model.BlockElement)) model.Block {
		b := btn("x", "label")
		mutate(&b)
		return row(b)
	}
	many := func(n int, build func(int) model.Block) model.Blocks {
		out := make(model.Blocks, n)
		for i := range out {
			out[i] = build(i)
		}
		return out
	}
	fields := make([]model.TextObject, maxSectionFields+1)
	buttons := make([]model.BlockElement, maxActionsElements+1)
	for i := range buttons {
		buttons[i] = btn("", "b")
	}
	texts := make([]model.BlockElement, maxContextElements+1)
	for i := range texts {
		texts[i] = model.BlockElement{Type: model.TextPlain, Content: "t"}
	}
	tooMany := make([]string, maxAllowedUsers+1)
	cases := []struct {
		name     string
		blocks   model.Blocks
		fragment string
	}{
		{"too many blocks", many(maxBlocksPerMessage+1, func(int) model.Block { return model.Block{Type: model.BlockDivider} }), "at most 50 blocks"},
		{"header without text", model.Blocks{{Type: model.BlockHeader}}, "blocks[0]: a header needs text"},
		{"header too long", model.Blocks{{Type: model.BlockHeader, Text: plain(long(maxHeaderChars + 1))}}, "blocks[0].text: text is longer than 150"},
		{"block ID too long", model.Blocks{{Type: model.BlockDivider, BlockID: long(maxBlockIDChars + 1)}}, "block_id is longer than 255"},
		{"block ID twice", model.Blocks{{Type: model.BlockDivider, BlockID: "x"}, {Type: model.BlockDivider, BlockID: "x"}}, `blocks[1]: block_id "x" is used twice`},
		{"section text too long", model.Blocks{section(long(maxSectionChars + 1))}, "longer than 3000"},
		{"too many fields", model.Blocks{{Type: model.BlockSection, Fields: fields}}, "at most 10 fields"},
		{"field too long", model.Blocks{{Type: model.BlockSection, Fields: []model.TextObject{{Text: long(maxFieldChars + 1)}}}}, "blocks[0].fields[0]"},
		{"empty section", model.Blocks{section(" ")}, "a section needs text or fields"},
		{"bad accessory", model.Blocks{{Type: model.BlockSection, Text: plain("t"), Accessory: &model.BlockElement{Type: model.ElementButton}}}, "accessory.elements[0]: a button needs a label"},
		{"too many buttons", model.Blocks{row(buttons...)}, "at most 25 buttons"},
		{"action ID twice", model.Blocks{row(btn("x", "a"), btn("x", "b"))}, `action_id "x" is used twice`},
		{"label too long", model.Blocks{withBtn(func(b *model.BlockElement) { b.Text = plain(long(maxButtonLabelChars + 1)) })}, "longer than 75"},
		{"action ID too long", model.Blocks{withBtn(func(b *model.BlockElement) { b.ActionID = long(maxBlockIDChars + 1) })}, "action_id is longer than 255"},
		{"value too long", model.Blocks{withBtn(func(b *model.BlockElement) { b.Value = long(maxButtonValueChars + 1) })}, "value is longer than 2000"},
		{"bad style", model.Blocks{withBtn(func(b *model.BlockElement) { b.Style = "loud" })}, "style must be primary or danger"},
		{"bad ex_action", model.Blocks{withBtn(func(b *model.BlockElement) { b.ExAction = "delete" })}, "ex_action must be ack or vote"},
		{"url and ex_action", model.Blocks{withBtn(func(b *model.BlockElement) { b.URL, b.ExAction = "https://x.test", model.ExActionAck })}, "both a url and an ex_action"},
		{"script url", model.Blocks{withBtn(func(b *model.BlockElement) { b.URL = "javascript:alert(1)" })}, "url must be an http or https"},
		{"mailto url", model.Blocks{withBtn(func(b *model.BlockElement) { b.URL = "mailto:a@b.test" })}, "url must be an http or https"},
		{"url too long", model.Blocks{withBtn(func(b *model.BlockElement) { b.URL = "https://x.test/" + long(maxButtonURLChars) })}, "url must be"},
		{"confirm without text", model.Blocks{withBtn(func(b *model.BlockElement) { b.Confirm = &model.ConfirmDialog{} })}, "a confirm dialog needs text"},
		{"confirm too long", model.Blocks{withBtn(func(b *model.BlockElement) {
			b.Confirm = &model.ConfirmDialog{Text: model.TextObject{Text: long(maxConfirmChars + 1)}}
		})}, "longer than 300"},
		{"too many allowed users", model.Blocks{withBtn(func(b *model.BlockElement) { b.AllowedUsers = tooMany })}, "at most 50 people"},
		{"allowed users naming nobody", model.Blocks{withBtn(func(b *model.BlockElement) { b.AllowedUsers = []string{"who@else.test"} })}, "names no ex user"},
		{"too many contexts", model.Blocks{{Type: model.BlockContext, Elements: texts}}, "at most 10 texts"},
		{"context too long", model.Blocks{{Type: model.BlockContext, Elements: []model.BlockElement{{Type: model.TextPlain, Content: long(maxContextChars + 1)}}}}, "blocks[0].elements[0]"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := normalizeOne(t, c.blocks)
			wantInvalid(t, err, c.fragment)
		})
	}
}

func TestNormalizeBlocks_AllowedUserLookupsAreCapped(t *testing.T) {
	var rows model.Blocks
	for r := 0; r < 3; r++ {
		b := btn("x", "b")
		for i := 0; i < maxAllowedUsers; i++ {
			b.AllowedUsers = append(b.AllowedUsers, "u-"+strconv.Itoa(r*maxAllowedUsers+i))
		}
		rows = append(rows, model.Block{Type: model.BlockActions, Elements: []model.BlockElement{b}})
	}
	_, err := normalizeOne(t, rows)
	wantInvalid(t, err, "more than 100 people across the message")
}

func TestNormalizeMessage_RefusalsInCardsAndSize(t *testing.T) {
	n := testNormalizer()
	attachments := []model.MessageAttachment{{Blocks: model.Blocks{{Type: model.BlockHeader}}}}
	_, err := n.normalizeMessage(context.Background(), nil, attachments)
	wantInvalid(t, err, "attachments[0].blocks[0]: a header needs text")

	_, err = testNormalizer().normalizeMessage(context.Background(), model.Blocks{{Type: model.BlockHeader}}, nil)
	wantInvalid(t, err, "blocks[0]")

	// 50 sections of 3,000 characters: within every per-block limit, over
	// what a stored message may hold.
	big := make(model.Blocks, maxBlocksPerMessage)
	for i := range big {
		big[i] = model.Block{Type: model.BlockSection, Text: plain(strings.Repeat("y", maxSectionChars))}
	}
	_, err = testNormalizer().normalizeMessage(context.Background(), big, []model.MessageAttachment{{Text: "card without blocks"}})
	wantInvalid(t, err, "KB fit")
}

func TestBlocksFallbackText(t *testing.T) {
	blocks := model.Blocks{
		{Type: model.BlockHeader, Text: plain("Title")},
		{Type: model.BlockSection, Fields: []model.TextObject{{Text: "f1"}}},
		{Type: model.BlockContext, Elements: []model.BlockElement{{Type: model.TextPlain, Content: "ctx"}, btn("x", "not text")}},
	}
	cards := []model.MessageAttachment{{Blocks: model.Blocks{{Type: model.BlockSection, Text: plain("card")}}}}
	if got := blocksFallbackText(blocks, cards); got != "Title\nf1\nctx\ncard" {
		t.Fatalf("fallback = %q", got)
	}
	huge := model.Blocks{{Type: model.BlockSection, Text: plain(strings.Repeat("z", MaxMessageBodyChars+10))}}
	got := blocksFallbackText(huge, nil)
	if n := len([]rune(got)); n != MaxMessageBodyChars || !strings.HasSuffix(got, "…") {
		t.Fatalf("cut fallback: %d runes", n)
	}
}

func TestIsWebURL(t *testing.T) {
	for raw, want := range map[string]bool{
		"https://ex.test":       true,
		"HTTP://ex.test/a?b=c":  true,
		"mailto:a@ex.test":      false,
		"javascript:alert(1)":   false,
		"java\tscript:alert(1)": false,
		"/relative":             false,
		"ftp://files.ex.test/a": false,
	} {
		if got := isWebURL(raw); got != want {
			t.Errorf("isWebURL(%q) = %v, want %v", raw, got, want)
		}
	}
}
