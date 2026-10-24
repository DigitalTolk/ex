package search

import (
	"fmt"
	"strings"
)

// Logical index names. On a fresh cluster EnsureIndices creates each as
// a plain physical index; a mapping/analyzer change is rolled out with
// `migrate search-reindex`, which builds a `<name>-r<nanos>` staging
// index and atomically swaps an alias called `<name>` onto it
// (BeginIndexRebuild/PromoteIndex) — readers and writers always address
// the logical name and never see a gap.
const (
	IndexUsers    = "ex_users"
	IndexChannels = "ex_channels"
	IndexMessages = "ex_messages"
	IndexFiles    = "ex_files"
)

// usersChannelsSchemaVersion is the mapping/analyzer generation of the ex_users
// and ex_channels indices — the two that carry the autocomplete analyzer and
// are auto-rebuilt at boot. Bump it (MONOTONICALLY — only ever increase) when a
// mapping or analyzer change on those indices needs a rebuild to take effect.
//
// It is stamped into a rebuilt index's `_meta.schemaVersion` at PROMOTE time
// (see BeginIndexRebuild), never at plain EnsureIndices creation. So a live
// index advertises a version only after a completed rebuild; a freshly-created
// (empty) or pre-versioning index has no stamp and reads as stale. At boot
// StartIfStale compares live vs desired and, on `missing || live < desired`,
// auto-rolls a zero-downtime rebuild. Using `<` (not `!=`) keeps a mixed-version
// rolling deploy from ping-ponging: an older binary that sees a newer live index
// treats it as fresh and does nothing.
const usersChannelsSchemaVersion = 1

// desiredSchemaVersion maps a logical index to the generation a rebuild stamps
// into it. Only indices with an auto-rebuild story appear here; messages/files
// carry no `_meta` and are never auto-rebuilt (a full reindex stays manual).
var desiredSchemaVersion = map[string]int{
	IndexUsers:    usersChannelsSchemaVersion,
	IndexChannels: usersChannelsSchemaVersion,
}

// stampSchemaMeta injects an `_meta.schemaVersion` block into a mapping body,
// immediately after the opening of its `"mappings"` object, so a PROMOTED index
// advertises its generation. Only staging indices of versioned logical indices
// are stamped — EnsureIndices creates unstamped bodies on purpose, so a
// brand-new empty index reads as stale and gets auto-populated on first boot.
// Returns an error if the body has no `"mappings"` object (a malformed mapping
// constant), so a typo can't silently ship an unversioned index.
func stampSchemaMeta(body string, version int) (string, error) {
	const marker = `"mappings": {`
	i := strings.Index(body, marker)
	if i < 0 {
		return "", fmt.Errorf("search: mapping body missing %q", marker)
	}
	at := i + len(marker)
	meta := fmt.Sprintf(` "_meta": { "schemaVersion": %d },`, version)
	return body[:at] + meta + body[at:], nil
}

// autocompleteSettings defines a custom `autocomplete` analyzer used at
// INDEX time on the `.autocomplete` subfields of displayName / email /
// channel name. It case-folds and emits n-grams (2..10 chars) of EVERY
// position, so a stored token like "bar123" is indexed as "ba","ar",...,
// "12","23","123","bar",...,"bar123". Unlike edge n-grams (prefix-only),
// plain n-grams give true SUBSTRING/infix matching: "123" → "bar123" and
// "abd" → "Abdur". The SEARCH-time analyzer is `standard` (see the subfield
// mapping) so the *query* is NOT itself n-grammed — typing "123" produces
// the single token "123" which matches the "123" n-gram — on top of the
// existing full-token fuzzy match (which still handles longer queries).
// `max_ngram_diff` must be raised: n-gram tokenizers/filters otherwise cap
// (max_gram - min_gram) at 1.
const autocompleteSettings = `
	"settings": {
		"index": { "max_ngram_diff": 10 },
		"analysis": {
			"filter": {
				"autocomplete_filter": {
					"type": "ngram",
					"min_gram": 2,
					"max_gram": 10
				}
			},
			"analyzer": {
				"autocomplete": {
					"type": "custom",
					"tokenizer": "standard",
					"filter": ["lowercase", "autocomplete_filter"]
				}
			}
		}
	},`

