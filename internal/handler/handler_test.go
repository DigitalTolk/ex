package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWriteJSON(t *testing.T) {
	rec := httptest.NewRecorder()
	data := map[string]string{"key": "value"}

	writeJSON(rec, http.StatusCreated, data)

	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusCreated)
	}

	ct := rec.Header().Get("Content-Type")
	if ct != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q, want %q", ct, "application/json; charset=utf-8")
	}

	var got map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got["key"] != "value" {
		t.Errorf("body key = %q, want %q", got["key"], "value")
	}
}

func TestWriteError(t *testing.T) {
	rec := httptest.NewRecorder()
	writeError(rec, http.StatusBadRequest, "invalid_input", "field is required")

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}

	var got struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if got.Error.Code != "invalid_input" {
		t.Errorf("error code = %q, want %q", got.Error.Code, "invalid_input")
	}
	if got.Error.Message != "field is required" {
		t.Errorf("error message = %q, want %q", got.Error.Message, "field is required")
	}
}

func TestReadJSONValid(t *testing.T) {
	body := `{"name":"test","age":30}`
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	var dest struct {
		Name string `json:"name"`
		Age  int    `json:"age"`
	}

	if err := readJSON(req, &dest); err != nil {
		t.Fatalf("readJSON: %v", err)
	}

	if dest.Name != "test" {
		t.Errorf("Name = %q, want %q", dest.Name, "test")
	}
	if dest.Age != 30 {
		t.Errorf("Age = %d, want %d", dest.Age, 30)
	}
}

func TestReadJSONInvalid(t *testing.T) {
	body := `{invalid json}`
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))

	var dest struct{}
	err := readJSON(req, &dest)
	if err == nil {
		t.Fatal("expected error for invalid JSON, got nil")
	}
}

func TestReadJSONUnknownFields(t *testing.T) {
	body := `{"name":"test","unknownField":"oops"}`
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))

	var dest struct {
		Name string `json:"name"`
	}
	err := readJSON(req, &dest)
	if err == nil {
		t.Fatal("expected error for unknown fields, got nil")
	}
}

func TestReadJSONOversizedBody(t *testing.T) {
	// Create a body larger than 1 MB.
	big := strings.Repeat("a", 1<<20+1)
	body := `{"data":"` + big + `"}`
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))

	var dest struct {
		Data string `json:"data"`
	}
	err := readJSON(req, &dest)
	if err == nil {
		t.Fatal("expected error for oversized body, got nil")
	}
}

func TestQueryParam(t *testing.T) {
	tests := []struct {
		name     string
		url      string
		param    string
		fallback string
		want     string
	}{
		{"present", "/test?limit=50", "limit", "10", "50"},
		{"absent", "/test", "limit", "10", "10"},
		{"empty", "/test?limit=", "limit", "10", "10"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tt.url, nil)
			got := queryParam(req, tt.param, tt.fallback)
			if got != tt.want {
				t.Errorf("queryParam = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestQueryInt(t *testing.T) {
	tests := []struct {
		name     string
		url      string
		param    string
		fallback int
		want     int
	}{
		{"valid int", "/test?page=5", "page", 1, 5},
		{"absent", "/test", "page", 1, 1},
		{"invalid", "/test?page=abc", "page", 1, 1},
		{"empty", "/test?page=", "page", 1, 1},
		{"negative", "/test?page=-3", "page", 1, -3},
		{"zero", "/test?page=0", "page", 1, 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tt.url, nil)
			got := queryInt(req, tt.param, tt.fallback)
			if got != tt.want {
				t.Errorf("queryInt = %d, want %d", got, tt.want)
			}
		})
	}
}
