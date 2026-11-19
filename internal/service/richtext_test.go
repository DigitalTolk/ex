package service

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// richNormalizer resolves mentions the way the webhook's markdown rewrite
// does: <@alice@ex.test> is Alice, <#builds> (or its ID) is ~builds;
// anything else stays as written.
func richNormalizer() *blockNormalizer {
	return newBlockNormalizer(func(s string) string {
		switch s {
		case "<@alice@ex.test>", "<@u-alice>":
			return "@[u-alice|Alice]"
		case "<#builds>", "<#c-builds>":
			return "~[c-builds|builds]"
		}
		return strings.Trim(s, "<>")
	}, func(context.Context, string) string { return "" })
}

func richBlock(content ...model.RichNode) model.Blocks {
	return model.Blocks{{Type: model.BlockRichText, Content: content}}
}

func normalizeRich(t *testing.T, content ...model.RichNode) ([]model.RichNode, error) {
	t.Helper()
	out, err := richNormalizer().normalizeMessage(context.Background(), richBlock(content...), nil)
	if err != nil || len(out) == 0 {
		return nil, err
	}
	return out[0].Content, nil
}

func para(spans ...model.RichSpan) model.RichNode {
	return model.RichNode{Type: model.RichParagraph, Spans: spans}
}

func txt(s string) model.RichSpan { return model.RichSpan{Text: s} }

