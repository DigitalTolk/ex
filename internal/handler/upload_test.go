package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/storage"
)

func TestCreateUploadURL_Unauthenticated(t *testing.T) {
	h := NewUploadHandler(nil)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/uploads/url", strings.NewReader(`{"filename":"f.txt","contentType":"text/plain"}`))
	rec := httptest.NewRecorder()
	h.CreateUploadURL(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestCreateUploadURL_NoStorage(t *testing.T) {
	h := NewUploadHandler(nil)
	jwtMgr := auth.NewJWTManager("upload-secret", 15*time.Minute, 720*time.Hour)
	user := &model.User{ID: "up-u", Email: "u@example.com", SystemRole: model.SystemRoleMember}
	token, _ := jwtMgr.GenerateAccessToken(user)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.CreateUploadURL))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/uploads/url", strings.NewReader(`{"filename":"f.txt","contentType":"text/plain"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusServiceUnavailable, rec.Body.String())
	}
}

func TestCreateUploadURL_InvalidBody(t *testing.T) {
	s3Client, err := storage.NewS3Client(context.Background(), storage.S3Config{
		Endpoint: "http://127.0.0.1:1", Bucket: "test", AccessKey: "test", SecretKey: "test", Region: "us-east-1",
	})
	if err != nil {
		t.Fatalf("S3: %v", err)
	}
	h := NewUploadHandler(s3Client)
	jwtMgr := auth.NewJWTManager("upload-secret-2", 15*time.Minute, 720*time.Hour)
	user := &model.User{ID: "up-u2", Email: "u2@example.com", SystemRole: model.SystemRoleMember}
	token, _ := jwtMgr.GenerateAccessToken(user)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.CreateUploadURL))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/uploads/url", strings.NewReader(`{"filename":""}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestCreateUploadURL_Success(t *testing.T) {
	s3Client, err := storage.NewS3Client(context.Background(), storage.S3Config{
		Endpoint: "http://127.0.0.1:1", Bucket: "test", AccessKey: "test", SecretKey: "test", Region: "us-east-1",
	})
	if err != nil {
		t.Fatalf("S3: %v", err)
	}
	h := NewUploadHandler(s3Client)
	jwtMgr := auth.NewJWTManager("upload-secret-3", 15*time.Minute, 720*time.Hour)
	user := &model.User{ID: "up-u3", Email: "u3@example.com", SystemRole: model.SystemRoleMember}
	token, _ := jwtMgr.GenerateAccessToken(user)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.CreateUploadURL))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/uploads/url", strings.NewReader(`{"filename":"hello.txt","contentType":"text/plain"}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var got struct {
		UploadURL string `json:"uploadURL"`
		Key       string `json:"key"`
		FileURL   string `json:"fileURL"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.UploadURL == "" || got.FileURL == "" {
		t.Error("expected non-empty uploadURL and fileURL")
	}
	if !strings.HasPrefix(got.Key, "uploads/up-u3/") {
		t.Errorf("key = %q, want uploads/up-u3/...", got.Key)
	}
	if !strings.HasSuffix(got.Key, "/hello.txt") {
		t.Errorf("key %q should end with /hello.txt", got.Key)
	}
}

func TestCreateUploadURL_InvalidJSON(t *testing.T) {
	s3Client, err := storage.NewS3Client(context.Background(), storage.S3Config{
		Endpoint: "http://127.0.0.1:1", Bucket: "test", AccessKey: "test", SecretKey: "test", Region: "us-east-1",
	})
	if err != nil {
		t.Fatalf("S3: %v", err)
	}
	h := NewUploadHandler(s3Client)
	jwtMgr := auth.NewJWTManager("upload-secret-bad", 15*time.Minute, 720*time.Hour)
	user := &model.User{ID: "u", Email: "u@x.com", SystemRole: model.SystemRoleMember}
	token, _ := jwtMgr.GenerateAccessToken(user)
	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.CreateUploadURL))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/uploads/url", strings.NewReader("{"))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}
