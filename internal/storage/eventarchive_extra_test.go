package storage

import (
	"context"
	"errors"
	"io"
	"math"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// errBody is a reader that always fails — drives Load's ReadAll error arm.
type errBody struct{}

func (errBody) Read([]byte) (int, error) { return 0, errors.New("read exploded") }

// errBodyS3 serves a body whose Read fails.
type errBodyS3 struct{ memS3 }

func (errBodyS3) GetObject(_ context.Context, _ *s3.GetObjectInput, _ ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	return &s3.GetObjectOutput{Body: io.NopCloser(errBody{}), ContentLength: aws.Int64(1)}, nil
}

func TestEventArchive_ArchiveMarshalError(t *testing.T) {
	arch := NewEventArchive(&S3Client{client: &memS3{}, bucket: "b"})
	// NaN is not representable in JSON — Marshal fails before any S3 call.
	events := []*model.RunEvent{{RunID: "r", Seq: 1, Payload: map[string]any{"bad": math.NaN()}}}
	if err := arch.Archive(context.Background(), "r", events); err == nil {
		t.Fatal("archive with unmarshalable payload: want error")
	}
}

func TestEventArchive_Delete(t *testing.T) {
	m := &memS3{}
	arch := NewEventArchive(&S3Client{client: m, bucket: "b"})
	if err := arch.Archive(context.Background(), "r1", []*model.RunEvent{{RunID: "r1", Seq: 1}}); err != nil {
		t.Fatalf("archive: %v", err)
	}
	if err := arch.Delete(context.Background(), "r1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := arch.Load(context.Background(), "r1"); err == nil {
		t.Fatal("load after delete: want error")
	}
	// Deleting a missing archive is idempotent, not an error.
	if err := arch.Delete(context.Background(), "r1"); err != nil {
		t.Fatalf("re-delete: %v", err)
	}
}

func TestEventArchive_LoadReadError(t *testing.T) {
	arch := NewEventArchive(&S3Client{client: &errBodyS3{}, bucket: "b"})
	if _, err := arch.Load(context.Background(), "r"); err == nil {
		t.Fatal("load with failing body: want error")
	}
}

func TestEventArchive_LoadUnmarshalError(t *testing.T) {
	m := &memS3{objects: map[string][]byte{"run-events/r.json": []byte("{not json")}}
	arch := NewEventArchive(&S3Client{client: m, bucket: "b"})
	if _, err := arch.Load(context.Background(), "r"); err == nil {
		t.Fatal("load with garbage object: want error")
	}
}