func TestRichText_NormalizesEveryPartAndPiece(t *testing.T) {
	got, err := normalizeRich(t,
		model.RichNode{Type: model.RichHeading, Level: 2, Spans: []model.RichSpan{txt("Release 1.43")}},
		para(
			model.RichSpan{Text: "−12%", Bold: true, Italic: true, Strike: true, Underline: true, Code: true, Color: "green", Highlight: "yellow"},
			model.RichSpan{Type: "text", Text: "notes", Link: "https://example.com/notes"},
			model.RichSpan{Text: "mail us", Link: "mailto:team@example.com"},
			model.RichSpan{Type: "user", User: " alice@ex.test "},
			model.RichSpan{Type: "user", User: "bob@else.test"},
			model.RichSpan{Type: "channel", Channel: "#builds"},
			model.RichSpan{Type: "channel", Channel: "nowhere"},
			model.RichSpan{Type: "emoji", Name: ":Rocket:"},
			model.RichSpan{Type: "date", Timestamp: 1767254400},
			model.RichSpan{Type: "date", Timestamp: 1767254400, Format: "{date_long} at {time}", Fallback: "Jan 1"},
			model.RichSpan{Type: "pill", Text: " Passed "},
			model.RichSpan{Type: "pill", Text: "Failed", Color: "red"},
			model.RichSpan{Type: "sparkle", Text: "unknown pieces are skipped"},
			model.RichSpan{Text: ""},
			model.RichSpan{Type: "pill", Text: "  "},
		),
		model.RichNode{Type: model.RichQuote, Spans: []model.RichSpan{txt("Ship it")}},
		model.RichNode{Type: model.RichList, Items: []model.RichItem{
			{Spans: []model.RichSpan{txt("Build")}, Items: []model.RichItem{
				{Spans: []model.RichSpan{txt("Lint")}, Items: []model.RichItem{{Spans: []model.RichSpan{txt("Go")}}}},
			}},
			{Spans: []model.RichSpan{{Text: ""}}},
			{Items: []model.RichItem{{Spans: []model.RichSpan{txt("Only nested")}}}},
		}},
		model.RichNode{Type: model.RichList, Style: "ordered", Items: []model.RichItem{{Spans: []model.RichSpan{txt("First")}}}},
		model.RichNode{Type: model.RichCode, Language: "Go", Text: "func main() {}"},
		model.RichNode{Type: model.RichCode, Text: "  "},
		model.RichNode{Type: "table", Spans: []model.RichSpan{txt("unknown parts are skipped")}},
		model.RichNode{Type: model.RichParagraph, Spans: []model.RichSpan{{Text: ""}}},
		model.RichNode{Type: model.RichList, Items: []model.RichItem{{Spans: []model.RichSpan{{Text: ""}}}}},
	)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	want := []model.RichNode{
		{Type: "heading", Level: 2, Spans: []model.RichSpan{{Type: "text", Text: "Release 1.43"}}},
		{Type: "paragraph", Spans: []model.RichSpan{
			{Type: "text", Text: "−12%", Bold: true, Italic: true, Strike: true, Underline: true, Code: true, Color: "green", Highlight: "yellow"},
			{Type: "text", Text: "notes", Link: "https://example.com/notes"},
			{Type: "text", Text: "mail us", Link: "mailto:team@example.com"},
			{Type: "user", User: "u-alice", Name: "Alice"},
			{Type: "text", Text: "@bob@else.test"},
			{Type: "channel", Channel: "c-builds", Name: "builds"},
			{Type: "text", Text: "~nowhere"},
			{Type: "emoji", Name: "rocket"},
			{Type: "date", Timestamp: 1767254400, Format: "{date_short}"},
			{Type: "date", Timestamp: 1767254400, Format: "{date_long} at {time}", Fallback: "Jan 1"},
			{Type: "pill", Text: "Passed", Color: "gray"},
			{Type: "pill", Text: "Failed", Color: "red"},
		}},
		{Type: "quote", Spans: []model.RichSpan{{Type: "text", Text: "Ship it"}}},
		{Type: "list", Style: "bullet", Items: []model.RichItem{
			{Spans: []model.RichSpan{{Type: "text", Text: "Build"}}, Items: []model.RichItem{
				{Spans: []model.RichSpan{{Type: "text", Text: "Lint"}}, Items: []model.RichItem{{Spans: []model.RichSpan{{Type: "text", Text: "Go"}}}}},
			}},
			{Spans: []model.RichSpan{}, Items: []model.RichItem{{Spans: []model.RichSpan{{Type: "text", Text: "Only nested"}}}}},
		}},
		{Type: "list", Style: "ordered", Items: []model.RichItem{{Spans: []model.RichSpan{{Type: "text", Text: "First"}}}}},
		{Type: "code", Language: "go", Text: "func main() {}"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("normalized rich text:\n got %+v\nwant %+v", got, want)
	}
}

// A rich_text block whose every part turned out empty is dropped, like any
// other empty block.
func TestRichText_AnEmptyBlockIsDropped(t *testing.T) {
	out, err := richNormalizer().normalizeMessage(context.Background(), richBlock(para(txt(""))), nil)
	if err != nil || len(out) != 0 {
		t.Fatalf("out = %+v, err = %v; want the block dropped", out, err)
	}
}

func TestRichText_Refusals(t *testing.T) {
	long := func(n int) string { return strings.Repeat("a", n) }
	many := func(n int, span model.RichSpan) []model.RichSpan {
		out := make([]model.RichSpan, n)
		for i := range out {
			out[i] = span
		}
		return out
	}
	items := func(n int) []model.RichItem {
		out := make([]model.RichItem, n)
		for i := range out {
			out[i] = model.RichItem{Spans: []model.RichSpan{txt("x")}}
		}
		return out
	}
	nested := model.RichItem{Spans: []model.RichSpan{txt("1")}, Items: []model.RichItem{{Spans: []model.RichSpan{txt("2")}, Items: []model.RichItem{
		{Spans: []model.RichSpan{txt("3")}, Items: []model.RichItem{{Spans: []model.RichSpan{txt("4")}}}}}}}}
	nodes := make([]model.RichNode, maxRichNodes+1)
	for i := range nodes {
		nodes[i] = para(txt("x"))
	}
	for _, tc := range []struct {
		name    string
		content []model.RichNode
		want    string
	}{
		{"too many parts", nodes, "at most 50 parts"},
		{"heading level", []model.RichNode{{Type: model.RichHeading, Level: 4, Spans: []model.RichSpan{txt("x")}}}, "level is 1, 2 or 3"},
		{"list style", []model.RichNode{{Type: model.RichList, Style: "dashes", Items: items(1)}}, "bullet or ordered"},
		{"code language", []model.RichNode{{Type: model.RichCode, Language: "<script>", Text: "x"}}, "language must be"},
		{"too many pieces", []model.RichNode{para(many(maxRichSpans+1, txt("x"))...)}, "at most 100 pieces"},
		{"colour", []model.RichNode{para(model.RichSpan{Text: "x", Color: "pink"})}, "colour must be one of gray"},
		{"highlight", []model.RichNode{para(model.RichSpan{Text: "x", Highlight: "#ff0000"})}, "content[0].spans[0].highlight"},
		{"script link", []model.RichNode{para(model.RichSpan{Text: "x", Link: "javascript:alert(1)"})}, "http, https or mailto"},
		{"long link", []model.RichNode{para(model.RichSpan{Text: "x", Link: "https://example.com/" + long(maxRichLinkChars)})}, "http, https or mailto"},
		{"empty mention", []model.RichNode{para(model.RichSpan{Type: "user", User: " "})}, "names who or what"},
		{"emoji name", []model.RichNode{para(model.RichSpan{Type: "emoji", Name: "<img>"})}, "emoji's name"},
		{"date timestamp", []model.RichNode{para(model.RichSpan{Type: "date"})}, "timestamp in Unix seconds"},
		{"date far future", []model.RichNode{para(model.RichSpan{Type: "date", Timestamp: maxRichDateTimestamp + 1})}, "timestamp in Unix seconds"},
		{"date format length", []model.RichNode{para(model.RichSpan{Type: "date", Timestamp: 1, Format: long(maxRichDateFormat + 1)})}, "format is at most"},
		{"date token", []model.RichNode{para(model.RichSpan{Type: "date", Timestamp: 1, Format: "{weekday}"})}, "may use {date_short}"},
		{"date fallback", []model.RichNode{para(model.RichSpan{Type: "date", Timestamp: 1, Fallback: long(maxRichDateFallback + 1)})}, "fallback is at most"},
		{"pill length", []model.RichNode{para(model.RichSpan{Type: "pill", Text: long(maxPillChars + 1)})}, "pill's text is at most"},
		{"pill colour", []model.RichNode{para(model.RichSpan{Type: "pill", Text: "x", Color: "teal"})}, "colour must be one of"},
		{"too many list items", []model.RichNode{{Type: model.RichList, Items: items(maxRichListItems + 1)}}, "at most 100 list items"},
		{"too deep", []model.RichNode{{Type: model.RichList, Items: []model.RichItem{nested}}}, "nest at most 3 deep"},
		{"nested item piece", []model.RichNode{{Type: model.RichList, Items: []model.RichItem{{Items: []model.RichItem{{Spans: []model.RichSpan{{Text: "x", Color: "teal"}}}}}}}}, "items[0].items[0].spans[0].color"},
		{"item piece", []model.RichNode{{Type: model.RichList, Items: []model.RichItem{{Spans: []model.RichSpan{{Text: "x", Color: "teal"}}}}}}, "items[0].spans[0].color"},
		{"text budget", []model.RichNode{para(txt(long(maxRichChars + 1)))}, "at most 4000 characters"},
		{"code budget", []model.RichNode{{Type: model.RichCode, Text: long(maxRichChars + 1)}}, "at most 4000 characters"},
		{"pill budget", []model.RichNode{para(txt(long(maxRichChars-1)), model.RichSpan{Type: "pill", Text: "xx"})}, "at most 4000 characters"},
		{"mention budget", []model.RichNode{para(txt(long(maxRichChars-1)), model.RichSpan{Type: "user", User: "nobody"})}, "at most 4000 characters"},
		{"date budget", []model.RichNode{para(txt(long(maxRichChars-1)), model.RichSpan{Type: "date", Timestamp: 1})}, "at most 4000 characters"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := normalizeRich(t, tc.content...)
			wantInvalid(t, err, tc.want)
		})
	}
}

