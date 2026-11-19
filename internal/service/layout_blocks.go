package service

import (
	"context"
	"fmt"
	"math"
	"strings"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/model"
)

// Columns and chart limits.
const (
	minColumns         = 2
	maxColumns         = 3
	maxColumnWidth     = 3 // a column's share of the row, 1 to 3
	maxColumnChildren  = 10
	maxChartSeries     = 5 // the validated colour order has five hues
	maxChartLabels     = 100
	maxChartBars       = 60 // labels × series, for a bar chart
	maxChartBarLabels  = 30
	maxDonutSlices     = 5
	maxChartTitleChars = 100
	maxChartLabelChars = 24
	maxChartNameChars  = 40
	maxChartUnitChars  = 8
	maxChartValue      = 1e15
)

// columns checks 2 or 3 column blocks and what each holds (model.IsColumnChild).
// Each column takes a block ID; an empty column stays, as space, unless every
// column is empty and the row is dropped.
func (n *blockNormalizer) columns(ctx context.Context, at string, b model.Block, out *model.Block) (bool, error) {
	if len(b.Blocks) < minColumns || len(b.Blocks) > maxColumns {
		return false, invalidBlocks("%s.blocks: columns hold %d or %d column blocks", at, minColumns, maxColumns)
	}
	cols := make(model.Blocks, len(b.Blocks))
	filled := false
	for i, c := range b.Blocks {
		cat := fmt.Sprintf("%s.blocks[%d]", at, i)
		if c.Type != model.BlockColumn {
			return false, invalidBlocks("%s: columns hold column blocks", cat)
		}
		width := c.Width
		if width == 0 {
			width = 1
		}
		if width < 1 || width > maxColumnWidth {
			return false, invalidBlocks("%s.width: a column's width is 1 to %d", cat, maxColumnWidth)
		}
		children, err := n.childBlocks(ctx, cat, c.Blocks, maxColumnChildren, model.IsColumnChild,
			"a column holds text, tables, callouts and charts: rich_text, table, divider, section, context, header, callout and chart blocks")
		if err != nil {
			return false, err
		}
		filled = filled || len(children) > 0
		id, err := n.blockID(cat, c.BlockID)
		if err != nil {
			return false, err
		}
		cols[i] = model.Block{Type: model.BlockColumn, BlockID: id, Width: width, Blocks: children}
	}
	if !filled {
		return false, nil
	}
	out.Blocks = cols
	return true, nil
}

// chart checks a chart's kind, labels and series. Series take colours in a
// fixed, validated order on the client, so an app never picks a pair that
// colour-blind readers can't tell apart.
func chart(at string, b model.Block, out *model.Block) (bool, error) {
	switch b.Kind {
	case model.ChartBar, model.ChartLine, model.ChartDonut:
	default:
		return false, invalidBlocks("%s.kind: a chart is bar, line or donut", at)
	}
	if b.Text != nil {
		title := strings.TrimSpace(b.Text.Text)
		if utf8.RuneCountInString(title) > maxChartTitleChars {
			return false, invalidBlocks("%s.text: a chart's title is at most %d characters", at, maxChartTitleChars)
		}
		if title != "" {
			out.Text = &model.TextObject{Type: model.TextPlain, Text: title}
		}
	}
	if utf8.RuneCountInString(b.Unit) > maxChartUnitChars {
		return false, invalidBlocks("%s.unit: a unit is at most %d characters", at, maxChartUnitChars)
	}
	labels := len(b.Labels)
	if labels == 0 || labels > maxChartLabels {
		return false, invalidBlocks("%s.labels: a chart has 1 to %d labels", at, maxChartLabels)
	}
	for i, l := range b.Labels {
		if utf8.RuneCountInString(l) > maxChartLabelChars {
			return false, invalidBlocks("%s.labels[%d]: a label is at most %d characters", at, i, maxChartLabelChars)
		}
	}
	if len(b.Series) == 0 || len(b.Series) > maxChartSeries {
		return false, invalidBlocks("%s.series: a chart has 1 to %d series", at, maxChartSeries)
	}
	switch b.Kind {
	case model.ChartBar:
		if labels > maxChartBarLabels || labels*len(b.Series) > maxChartBars {
			return false, invalidBlocks("%s: a bar chart has at most %d labels and %d bars in all", at, maxChartBarLabels, maxChartBars)
		}
	case model.ChartDonut:
		if len(b.Series) != 1 || labels > maxDonutSlices {
			return false, invalidBlocks("%s: a donut has one series of at most %d slices", at, maxDonutSlices)
		}
	}
	series := make([]model.ChartSeries, len(b.Series))
	for i, s := range b.Series {
		sat := fmt.Sprintf("%s.series[%d]", at, i)
		name := strings.TrimSpace(s.Name)
		if utf8.RuneCountInString(name) > maxChartNameChars {
			return false, invalidBlocks("%s.name: a series name is at most %d characters", sat, maxChartNameChars)
		}
		if name == "" && len(b.Series) > 1 {
			return false, invalidBlocks("%s.name: with more than one series, each needs a name for the legend", sat)
		}
		if len(s.Values) != labels {
			return false, invalidBlocks("%s.values: a series has one value per label (%d)", sat, labels)
		}
		total := 0.0
		for j, v := range s.Values {
			if math.Abs(v) > maxChartValue {
				return false, invalidBlocks("%s.values[%d]: a value is at most %g", sat, j, maxChartValue)
			}
			if v < 0 && b.Kind != model.ChartLine {
				return false, invalidBlocks("%s.values[%d]: bar and donut values can't be negative", sat, j)
			}
			total += v
		}
		if b.Kind == model.ChartDonut && total == 0 {
			return false, invalidBlocks("%s.values: a donut needs a value above zero", sat)
		}
		series[i] = model.ChartSeries{Name: name, Values: s.Values}
	}
	out.Kind, out.Labels, out.Series, out.Unit = b.Kind, b.Labels, series, b.Unit
	return true, nil
}
