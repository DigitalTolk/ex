package service

import "testing"

func TestThumbnailFilename(t *testing.T) {
	if got := thumbnailFilename(""); got != "thumbnail.webp" {
		t.Errorf("empty: got %q", got)
	}
	if got := thumbnailFilename("pic.png"); got != "pic.png.thumb.webp" {
		t.Errorf("named: got %q", got)
	}
}

func TestSquareThumbnailFilename(t *testing.T) {
	if got := squareThumbnailFilename(""); got != "thumbnail-square.webp" {
		t.Errorf("empty: got %q", got)
	}
	if got := squareThumbnailFilename("pic.png"); got != "pic.png.square.webp" {
		t.Errorf("named: got %q", got)
	}
}
