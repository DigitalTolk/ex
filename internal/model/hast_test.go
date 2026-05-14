package model

import (
	"encoding/json"
	"strings"
	"testing"
)

// hast-util-to-jsx-runtime reads `node.children.length` on every
// element/root unconditionally — if Go's `omitempty` strips an
// empty children array from a leaf element (e.g. ex-mention-user),
// the frontend hydrator crashes and React unmounts the entire
// message tree. These tests lock the wire format so that regression
// can't happen again.

func TestHastNode_ElementAlwaysEmitsChildrenArray(t *testing.T) {
	leaf := &HastNode{
		Type:    "element",
		TagName: "ex-mention-user",
		Properties: map[string]interface{}{
			"data-user-id": "u-1",
		},
		// Children intentionally nil — a real Go caller might emit
		// this when the element has no descendants.
	}
	raw, err := json.Marshal(leaf)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(raw), `"children":[]`) {
		t.Errorf("leaf element must serialise children:[], got %s", raw)
	}
}

func TestHastNode_ElementWithEmptyChildrenStillEmitsArray(t *testing.T) {
	leaf := &HastNode{
		Type:     "element",
		TagName:  "hr",
		Children: []*HastNode{},
	}
	raw, err := json.Marshal(leaf)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(raw), `"children":[]`) {
		t.Errorf("explicit empty children should still emit []: %s", raw)
	}
}

func TestHastNode_TextNodeOmitsChildrenAndProperties(t *testing.T) {
	leaf := &HastNode{Type: "text", Value: "hello"}
	raw, err := json.Marshal(leaf)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(raw)
	if strings.Contains(s, "children") {
		t.Errorf("text node should not carry a children field: %s", raw)
	}
	if strings.Contains(s, "properties") {
		t.Errorf("text node should not carry a properties field: %s", raw)
	}
	if !strings.Contains(s, `"value":"hello"`) {
		t.Errorf("text node missing value: %s", raw)
	}
}

func TestHastNode_RootEmitsChildrenEvenWhenEmpty(t *testing.T) {
	root := &HastNode{Type: "root", Children: nil}
	raw, err := json.Marshal(root)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(raw), `"children":[]`) {
		t.Errorf("root must always emit children:[], got %s", raw)
	}
}

func TestHastNode_RoundTripPreservesNestedShape(t *testing.T) {
	original := &HastNode{
		Type: "root",
		Children: []*HastNode{
			{
				Type:    "element",
				TagName: "p",
				Children: []*HastNode{
					{Type: "text", Value: "hi"},
				},
			},
		},
	}
	raw, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded HastNode
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded.Type != "root" || len(decoded.Children) != 1 {
		t.Fatalf("roundtrip lost root, got %+v", decoded)
	}
	p := decoded.Children[0]
	if p.TagName != "p" || len(p.Children) != 1 || p.Children[0].Value != "hi" {
		t.Errorf("roundtrip lost paragraph: %+v", p)
	}
}
