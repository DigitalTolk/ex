package main

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func thumbnailAttachments() []*model.Attachment {
	return []*model.Attachment{
		{ID: "a1", ThumbnailS3Key: "t1", SquareThumbnailS3Key: "s1"},
		{ID: "pdf"},
		{ID: "a2", ThumbnailS3Key: "t2", SquareThumbnailS3Key: "s2"},
	}
}

type reencodeSpy struct {
	keys    []string
	dryRuns []bool
	fail    string
	lossy   string
}

func (s *reencodeSpy) reencode(_ context.Context, key string, dryRun bool) (bool, error) {
	s.keys = append(s.keys, key)
	s.dryRuns = append(s.dryRuns, dryRun)
	if key == s.fail {
		return false, errors.New("boom")
	}
	return key != s.lossy, nil
}

func TestThumbnailWebP_ReencodesBothThumbnailsOfEveryAttachment(t *testing.T) {
	spy := &reencodeSpy{lossy: "s2"}
	if code := thumbnailWebP(context.Background(), thumbnailAttachments(), spy.reencode, false, true, "apply"); code != 0 {
		t.Fatalf("exit = %d, want 0", code)
	}
	if want := []string{"t1", "s1", "t2", "s2"}; !slices.Equal(spy.keys, want) {
		t.Fatalf("keys = %v, want %v", spy.keys, want)
	}
	if slices.Contains(spy.dryRuns, true) {
		t.Fatal("an apply run asked for a dry run")
	}
}

func TestThumbnailWebP_DryRunIsPassedThrough(t *testing.T) {
	spy := &reencodeSpy{}
	thumbnailWebP(context.Background(), thumbnailAttachments(), spy.reencode, true, false, "dry-run")
	if slices.Contains(spy.dryRuns, false) {
		t.Fatal("a dry run asked for a write")
	}
}

func TestThumbnailWebP_AFailedThumbnailFailsTheRunButNotTheWalk(t *testing.T) {
	spy := &reencodeSpy{fail: "t1"}
	if code := thumbnailWebP(context.Background(), thumbnailAttachments(), spy.reencode, false, false, "apply"); code != 1 {
		t.Fatalf("exit = %d, want 1", code)
	}
	if len(spy.keys) != 4 {
		t.Fatalf("keys = %v, want all four", spy.keys)
	}
}
