package store

import (
	"crypto/rand"
	"testing"
	"time"

	"github.com/oklog/ulid/v2"
)

// ReadWatermarkID sorts after every ID minted at or before t and before any
// ID minted in a later millisecond — the ordering the "New" divider relies on.
func TestReadWatermarkID(t *testing.T) {
	at := time.UnixMilli(1_700_000_000_000)
	mark := ReadWatermarkID(at)
	for range 50 {
		before := ulid.MustNew(ulid.Timestamp(at), rand.Reader).String()
		after := ulid.MustNew(ulid.Timestamp(at.Add(time.Millisecond)), rand.Reader).String()
		if before >= mark {
			t.Fatalf("ID minted at t (%s) should sort before the watermark (%s)", before, mark)
		}
		if mark >= after {
			t.Fatalf("watermark (%s) should sort before an ID minted at t+1ms (%s)", mark, after)
		}
	}
}