// Rich text is a form's layout too: instructions above the fields.
func TestRichText_InAForm(t *testing.T) {
	view, err := richNormalizer().view(context.Background(), model.View{
		Type: "modal", Title: *plain("Report"), Submit: plain("Send"),
		Blocks: model.Blocks{
			{Type: model.BlockRichText, Content: []model.RichNode{{Type: model.RichList, Items: []model.RichItem{{Spans: []model.RichSpan{txt("Steps")}}}}}},
			{Type: model.BlockInput, Label: plain("What broke?"), Element: &model.BlockElement{Type: model.ElementPlainTextInput}},
		},
	})
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	if view.Blocks[0].Type != model.BlockRichText || len(view.Blocks[0].Content) != 1 {
		t.Fatalf("form blocks = %+v", view.Blocks)
	}
	_, err = richNormalizer().view(context.Background(), model.View{
		Type: "modal", Title: *plain("Report"),
		Blocks: model.Blocks{{Type: model.BlockRichText, Content: []model.RichNode{para(model.RichSpan{Text: "x", Color: "teal"})}}},
	})
	if err == nil || !strings.Contains(err.Error(), "colour must be one of") {
		t.Fatalf("err = %v, want the colour refusal as an invalid view", err)
	}
}

func TestLayoutBlocks_Normalize(t *testing.T) {
	text := func(s string) model.RichNode { return para(txt(s)) }
	out, err := richNormalizer().normalizeMessage(context.Background(), model.Blocks{
		{Type: model.BlockCallout, Icon: ":Light_Bulb:", Content: []model.RichNode{text("Freeze starts Friday")}},
		{Type: model.BlockCallout, Color: "red", Content: []model.RichNode{text("Prod is down")}},
		{Type: model.BlockToggle, Open: true,
			Summary: []model.RichSpan{{Text: "Show logs", Bold: true}},
			Blocks: model.Blocks{
				{Type: model.BlockRichText, Content: []model.RichNode{{Type: model.RichCode, Text: "panic: nil map"}}},
				{Type: model.BlockRichText, Content: []model.RichNode{text("")}},
				{Type: model.BlockDivider, BlockID: "b1"},
				{Type: model.BlockSection, Text: md("**Host** web-3")},
				{Type: model.BlockContext, Elements: []model.BlockElement{{Type: model.TextPlain, Content: "3 retries"}}},
				{Type: model.BlockTable, Columns: []model.TableColumn{{Header: "Step"}}, Rows: [][]model.TableCell{{{Text: "build"}}}},
			}},
		{Type: model.BlockToggle, Summary: []model.RichSpan{txt("Nothing inside")}, Blocks: model.Blocks{{Type: model.BlockRichText}}},
		{Type: model.BlockTable,
			Columns: []model.TableColumn{{Header: "Service"}, {Header: "Status", Align: "center"}, {Header: "p95", Align: "right"}},
			Rows: [][]model.TableCell{
				{{Text: "api"}, {Spans: []model.RichSpan{{Type: "pill", Text: "Live", Color: "green"}}}, {Text: "120 ms"}},
				{{Text: "web"}},
			}},
		{Type: model.BlockTable, Columns: []model.TableColumn{{Header: "Empty"}}},
	}, nil)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if len(out) != 4 {
		t.Fatalf("blocks = %d, want callout, callout, toggle, table (the empty toggle and table dropped)", len(out))
	}
	if c := out[0]; c.Icon != "light_bulb" || c.Color != "gray" || c.Content[0].Spans[0].Text != "Freeze starts Friday" {
		t.Fatalf("callout = %+v", c)
	}
	if out[1].Color != "red" || out[1].Icon != "" {
		t.Fatalf("red callout = %+v", out[1])
	}
	tg := out[2]
	if !tg.Open || tg.Summary[0].Text != "Show logs" || !tg.Summary[0].Bold {
		t.Fatalf("toggle = %+v", tg)
	}
	kinds := []string{}
	for _, c := range tg.Blocks {
		kinds = append(kinds, c.Type+":"+c.BlockID)
	}
	// The app's own b1 (inside the toggle) is reserved: generated IDs skip it.
	// The two callouts above took b2 and b3.
	if want := []string{"rich_text:b4", "divider:b1", "section:b5", "context:b6", "table:b7"}; !reflect.DeepEqual(kinds, want) {
		t.Fatalf("toggle children = %v, want %v", kinds, want)
	}
	tb := out[3]
	if aligns := []string{tb.Columns[0].Align, tb.Columns[1].Align, tb.Columns[2].Align}; !reflect.DeepEqual(aligns, []string{"left", "center", "right"}) {
		t.Fatalf("aligns = %v", aligns)
	}
	if tb.Rows[0][1].Spans[0].Type != "pill" || tb.Rows[0][0].Spans[0].Text != "api" || tb.Rows[0][0].Text != "" {
		t.Fatalf("row 0 = %+v", tb.Rows[0])
	}
	if len(tb.Rows[1]) != 3 || len(tb.Rows[1][2].Spans) != 0 {
		t.Fatalf("short row = %+v, want it padded to 3 cells", tb.Rows[1])
	}
}