// autocompleteField is the mapping fragment for a `text` field that also
// carries an `.autocomplete` n-gram subfield. The base field keeps
// the standard analyzer (full-token fuzzy match); the subfield is
// index-analyzed with `autocomplete` and search-analyzed with `standard`.
const autocompleteField = `{
				"type": "text",
				"fields": {
					"autocomplete": {
						"type": "text",
						"analyzer": "autocomplete",
						"search_analyzer": "standard"
					}
				}
			}`

// reactionsMapping keeps a message's reactions (emoji → user IDs) in _source,
// where search hits read them, without mapping a field per emoji: mapped
// dynamically, every distinct emoji added two fields until the index hit
// index.mapping.total_fields.limit and rejected new documents.
const reactionsMapping = `{"type": "object", "dynamic": false}`

// mappingUpdates are additive mapping changes put onto an index that already
// exists (a new index gets its full body from indexMappings). They must be
// valid on an index created with any earlier mapping.
var mappingUpdates = map[string]string{
	IndexMessages: `{"properties": {"reactions": ` + reactionsMapping + `}}`,
}

// messagesFieldLimit raises ex_messages' index.mapping.total_fields.limit
// from OpenSearch's default of 1000. Indices created before reactions were
// unmapped already carry ~500 per-emoji fields, which left the default with
// no headroom for new fields.
const messagesFieldLimit = 3000

// messagesSettings is the creation-time settings block of ex_messages, so a
// new or rebuilt index starts with the raised limit.
var messagesSettings = fmt.Sprintf(`
	"settings": {
		"index": { "mapping": { "total_fields": { "limit": %d } } }
	},`, messagesFieldLimit)

// settingsUpdates are dynamic index settings put onto an index that already
// exists, so a live index converges on what a newly created one gets.
var settingsUpdates = map[string]string{
	IndexMessages: fmt.Sprintf(`{"index": {"mapping": {"total_fields": {"limit": %d}}}}`, messagesFieldLimit),
}

// indexMappings is the mapping JSON used at index-creation time. The
// bodies stay deliberately minimal — `text` for natural-language fields
// (we want the standard analyzer / tokenization), `keyword` for fields
// we filter by exactly, and a single `body` analyzer that splits on
// whitespace and case-folds so `#tag` searches match `#TAG` and vice
// versa. The user/channel name fields additionally carry an
// `.autocomplete` n-gram subfield for substring/infix matching.
var indexMappings = map[string]string{
	IndexUsers: `{
		` + autocompleteSettings + `
		"mappings": {
			"properties": {
				"id":          {"type": "keyword"},
				"displayName": ` + autocompleteField + `,
				"email":       ` + autocompleteField + `,
				"systemRole":  {"type": "keyword"},
				"status":      {"type": "keyword"}
			}
		}
	}`,
	IndexChannels: `{
		` + autocompleteSettings + `
		"mappings": {
			"properties": {
				"id":          {"type": "keyword"},
				"name":        ` + autocompleteField + `,
				"slug":        {"type": "keyword"},
				"description": {"type": "text"},
				"type":        {"type": "keyword"},
				"archived":    {"type": "boolean"}
			}
		}
	}`,
	IndexMessages: `{
		` + messagesSettings + `
		"mappings": {
			"properties": {
				"id":              {"type": "keyword"},
				"parentId":        {"type": "keyword"},
				"parentType":      {"type": "keyword"},
				"parentMessageID": {"type": "keyword"},
				"authorId":        {"type": "keyword"},
				"body":            {"type": "text"},
				"tags":            {"type": "keyword"},
				"attachmentIds":   {"type": "keyword"},
				"hasFiles":        {"type": "boolean"},
				"createdAt":       {"type": "date"},
				"reactions":       ` + reactionsMapping + `
			}
		}
	}`,
	IndexFiles: `{
		"mappings": {
			"properties": {
				"id":               {"type": "keyword"},
				"filename":         {"type": "text", "analyzer": "simple"},
				"contentType":      {"type": "keyword"},
				"size":             {"type": "long"},
				"sharedBy":         {"type": "keyword"},
				"parentIds":        {"type": "keyword"},
				"messageIds":       {"type": "keyword"},
				"parentMessageIds": {"type": "keyword"},
				"createdAt":        {"type": "date"}
			}
		}
	}`,
}
