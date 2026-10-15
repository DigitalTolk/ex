package bedrock

import (
	"path"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
)

// Attachment is one file handed to the model alongside the task prompt — the
// bytes of a chat attachment, typed by the content type the server verified
// at upload. It rides the FIRST user message as an image or document block,
// so the model sees it exactly as it sees the prompt text (as data).
type Attachment struct {
	// Name is the display file name. Bedrock restricts document names to a
	// small character set, so it is sanitised (DocumentName) before use.
	Name        string
	ContentType string
	Data        []byte
}

// Converse limits (per request) for the content blocks the loop builds. The
// caller enforces them while it still holds the sizes, before reading bytes.
const (
	MaxImages        = 20
	MaxDocuments     = 5
	MaxImageBytes    = 3932160 // 3.75 MiB
	MaxDocumentBytes = 4718592 // 4.5 MiB
	maxDocNameLen    = 64
)

var imageFormats = map[string]types.ImageFormat{
	"image/png":  types.ImageFormatPng,
	"image/jpeg": types.ImageFormatJpeg,
	"image/jpg":  types.ImageFormatJpeg,
	"image/gif":  types.ImageFormatGif,
	"image/webp": types.ImageFormatWebp,
}

var documentFormats = map[string]types.DocumentFormat{
	"application/pdf":    types.DocumentFormatPdf,
	"text/csv":           types.DocumentFormatCsv,
	"application/msword": types.DocumentFormatDoc,
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": types.DocumentFormatDocx,
	"application/vnd.ms-excel": types.DocumentFormatXls,
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": types.DocumentFormatXlsx,
	"text/html":     types.DocumentFormatHtml,
	"text/plain":    types.DocumentFormatTxt,
	"text/markdown": types.DocumentFormatMd,
}

// Extensions resolve a generic content type (octet-stream, or a text/plain
// that is really a .md) — the verified bytes decide the type at upload, but
// office formats are only ever known by their extension.
var documentExtensions = map[string]types.DocumentFormat{
	".pdf":  types.DocumentFormatPdf,
	".csv":  types.DocumentFormatCsv,
	".doc":  types.DocumentFormatDoc,
	".docx": types.DocumentFormatDocx,
	".xls":  types.DocumentFormatXls,
	".xlsx": types.DocumentFormatXlsx,
	".html": types.DocumentFormatHtml,
	".htm":  types.DocumentFormatHtml,
	".txt":  types.DocumentFormatTxt,
	".md":   types.DocumentFormatMd,
}

// ImageFormat maps a content type to Converse's image format.
func ImageFormat(contentType string) (types.ImageFormat, bool) {
	f, ok := imageFormats[mediaType(contentType)]
	return f, ok
}

// DocumentFormat maps a content type, or failing that the file name's
// extension, to Converse's document format.
func DocumentFormat(contentType, name string) (types.DocumentFormat, bool) {
	if f, ok := documentFormats[mediaType(contentType)]; ok {
		return f, ok
	}
	f, ok := documentExtensions[strings.ToLower(path.Ext(name))]
	return f, ok
}

// Supported reports whether the loop can hand this file to the model at all.
func Supported(contentType, name string) bool {
	if _, ok := ImageFormat(contentType); ok {
		return true
	}
	_, ok := DocumentFormat(contentType, name)
	return ok
}

func mediaType(contentType string) string {
	return strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
}

// DocumentName renders a file name in the only alphabet Converse accepts for
// document names (letters, digits, single spaces, hyphens, parentheses,
// brackets), clipped, never empty. The extension is kept as a word so the
// model still knows "report pdf" was a PDF.
func DocumentName(name string) string {
	var b strings.Builder
	space := true // leading whitespace is dropped too
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '(', r == ')', r == '[', r == ']':
			b.WriteRune(r)
			space = false
		default:
			if !space {
				b.WriteByte(' ')
				space = true
			}
		}
	}
	out := strings.TrimSpace(b.String())
	if len(out) > maxDocNameLen {
		out = strings.TrimSpace(out[:maxDocNameLen])
	}
	if out == "" {
		return "file"
	}
	return out
}

// attachmentBlocks converts the attachments into content blocks, dropping any
// the loop cannot represent (callers filter with Supported first; this keeps
// the request valid regardless). Document names are made unique: Converse
// rejects duplicates within one request.
func attachmentBlocks(atts []Attachment) []types.ContentBlock {
	var blocks []types.ContentBlock
	names := map[string]int{}
	for _, a := range atts {
		if f, ok := ImageFormat(a.ContentType); ok {
			blocks = append(blocks, &types.ContentBlockMemberImage{Value: types.ImageBlock{
				Format: f,
				Source: &types.ImageSourceMemberBytes{Value: a.Data},
			}})
			continue
		}
		f, ok := DocumentFormat(a.ContentType, a.Name)
		if !ok {
			continue
		}
		name := DocumentName(a.Name)
		names[name]++
		if n := names[name]; n > 1 {
			name = name + " (" + itoa(n) + ")"
		}
		blocks = append(blocks, &types.ContentBlockMemberDocument{Value: types.DocumentBlock{
			Format: f,
			Name:   aws.String(name),
			Source: &types.DocumentSourceMemberBytes{Value: a.Data},
		}})
	}
	return blocks
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for ; n > 0; n /= 10 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
	}
	return string(digits)
}
