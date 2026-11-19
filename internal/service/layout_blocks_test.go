package service

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func column(width int, children ...model.Block) model.Block {
	return model.Block{Type: model.BlockColumn, Width: width, Blocks: children}
}

func richPara(s string) model.Block {
	return model.Block{Type: model.BlockRichText, Content: []model.RichNode{para(txt(s))}}
}

func barChart(labels []string, series ...model.ChartSeries) model.Block {
	return model.Block{Type: model.BlockChart, Kind: model.ChartBar, Labels: labels, Series: series}
}

func TestColumns_Normalize(t *testing.T) {
	out, err := richNormalizer().normalizeMessage(context.Background(), model.Blocks{
		{Type: model.BlockColumns, Blocks: model.Blocks{
			column(0,
				model.Block{Type: model.BlockHeader, Text: plain("Revenue")},
				model.Block{Type: model.BlockCallout, Color: "green", Content: []model.RichNode{para(txt("€84k"))}},
			),
			column(2, barChart([]string{"Mon", "Tue"}, model.ChartSeries{Values: []float64{1, 2}})),
			column(1, richPara("")),
		}},
		{Type: model.BlockColumns, Blocks: model.Blocks{column(1, richPara("")), column(1)}},
	}, nil)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("blocks = %d, want the row with no content dropped", len(out))
	}
	row := out[0]
	widths := []int{}
	counts := []int{}
	for _, c := range row.Blocks {
		widths = append(widths, c.Width)
		counts = append(counts, len(c.Blocks))
		if c.Type != model.BlockColumn || c.BlockID == "" {
			t.Fatalf("column = %+v, want a named column", c)
		}
	}
	// An empty column stays, as space; a missing width is 1.
	if !reflect.DeepEqual(widths, []int{1, 2, 1}) || !reflect.DeepEqual(counts, []int{2, 1, 0}) {
		t.Fatalf("widths %v, children %v", widths, counts)
	}
	if row.Blocks[1].Blocks[0].Kind != model.ChartBar {
		t.Fatalf("chart in column = %+v", row.Blocks[1].Blocks[0])
	}
}

func TestColumns_Refusals(t *testing.T) {
	children := func(n int) model.Blocks {
		out := make(model.Blocks, n)
		for i := range out {
			out[i] = model.Block{Type: model.BlockDivider}
		}
		return out
	}
	many := make(model.Blocks, 0, maxBlocksPerMessage)
	for i := 0; i < maxBlocksPerMessage-2; i++ {
		many = append(many, model.Block{Type: model.BlockDivider})
	}
	row := func(cols ...model.Block) model.Block { return model.Block{Type: model.BlockColumns, Blocks: cols} }
	for _, tc := range []struct {
		name   string
		blocks model.Blocks
		want   string
	}{
		{"one column", model.Blocks{row(column(1, richPara("x")))}, "2 or 3 column blocks"},
		{"four columns", model.Blocks{row(column(1), column(1), column(1), column(1))}, "2 or 3 column blocks"},
		{"not a column", model.Blocks{row(column(1), richPara("x"))}, "columns hold column blocks"},
		{"width too big", model.Blocks{row(column(4, richPara("x")), column(1))}, "width is 1 to 3"},
		{"width negative", model.Blocks{row(column(-1, richPara("x")), column(1))}, "width is 1 to 3"},
		{"toggle in column", model.Blocks{row(column(1, model.Block{Type: model.BlockToggle}), column(1))}, "a column holds text, tables, callouts and charts"},
		{"buttons in column", model.Blocks{row(column(1, model.Block{Type: model.BlockActions}), column(1))}, "a column holds text"},
		{"too many children", model.Blocks{row(column(1, children(maxColumnChildren+1)...), column(1))}, "holds at most 10 blocks"},
		{"bad child", model.Blocks{row(column(1, model.Block{Type: model.BlockChart, Kind: "pie"}), column(1))}, "blocks[0].blocks[0].kind"},
		{"column id", model.Blocks{row(model.Block{Type: model.BlockColumn, BlockID: strings.Repeat("x", 256), Blocks: model.Blocks{richPara("x")}}, column(1))}, "block_id"},
		{"block limit", append(many, row(column(1, children(2)...), column(1, children(1)...))), "at most 50 blocks"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := richNormalizer().normalizeMessage(context.Background(), tc.blocks, nil)
			wantInvalid(t, err, tc.want)
		})
	}
}

