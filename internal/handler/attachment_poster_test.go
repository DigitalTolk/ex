package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

func TestAttachmentHandler_SetPoster(t *testing.T) {
	jwtMgr := auth.NewJWTManager("att-poster-secret", 15*time.Minute, 720*time.Hour)
	owner := &model.User{ID: "u-poster", Email: "poster@x.com", SystemRole: model.SystemRoleMember}
	other := &model.User{ID: "u-other", Email: "other@x.com", SystemRole: model.SystemRoleMember}

	setup := func(storage bool) http.Handler {
		st := newFakeAttachmentStore()
		st.byID["v1"] = &model.Attachment{
			ID: "v1", CreatedBy: owner.ID, Filename: "clip.mp4", ContentType: "video/mp4",
			S3Key: "attachments/v1/clip.mp4", Size: 100, SHA256: "abc", Width: 1280, Height: 720,
		}
		st.byID["p1"] = &model.Attachment{ID: "p1", CreatedBy: owner.ID, Filename: "doc.pdf", ContentType: "application/pdf"}
		st.byID["v2"] = &model.Attachment{
			ID: "v2", CreatedBy: owner.ID, Filename: "old.mp4", ContentType: "video/mp4", ThumbnailS3Key: "attachments/v2/thumb",
		}
		var signer service.AttachmentSigner
		if storage {
			signer = &fakeSigner{}
		}
		return middleware.Auth(jwtMgr)(http.HandlerFunc(NewAttachmentHandler(service.NewAttachmentService(st, signer, nil)).SetPoster))
	}
	post := func(h http.Handler, user *model.User, id string, body []byte) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/attachments/"+id+"/poster", bytes.NewReader(body))
		req.SetPathValue("id", id)
		if user != nil {
			req.Header.Set("Authorization", "Bearer "+makeTokenForUser(jwtMgr, user))
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	frame := handlerPNG(t, 16, 9)

	t.Run("no user on the request", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/attachments/v1/poster", bytes.NewReader(frame))
		req.SetPathValue("id", "v1")
		rec := httptest.NewRecorder()
		NewAttachmentHandler(service.NewAttachmentService(newFakeAttachmentStore(), &fakeSigner{}, nil)).SetPoster(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d", rec.Code)
		}
	})

	t.Run("keeps the frame and answers with the video's thumbnail", func(t *testing.T) {
		rec := post(setup(true), owner, "v1", frame)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d: %s", rec.Code, rec.Body)
		}
		var got model.Attachment
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if got.ThumbnailURL == "" || got.SquareThumbnailURL == "" || got.Width != 1280 {
			t.Fatalf("attachment = %+v", got)
		}
	})

	cases := []struct {
		name    string
		user    *model.User
		id      string
		body    []byte
		storage bool
		want    int
	}{
		{"unauthenticated", nil, "v1", frame, true, http.StatusUnauthorized},
		{"unknown attachment", owner, "nope", frame, true, http.StatusNotFound},
		{"someone else's video", other, "v1", frame, true, http.StatusForbidden},
		{"not a video", owner, "p1", frame, true, http.StatusBadRequest},
		{"not an image", owner, "v1", []byte("nope"), true, http.StatusBadRequest},
		{"a poster already", owner, "v2", frame, true, http.StatusConflict},
		{"no storage", owner, "v1", frame, false, http.StatusInternalServerError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if rec := post(setup(tc.storage), tc.user, tc.id, tc.body); rec.Code != tc.want {
				t.Fatalf("status = %d, want %d: %s", rec.Code, tc.want, rec.Body)
			}
		})
	}
}
