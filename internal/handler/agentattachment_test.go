package handler

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

type blipChecker struct{ err error }

func (c blipChecker) CanAccessMessageAttachment(context.Context, string, string, string, string, string) error {
	return c.err
}

type fixedLimitsH struct{ ext, size bool }

func (l fixedLimitsH) AllowsExtension(context.Context, string) bool { return l.ext }
func (l fixedLimitsH) AllowsSize(context.Context, int64) bool       { return l.size }

// withAttachments wires an attachment service (handler-package fakes) into
// the run-tool handler and returns the store for seeding.
func withAttachments(fx *hrunnerCovFix) (*service.AttachmentService, *fakeAttachmentStore, *fakeSigner) {
	st := newFakeAttachmentStore()
	signer := &fakeSigner{objects: map[string][]byte{}, objectTypes: map[string]string{}}
	svc := service.NewAttachmentService(st, signer, nil)
	fx.toolH.SetAttachments(svc)
	return svc, st, signer
}

// uploadReq builds a raw-bytes upload request the way the runner sends it.
func agentUploadReq(t *testing.T, fx *hrunnerCovFix, filename string, body []byte, contentLength int64) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/hrc", bytes.NewReader(body))
	req.ContentLength = contentLength
	if filename != "" {
		req.Header.Set(filenameHeader, filename)
	}
	req = req.WithContext(middleware.ContextWithClaims(req.Context(), hrunnerCovToolClaims(hrunnerCovRunID)))
	rec := httptest.NewRecorder()
	fx.toolH.UploadAttachment(rec, req)
	return rec
}

func TestAgentAttachment_Download(t *testing.T) {
	t.Run("run missing", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		withAttachments(fx)
		rec := hrunnerCovDo(t, fx.toolH.DownloadAttachment, http.MethodGet, "", hrunnerCovToolClaims("nope"), map[string]string{"id": "a1"})
		hrunnerCovWantStatus(t, rec, http.StatusNotFound)
	})
	t.Run("not readable by the invoker", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		_, st, _ := withAttachments(fx)
		fx.addRun(&model.Run{})
		st.byID["a1"] = &model.Attachment{ID: "a1", S3Key: "attachments/a1", CreatedBy: "someone-else"}
		rec := hrunnerCovDo(t, fx.toolH.DownloadAttachment, http.MethodGet, "", hrunnerCovToolClaims(hrunnerCovRunID), map[string]string{"id": "a1"})
		hrunnerCovWantStatus(t, rec, http.StatusNotFound)
	})
	t.Run("access check failure is not a denial", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		svc, st, _ := withAttachments(fx)
		svc.SetAccessChecker(blipChecker{err: errors.New("dynamo blip")})
		fx.addRun(&model.Run{})
		st.byID["a1"] = &model.Attachment{ID: "a1", S3Key: "attachments/a1", CreatedBy: "someone-else"}
		rec := hrunnerCovDo(t, fx.toolH.DownloadAttachment, http.MethodGet, "", hrunnerCovToolClaims(hrunnerCovRunID), map[string]string{"id": "a1"})
		hrunnerCovWantStatus(t, rec, http.StatusInternalServerError)
	})
	t.Run("streams the invoker's file with its metadata", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		_, st, signer := withAttachments(fx)
		fx.addRun(&model.Run{})
		signer.objects["attachments/a1"] = []byte("hello bytes")
		signer.objectTypes["attachments/a1"] = "text/plain"
		st.byID["a1"] = &model.Attachment{ID: "a1", S3Key: "attachments/a1", CreatedBy: hrunnerCovInvoker, Filename: "läs mig.txt", ContentType: "text/plain", Size: 11}
		req := httptest.NewRequest(http.MethodGet, "/hrc?messageID=m-x", nil)
		req = req.WithContext(middleware.ContextWithClaims(req.Context(), hrunnerCovToolClaims(hrunnerCovRunID)))
		req.SetPathValue("id", "a1")
		rec := httptest.NewRecorder()
		fx.toolH.DownloadAttachment(rec, req)
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		if rec.Body.String() != "hello bytes" {
			t.Fatalf("body = %q", rec.Body.String())
		}
		h := rec.Header()
		if h.Get("Content-Type") != "text/plain" || h.Get("Content-Length") != "11" || h.Get("X-Content-Type-Options") != "nosniff" {
			t.Fatalf("headers = %v", h)
		}
		if got := h.Get("Content-Disposition"); !strings.HasPrefix(got, "attachment; filename*=UTF-8''l%C3%A4s%20mig.txt") {
			t.Fatalf("disposition = %q", got)
		}
	})
}

