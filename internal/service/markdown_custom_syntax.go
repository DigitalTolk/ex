package service

import (
	"regexp"
	"strconv"
	"strings"
)

// Custom inline syntax extractor — Go port of the frontend's
// markdown-custom-syntax. Walks a text fragment and slices out
// domain tokens (mentions, hashtags, emoji shortcodes, giphy refs,
// bare URLs, image-literal markdown) into hast `ex-*` element nodes.
//
// The frontend renders ex-mention-user / ex-hashtag / ex-giphy /
// ex-bare-url / ex-emoji-shortcode / ex-media-literal directly
// through the components map — no JS-side regex pass is needed.

var (
	// Mirrors lib/mention-syntax.ts USER_MENTION_RE_GLOBAL.
	userMentionRE = regexp.MustCompile(`@\[([^|\]]+)\|([^\]]+)\]`)
	// CHANNEL_MENTION_RE_GLOBAL.
	channelMentionRE = regexp.MustCompile(`~\[([^|\]]+)\|([^\]]+)\]`)
	// GROUP_MENTION_RE — leading non-word/non-@ guard prevents
	// matching inside emails (`a@all.example.com`).
	groupMentionRE = regexp.MustCompile(`(^|[^\w@])@(all|here)\b`)
	// HASHTAG_RE — Unicode-letter-aware. Go's regexp doesn't support
	// \p{L} natively, so we use the equivalent character class.
	// 2..64 chars, letters/digits/underscore/hyphen.
	hashtagRE = regexp.MustCompile(`(^|[^\w/])#([\p{L}\p{N}_-]{2,64})`)
	// IMAGE_RE — markdown image syntax with optional =WxH suffix.
	imageRE = regexp.MustCompile(`!\[([^\]]*)\]\(([^)\s]+?)(?:\s+=(\d+)x(\d+))?\)`)
	// BARE_URL_RE — http(s) only.
	bareURLRE = regexp.MustCompile(`https?://[^\s<>"]+`)
	// Emoji shortcodes — toned variant first to avoid the bare form
	// eating part of the toned form.
	emojiTonedRE = regexp.MustCompile(`(?i):([a-z0-9_+-]+)::(skin-tone-[1-5]):`)
	emojiBareRE  = regexp.MustCompile(`(?i):([a-z0-9_+-]+):`)
)