func TestLayoutBlocks_Refusals(t *testing.T) {
	text := func(s string) model.RichNode { return para(txt(s)) }
	toggle := func(children ...model.Block) model.Block {
		return model.Block{Type: model.BlockToggle, Summary: []model.RichSpan{txt("More")}, Blocks: children}
	}
	cols := func(n int) []model.TableColumn { return make([]model.TableColumn, n) }
	rows := func(n int) [][]model.TableCell {
		out := make([][]model.TableCell, n)
		for i := range out {
			out[i] = []model.TableCell{{Text: "x"}}
		}
		return out
	}
	children := func(n int) model.Blocks {
		out := make(model.Blocks, n)
		for i := range out {
			out[i] = model.Block{Type: model.BlockDivider}
		}
		return out
	}
	many := make(model.Blocks, 0, maxBlocksPerMessage)
	for i := 0; i < maxBlocksPerMessage-1; i++ {
		many = append(many, model.Block{Type: model.BlockDivider})
	}
	for _, tc := range []struct {
		name   string
		blocks model.Blocks
		want   string
	}{
		{"callout icon", model.Blocks{{Type: model.BlockCallout, Icon: "<b>", Content: []model.RichNode{text("x")}}}, "an icon is an emoji like"},
		{"callout colour", model.Blocks{{Type: model.BlockCallout, Color: "pink", Content: []model.RichNode{text("x")}}}, "colour must be one of"},
		{"callout content", model.Blocks{{Type: model.BlockCallout, Content: []model.RichNode{{Type: model.RichHeading, Level: 9, Spans: []model.RichSpan{txt("x")}}}}}, "level is 1, 2 or 3"},
		{"toggle summary missing", model.Blocks{{Type: model.BlockToggle, Blocks: children(1)}}, "needs a summary"},
		{"toggle summary piece", model.Blocks{{Type: model.BlockToggle, Summary: []model.RichSpan{{Text: "x", Color: "teal"}}, Blocks: children(1)}}, "summary[0].color"},
		{"toggle summary long", model.Blocks{{Type: model.BlockToggle, Summary: []model.RichSpan{txt(strings.Repeat("a", maxToggleSummary+1))}, Blocks: children(1)}}, "summary is at most 300"},
		{"toggle too many", model.Blocks{toggle(children(maxToggleChildren + 1)...)}, "holds at most 20 blocks"},
		{"toggle buttons", model.Blocks{toggle(model.Block{Type: model.BlockActions, Elements: []model.BlockElement{btn("go", "Go")}})}, "a toggle holds text only"},
		{"toggle nested", model.Blocks{toggle(toggle(children(1)...))}, "a toggle holds text only"},
		{"toggle accessory", model.Blocks{toggle(model.Block{Type: model.BlockSection, Text: md("x"), Accessory: &model.BlockElement{Type: model.ElementButton, Text: plain("Go"), URL: "https://example.com"}})}, "inside another block can't have an accessory"},
		{"toggle image", model.Blocks{toggle(model.Block{Type: model.BlockContext, Elements: []model.BlockElement{{Type: model.ElementImage, ImageURL: "https://example.com/a.png", AltText: "a"}}})}, "context inside another block holds text only"},
		{"toggle child", model.Blocks{toggle(model.Block{Type: model.BlockRichText, Content: []model.RichNode{{Type: model.RichList, Style: "x"}}})}, "blocks[0].content[0]"},
		{"toggle children count", append(many, toggle(children(2)...)), "at most 50 blocks"},
		{"no columns", model.Blocks{{Type: model.BlockTable, Rows: rows(1)}}, "1 to 10 columns"},
		{"too many columns", model.Blocks{{Type: model.BlockTable, Columns: cols(maxTableColumns + 1), Rows: rows(1)}}, "1 to 10 columns"},
		{"too many rows", model.Blocks{{Type: model.BlockTable, Columns: cols(1), Rows: rows(maxTableRows + 1)}}, "at most 50 rows"},
		{"long header", model.Blocks{{Type: model.BlockTable, Columns: []model.TableColumn{{Header: strings.Repeat("a", maxTableHeaderChars+1)}}, Rows: rows(1)}}, "header is at most 100"},
		{"align", model.Blocks{{Type: model.BlockTable, Columns: []model.TableColumn{{Align: "justify"}}, Rows: rows(1)}}, "left, center or right"},
		{"wide row", model.Blocks{{Type: model.BlockTable, Columns: cols(1), Rows: [][]model.TableCell{{{Text: "a"}, {Text: "b"}}}}}, "as many cells as the table has columns (1)"},
		{"text and spans", model.Blocks{{Type: model.BlockTable, Columns: cols(1), Rows: [][]model.TableCell{{{Text: "a", Spans: []model.RichSpan{txt("b")}}}}}}, "text or spans, not both"},
		{"cell piece", model.Blocks{{Type: model.BlockTable, Columns: cols(1), Rows: [][]model.TableCell{{{Spans: []model.RichSpan{{Type: "pill", Text: "x", Color: "teal"}}}}}}}, "rows[0][0][0].color"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := richNormalizer().normalizeMessage(context.Background(), tc.blocks, nil)
			wantInvalid(t, err, tc.want)
		})
	}
}
