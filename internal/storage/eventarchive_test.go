package storage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// memS3 is an in-memory s3API: PutObject keeps the body, GetObject returns it.
type memS3 struct {
	objects map[string][]byte
}

func (m *memS3) DeleteObject(_ context.Context, in *s3.DeleteObjectInput, _ ...func(*s3.Options)) (*s3.DeleteObjectOutput, error) {
	delete(m.objects, aws.ToString(in.Key))
	return &s3.DeleteObjectOutput{}, nil
}
func (m *memS3) HeadObject(_ context.Context, in *s3.HeadObjectInput, _ ...func(*s3.Options)) (*s3.HeadObjectOutput, error) {
	if _, ok := m.objects[aws.ToString(in.Key)]; !ok {
		return nil, errors.New("no such key")
	}
	return &s3.HeadObjectOutput{}, nil
}
func (m *memS3) GetObject(_ context.Context, in *s3.GetObjectInput, _ ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	body, ok := m.objects[aws.ToString(in.Key)]
	if !ok {
		return nil, errors.New("no such key")
	}
	return &s3.GetObjectOutput{
		Body:          io.NopCloser(bytes.NewReader(body)),
		ContentLength: aws.Int64(int64(len(body))),
		ContentType:   aws.String("application/json"),
		LastModified:  aws.Time(time.Unix(0, 0)),
	}, nil
}
func (m *memS3) PutObject(_ context.Context, in *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	buf, err := io.ReadAll(in.Body)
	if err != nil {
		return nil, err
	}
	if m.objects == nil {
		m.objects = map[string][]byte{}
	}
	m.objects[aws.ToString(in.Key)] = buf
	return &s3.PutObjectOutput{}, nil
}

func TestEventArchive_RoundTrip(t *testing.T) {
	arch := NewEventArchive(&S3Client{client: &memS3{}, bucket: "b"})
	events := []*model.RunEvent{
		{RunID: "run1", Seq: 1, Type: "run.invoked", ActorID: "u-alice", CreatedAt: time.Unix(1, 0).UTC()},
		{RunID: "run1", Seq: 2, Type: "tool", Payload: map[string]any{"name": "post_message"}, CreatedAt: time.Unix(2, 0).UTC()},
		{RunID: "run1", Seq: 3, Type: "run.completed", CreatedAt: time.Unix(3, 0).UTC()},
	}

	if err := arch.Archive(context.Background(), "run1", events); err != nil {
		t.Fatalf("archive: %v", err)
	}
	got, err := arch.Load(context.Background(), "run1")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(got) != len(events) {
		t.Fatalf("round trip lost events: got %d want %d", len(got), len(events))
	}
	for i, e := range got {
		if e.Seq != events[i].Seq || e.Type != events[i].Type {
			t.Fatalf("event %d mismatch: got %+v want %+v", i, e, events[i])
		}
		if e.RunID != "run1" {
			t.Fatalf("event %d RunID not restored: %q", i, e.RunID)
		}
	}
	// The tool event's payload survives the JSON round trip.
	if name, _ := got[1].Payload["name"].(string); name != "post_message" {
		t.Fatalf("payload lost: %+v", got[1].Payload)
	}
}

func TestEventArchive_LoadMissing(t *testing.T) {
	arch := NewEventArchive(&S3Client{client: &memS3{}, bucket: "b"})
	if _, err := arch.Load(context.Background(), "nope"); err == nil {
		t.Fatalf("expected error loading a missing archive")
	}
}