// extractCustomTokens walks `input` and returns a slice of HastNodes:
// `text` nodes for literal text, `element` nodes for the ex-* tags.
// The order of regex application mirrors the frontend so the visible
// output matches the legacy renderer for every test fixture.
func extractCustomTokens(input string) []*HastNode {
	if input == "" {
		return nil
	}
	pieces := []*HastNode{textNode(input)}

	pieces = splitTokens(pieces, userMentionRE, func(m []string, _ int) []*HastNode {
		return []*HastNode{exElement("ex-mention-user", map[string]interface{}{
			"data-user-id": strings.TrimSpace(m[1]),
			"data-name":    strings.TrimSpace(m[2]),
			"data-value":   m[0],
		})}
	})
	pieces = splitTokens(pieces, channelMentionRE, func(m []string, _ int) []*HastNode {
		return []*HastNode{exElement("ex-mention-channel", map[string]interface{}{
			"data-channel-id": strings.TrimSpace(m[1]),
			"data-slug":       strings.TrimSpace(m[2]),
			"data-value":      m[0],
		})}
	})
	pieces = splitTokens(pieces, groupMentionRE, func(m []string, _ int) []*HastNode {
		out := []*HastNode{}
		if m[1] != "" {
			out = append(out, textNode(m[1]))
		}
		out = append(out, exElement("ex-mention-group", map[string]interface{}{
			"data-group": m[2],
			"data-value": "@" + m[2],
		}))
		return out
	})

	// Hashtags — always emitted by the server; the frontend decides
	// whether to render them as a clickable pill (when onTagClick is
	// wired) or as plain text. Storing a stable token in the hast
	// tree keeps the server agnostic of viewer context while letting
	// the React layer decide UX dynamically.
	pieces = splitTokens(pieces, hashtagRE, func(m []string, _ int) []*HastNode {
		out := []*HastNode{}
		if m[1] != "" {
			out = append(out, textNode(m[1]))
		}
		out = append(out, exElement("ex-hashtag", map[string]interface{}{
			"data-tag":   strings.ToLower(m[2]),
			"data-value": "#" + m[2],
		}))
		return out
	})

	// Image markdown — giphy refs become embeds, others become
	// literal text spans (security: no arbitrary remote media).
	pieces = splitTokens(pieces, imageRE, func(m []string, _ int) []*HastNode {
		url := m[2]
		if strings.HasPrefix(url, "giphy:") {
			props := map[string]interface{}{
				"data-id":    strings.TrimPrefix(url, "giphy:"),
				"data-value": m[0],
			}
			if m[3] != "" {
				if w, err := strconv.Atoi(m[3]); err == nil {
					props["data-width"] = w
				}
			}
			if m[4] != "" {
				if h, err := strconv.Atoi(m[4]); err == nil {
					props["data-height"] = h
				}
			}
			return []*HastNode{exElement("ex-giphy", props)}
		}
		return []*HastNode{exElement("ex-media-literal", map[string]interface{}{
			"data-value": m[0],
		})}
	})

	// Bare URLs — after images (whose parens contain URLs the image pass
	// must claim first) but BEFORE emoji shortcodes: SharePoint-style URLs
	// carry `/:x:/`, `/:w:/` … path segments that the emoji pass would
	// otherwise turn into an ❌ glyph, splitting the link in two. A colon
	// token inside a URL is part of the URL, never an emoji.
	pieces = splitTokens(pieces, bareURLRE, func(m []string, _ int) []*HastNode {
		return []*HastNode{exElement("ex-bare-url", map[string]interface{}{
			"data-href":  m[0],
			"data-value": m[0],
		})}
	})

	// Emoji shortcodes — toned first.
	pieces = splitTokens(pieces, emojiTonedRE, func(m []string, _ int) []*HastNode {
		return []*HastNode{exElement("ex-emoji-shortcode", map[string]interface{}{
			"data-name":  m[1],
			"data-skin":  m[2],
			"data-value": m[0],
		})}
	})
	pieces = splitTokens(pieces, emojiBareRE, func(m []string, _ int) []*HastNode {
		return []*HastNode{exElement("ex-emoji-shortcode", map[string]interface{}{
			"data-name":  m[1],
			"data-value": m[0],
		})}
	})

	return pieces
}

// splitTokens runs `re` across every text node in `pieces` and
// replaces matches with the nodes returned by `build`. Non-text
// nodes pass through unchanged.
func splitTokens(pieces []*HastNode, re *regexp.Regexp, build func([]string, int) []*HastNode) []*HastNode {
	out := make([]*HastNode, 0, len(pieces))
	for _, piece := range pieces {
		if piece.Type != "text" {
			out = append(out, piece)
			continue
		}
		val := piece.Value
		matches := re.FindAllStringSubmatchIndex(val, -1)
		if len(matches) == 0 {
			out = append(out, piece)
			continue
		}
		cursor := 0
		for _, m := range matches {
			start, end := m[0], m[1]
			if start > cursor {
				out = append(out, textNode(val[cursor:start]))
			}
			submatches := make([]string, 0, len(m)/2)
			for i := 0; i < len(m); i += 2 {
				if m[i] < 0 {
					submatches = append(submatches, "")
					continue
				}
				submatches = append(submatches, val[m[i]:m[i+1]])
			}
			out = append(out, build(submatches, start)...)
			cursor = end
		}
		if cursor < len(val) {
			out = append(out, textNode(val[cursor:]))
		}
	}
	return out
}

func exElement(tag string, props map[string]interface{}) *HastNode {
	return &HastNode{Type: "element", TagName: tag, Properties: props, Children: []*HastNode{}}
}
