package service

import (
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
)

// listEndParser stops CommonMark's lazy continuation into list items. By the
// spec, a plain line typed right under a list item without indentation joins
// that item's paragraph:
//
//	- GHI
//	Additional info.
//
// renders as one item, "GHI Additional info.". In a chat the line under a
// list is the message going on, as the composer shows it, so that line starts
// a paragraph after the list instead. Indented lines still continue the item,
// and lazy lines in a blockquote are untouched.
//
// It is the paragraph parser in every other respect: it interrupts only a
// paragraph that would otherwise take the line lazily, and the paragraph it
// opens continues and closes like any other.
type listEndParser struct {
	parser.BlockParser
}

func newListEndParser() parser.BlockParser {
	return &listEndParser{BlockParser: parser.NewParagraphParser()}
}

func (b *listEndParser) Trigger() []byte { return nil }

func (b *listEndParser) CanInterruptParagraph() bool { return true }

// Open takes the line only when it would be a lazy continuation line: the open
// paragraph sits in a list item that the line is not inside of. goldmark asks
// with `parent` set to the innermost block the line still belongs to, so a
// list item between the paragraph and `parent` is one the line has left.
func (b *listEndParser) Open(parent ast.Node, reader text.Reader, pc parser.Context) (ast.Node, parser.State) {
	last := pc.LastOpenedBlock().Node
	if !ast.IsParagraph(last) {
		return nil, parser.NoChildren
	}
	for n := last.Parent(); n != nil && n != parent; n = n.Parent() {
		if n.Kind() == ast.KindListItem {
			return b.BlockParser.Open(parent, reader, pc)
		}
	}
	return nil, parser.NoChildren
}
