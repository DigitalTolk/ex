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
	// v2: filename uses the `simple` analyzer (so "chat-icon" matches
	// "chat-icon.png"); files docs include parentMessageIds parallel
	// to messageIds so file hits in thread replies link correctly.
	IndexFiles = "ex_files_v2"
)

// indexMappings is the mapping JSON used at index-creation time. The
// bodies stay deliberately minimal — `text` for natural-language fields
// (we want the standard analyzer / tokenization), `keyword` for fields
// we filter by exactly, and a single `body` analyzer that splits on
// whitespace and case-folds so `#tag` searches match `#TAG` and vice
// versa.
var indexMappings = map[string]string{
	IndexUsers: `{
		"mappings": {
			"properties": {
				"id":          {"type": "keyword"},
				"displayName": {"type": "text"},
				"email":       {"type": "text"},
				"systemRole":  {"type": "keyword"},
				"status":      {"type": "keyword"}
			}
		}
	}`,
	IndexChannels: `{
		"mappings": {
			"properties": {
				"id":          {"type": "keyword"},
				"name":        {"type": "text"},
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
