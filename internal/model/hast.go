package model

import "encoding/json"

// marshalJSON is a thin alias for json.Marshal kept private so
// hast.MarshalJSON can reference it without polluting the package
// namespace with the standard library import on every caller.
func marshalJSON(v interface{}) ([]byte, error) { return json.Marshal(v) }

// HastNode is the JSON-serializable hast (HTML AST) shape that the
// backend emits for every rendered message. Frontend consumers
// hydrate the tree with React via hast-util-to-jsx-runtime.
//
// Three node variants share one struct:
//
//   { "type": "root",    "children": [...] }
//   { "type": "element", "tagName": "p", "properties": {...}, "children": [...] }
//   { "type": "text",    "value": "..." }
//
// Custom domain tags use `tagName: "ex-mention-user"`, `"ex-hashtag"`,
// `"ex-giphy"` and so on; the frontend's components map maps them to
// the corresponding React component (mention pill, hashtag button,
// GiphyEmbed, …) so per-viewer behaviour stays on the client without
// re-parsing on every render.
//
// Lives in `model` (not `service`) because it's a wire/data type:
// the struct is serialized over HTTP and WS, persisted/cached
// optionally, and consumed by handlers.
type HastNode struct {
	Type       string                 `json:"type"`
	TagName    string                 `json:"tagName,omitempty"`
	Properties map[string]interface{} `json:"properties,omitempty"`
	// Children is intentionally NOT marked omitempty. hast-util-to-
	// jsx-runtime reads `node.children.length` unconditionally for
	// element/root nodes — omitting an empty children array on a
	// leaf element (e.g. our `ex-mention-user` sentinel tag) crashes
	// the frontend hydrator and unmounts the entire message tree.
	// A custom MarshalJSON below skips the field for text nodes so
	// the wire format stays clean.
	Children []*HastNode `json:"children"`
	Value    string      `json:"value,omitempty"`
}

// MarshalJSON skips the `children` field for text nodes — only
// element/root nodes carry children, and the hydrator only reads
// children on those kinds. Without this, every text node would
// emit `"children": null` which is wasteful (and confusing for
// any downstream JSON consumer).
func (n *HastNode) MarshalJSON() ([]byte, error) {
	if n.Type == "text" {
		type textNode struct {
			Type  string `json:"type"`
			Value string `json:"value,omitempty"`
		}
		return marshalJSON(textNode{Type: n.Type, Value: n.Value})
	}
	type elementNode struct {
		Type       string                 `json:"type"`
		TagName    string                 `json:"tagName,omitempty"`
		Properties map[string]interface{} `json:"properties,omitempty"`
		Children   []*HastNode            `json:"children"`
	}
	// Always emit a non-nil children slice so the JSON includes the
	// `children` key even when the slice is empty — hast-util-to-jsx-
	// runtime needs an array, not undefined.
	kids := n.Children
	if kids == nil {
		kids = []*HastNode{}
	}
	return marshalJSON(elementNode{
		Type:       n.Type,
		TagName:    n.TagName,
		Properties: n.Properties,
		Children:   kids,
	})
}