func TestChart_Normalize(t *testing.T) {
	out, err := richNormalizer().normalizeMessage(context.Background(), model.Blocks{
		{Type: model.BlockChart, Kind: model.ChartBar, Text: plain(" Errors per day "), Unit: "%",
			Labels: []string{"Mon", "Tue"},
			Series: []model.ChartSeries{{Name: " api ", Values: []float64{1.5, 2}}, {Name: "web", Values: []float64{0, 3}}}},
		{Type: model.BlockChart, Kind: model.ChartLine, Text: plain("  "),
			Labels: []string{"Q1", "Q2", "Q3"}, Series: []model.ChartSeries{{Values: []float64{-2, 0, 4}}}},
		{Type: model.BlockChart, Kind: model.ChartDonut,
			Labels: []string{"Won", "Lost"}, Series: []model.ChartSeries{{Values: []float64{3, 0}}}},
	}, nil)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	bar := out[0]
	if bar.Text == nil || bar.Text.Text != "Errors per day" || bar.Text.Type != model.TextPlain || bar.Unit != "%" {
		t.Fatalf("bar = %+v", bar)
	}
	if bar.Series[0].Name != "api" || !reflect.DeepEqual(bar.Series[1].Values, []float64{0, 3}) {
		t.Fatalf("bar series = %+v", bar.Series)
	}
	if out[1].Text != nil || out[1].Series[0].Values[0] != -2 {
		t.Fatalf("line = %+v, want no title and its negative value kept", out[1])
	}
	if out[2].Kind != model.ChartDonut || len(out[2].Labels) != 2 {
		t.Fatalf("donut = %+v", out[2])
	}
}

func TestChart_Refusals(t *testing.T) {
	labels := func(n int) []string {
		out := make([]string, n)
		for i := range out {
			out[i] = "l"
		}
		return out
	}
	values := func(n int, v float64) []float64 {
		out := make([]float64, n)
		for i := range out {
			out[i] = v
		}
		return out
	}
	named := func(n, points int) []model.ChartSeries {
		out := make([]model.ChartSeries, n)
		for i := range out {
			out[i] = model.ChartSeries{Name: "s", Values: values(points, 1)}
		}
		return out
	}
	one := []model.ChartSeries{{Values: []float64{1}}}
	for _, tc := range []struct {
		name  string
		chart model.Block
		want  string
	}{
		{"kind", model.Block{Kind: "pie", Labels: []string{"a"}, Series: one}, "bar, line or donut"},
		{"title", model.Block{Kind: "bar", Text: plain(strings.Repeat("t", maxChartTitleChars+1)), Labels: []string{"a"}, Series: one}, "title is at most 100"},
		{"unit", model.Block{Kind: "bar", Unit: "kilograms", Labels: []string{"a"}, Series: one}, "unit is at most 8"},
		{"no labels", model.Block{Kind: "bar", Series: one}, "1 to 100 labels"},
		{"too many labels", model.Block{Kind: "line", Labels: labels(maxChartLabels + 1), Series: one}, "1 to 100 labels"},
		{"long label", model.Block{Kind: "bar", Labels: []string{strings.Repeat("l", maxChartLabelChars+1)}, Series: one}, "label is at most 24"},
		{"no series", model.Block{Kind: "bar", Labels: []string{"a"}}, "1 to 5 series"},
		{"too many series", model.Block{Kind: "line", Labels: []string{"a"}, Series: named(maxChartSeries+1, 1)}, "1 to 5 series"},
		{"bar labels", model.Block{Kind: "bar", Labels: labels(maxChartBarLabels + 1), Series: named(1, maxChartBarLabels+1)}, "at most 30 labels and 60 bars"},
		{"bar count", model.Block{Kind: "bar", Labels: labels(25), Series: named(3, 25)}, "at most 30 labels and 60 bars"},
		{"donut series", model.Block{Kind: "donut", Labels: []string{"a"}, Series: named(2, 1)}, "one series of at most 5 slices"},
		{"donut slices", model.Block{Kind: "donut", Labels: labels(maxDonutSlices + 1), Series: named(1, maxDonutSlices+1)}, "one series of at most 5 slices"},
		{"long name", model.Block{Kind: "bar", Labels: []string{"a"}, Series: []model.ChartSeries{{Name: strings.Repeat("n", maxChartNameChars+1), Values: []float64{1}}}}, "name is at most 40"},
		{"unnamed of many", model.Block{Kind: "line", Labels: []string{"a"}, Series: []model.ChartSeries{{Name: "a", Values: []float64{1}}, {Values: []float64{1}}}}, "each needs a name"},
		{"value count", model.Block{Kind: "bar", Labels: []string{"a", "b"}, Series: one}, "one value per label (2)"},
		{"huge value", model.Block{Kind: "line", Labels: []string{"a"}, Series: []model.ChartSeries{{Values: []float64{2e15}}}}, "a value is at most"},
		{"negative bar", model.Block{Kind: "bar", Labels: []string{"a"}, Series: []model.ChartSeries{{Values: []float64{-1}}}}, "can't be negative"},
		{"empty donut", model.Block{Kind: "donut", Labels: []string{"a"}, Series: []model.ChartSeries{{Values: []float64{0}}}}, "a value above zero"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.chart.Type = model.BlockChart
			_, err := richNormalizer().normalizeMessage(context.Background(), model.Blocks{tc.chart}, nil)
			wantInvalid(t, err, tc.want)
		})
	}
}