func TestAgentAttachment_Upload(t *testing.T) {
	data := handlerPNG(t, 2, 2)
	t.Run("run missing", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		withAttachments(fx)
		req := httptest.NewRequest(http.MethodPost, "/hrc", bytes.NewReader(data))
		req = req.WithContext(middleware.ContextWithClaims(req.Context(), hrunnerCovToolClaims("nope")))
		rec := httptest.NewRecorder()
		fx.toolH.UploadAttachment(rec, req)
		hrunnerCovWantStatus(t, rec, http.StatusNotFound)
	})
	t.Run("filename header required and must decode", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		withAttachments(fx)
		fx.addRun(&model.Run{})
		hrunnerCovWantStatus(t, agentUploadReq(t, fx, "", data, int64(len(data))), http.StatusBadRequest)
		hrunnerCovWantStatus(t, agentUploadReq(t, fx, "%zz.png", data, int64(len(data))), http.StatusBadRequest)
	})
	t.Run("content length required and capped", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		withAttachments(fx)
		fx.addRun(&model.Run{})
		hrunnerCovWantStatus(t, agentUploadReq(t, fx, "a.png", data, -1), http.StatusBadRequest)
		hrunnerCovWantStatus(t, agentUploadReq(t, fx, "a.png", data, model.UploadMaxBytes+1), http.StatusRequestEntityTooLarge)
	})
	t.Run("upload cap and store failure", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		withAttachments(fx)
		fx.addRun(&model.Run{Spend: model.RunSpend{Uploads: model.UploadsPerRun}})
		hrunnerCovWantStatus(t, agentUploadReq(t, fx, "a.png", data, int64(len(data))), http.StatusTooManyRequests)
		fx.runs.updateErr = errors.New("dynamo down")
		hrunnerCovWantStatus(t, agentUploadReq(t, fx, "a.png", data, int64(len(data))), http.StatusInternalServerError)
	})
	t.Run("type, limits and content rejections", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		svc, _, _ := withAttachments(fx)
		fx.addRun(&model.Run{})
		hrunnerCovWantStatus(t, agentUploadReq(t, fx, "run.sh", data, int64(len(data))), http.StatusUnsupportedMediaType)
		svc.SetUploadLimits(fixedLimitsH{ext: true, size: false})
		hrunnerCovWantStatus(t, agentUploadReq(t, fx, "a.png", data, int64(len(data))), http.StatusRequestEntityTooLarge)
		svc.SetUploadLimits(fixedLimitsH{ext: true, size: true})
		// Declared .png, bytes are not an image.
		junk := []byte(strings.Repeat("j", len(data)))
		hrunnerCovWantStatus(t, agentUploadReq(t, fx, "a.png", junk, int64(len(junk))), http.StatusBadRequest)
	})
	t.Run("stores the file bound to the run", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		_, st, _ := withAttachments(fx)
		fx.addRun(&model.Run{})
		rec := agentUploadReq(t, fx, "Screen%20Shot.png", data, int64(len(data)))
		hrunnerCovWantStatus(t, rec, http.StatusCreated)
		body := hrunnerCovBody(t, rec)
		att, _ := body["attachment"].(map[string]any)
		id, _ := att["id"].(string)
		if id == "" || att["filename"] != "Screen Shot.png" || att["contentType"] != "image/png" || body["remainingUploads"] != float64(model.UploadsPerRun-1) {
			t.Fatalf("response = %v", body)
		}
		row := st.byID[id]
		if row.RunID != hrunnerCovRunID || row.CreatedBy != hrunnerCovAgentID || row.VerifiedETag == "" {
			t.Fatalf("row = %+v", row)
		}
		// …and only that run may attach it.
		req := `{"body":"here you go","attachmentIDs":["` + id + `","` + id + `",""]}`
		rec = hrunnerCovDo(t, fx.toolH.PostMessage, http.MethodPost, req, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		msgID, _ := hrunnerCovBody(t, rec)["messageID"].(string)
		posted := fx.msgs.byKey[hrunnerCovChan+"#"+msgID]
		if posted == nil || len(posted.AttachmentIDs) != 1 || posted.AttachmentIDs[0] != id {
			t.Fatalf("posted = %+v", posted)
		}
	})
}

func TestAgentAttachment_PostRules(t *testing.T) {
	t.Run("file-only post is allowed but attachments must be enabled", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		rec := hrunnerCovDo(t, fx.toolH.PostMessage, http.MethodPost, `{"attachmentIDs":["a1"]}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
		if !strings.Contains(rec.Body.String(), "not enabled") {
			t.Fatalf("body = %s", rec.Body.String())
		}
	})
	t.Run("too many", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		withAttachments(fx)
		fx.addRun(&model.Run{})
		ids := make([]string, service.MaxAttachmentsPerMessage+1)
		for i := range ids {
			ids[i] = strconv.Quote("a" + strconv.Itoa(i))
		}
		rec := hrunnerCovDo(t, fx.toolH.PostMessage, http.MethodPost, `{"body":"x","attachmentIDs":[`+strings.Join(ids, ",")+`]}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("another run's file is refused", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		_, st, _ := withAttachments(fx)
		fx.addRun(&model.Run{})
		st.byID["theirs"] = &model.Attachment{ID: "theirs", RunID: "run-other", CreatedBy: hrunnerCovAgentID}
		rec := hrunnerCovDo(t, fx.toolH.PostMessage, http.MethodPost, `{"body":"x","attachmentIDs":["theirs"]}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusForbidden)
	})
}
