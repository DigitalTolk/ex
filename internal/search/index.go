package search

// Index name constants. Kept simple (no aliases / per-deploy suffixes)
// because the workspace's data volume is small enough that an in-place
// reindex is acceptable. When the analyzer or shape of an index
// changes, bump the suffix here — EnsureIndices will create the new
// one fresh with the new mapping; the admin reindex then repopulates.
// (Old indexes become orphaned and can be dropped manually.)
const (
	IndexUsers    = "ex_users"
	IndexChannels = "ex_channels"
	IndexMessages = "ex_messages"
	IndexFiles    = "ex_files"
)

// autocompleteSettings defines a custom `autocomplete` analyzer used at
// INDEX time on the `.autocomplete` subfields of displayName / email /
// channel name. It case-folds and emits edge n-grams (2..20 chars) so a
// stored token like "Abdur" is indexed as "ab", "abd", "abdu", "abdur".
// The SEARCH-time analyzer is `standard` (see the subfield mapping) so
// the *query* is NOT itself n-grammed — typing "abd" produces the single
// token "abd", which then matches the "abd" edge-gram of "Abdur". This
// gives substring/prefix autocomplete ("abd" → "Muhammad Abdur Rehman")
// on top of the existing full-token fuzzy match.
const autocompleteSettings = `
	"settings": {
		"analysis": {
			"filter": {
				"autocomplete_filter": {
					"type": "edge_ngram",
					"min_gram": 2,
					"max_gram": 20
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
// carries an `.autocomplete` edge-ngram subfield. The base field keeps
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

// indexMappings is the mapping JSON used at index-creation time. The
// bodies stay deliberately minimal — `text` for natural-language fields
// (we want the standard analyzer / tokenization), `keyword` for fields
// we filter by exactly, and a single `body` analyzer that splits on
// whitespace and case-folds so `#tag` searches match `#TAG` and vice
// versa. The user/channel name fields additionally carry an
// `.autocomplete` edge-ngram subfield for prefix/substring matching.
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
				"createdAt":       {"type": "date"}
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
