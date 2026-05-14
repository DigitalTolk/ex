package main

import (
	"reflect"
	"testing"
)

func TestWSOriginPatternsFromCORS(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want []string
	}{
		{
			name: "wildcard short-circuits to bare wildcard",
			in:   []string{"https://app.example.com", "*", "tauri://localhost"},
			want: []string{"*"},
		},
		{
			name: "production allowlist with mixed schemes",
			in:   []string{"https://app.example.com", "tauri://localhost", "capacitor://localhost", "http://localhost"},
			want: []string{"app.example.com", "localhost", "localhost", "localhost"},
		},
		{
			name: "drops empty / unparseable entries",
			in:   []string{"", "not a url", "https://app.example.com"},
			want: []string{"app.example.com"},
		},
		{
			name: "strips port suffix from explicit host:port",
			in:   []string{"http://app.example.com:8080"},
			want: []string{"app.example.com"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := wsOriginPatternsFromCORS(tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("got %v, want %v", got, tc.want)
			}
		})
	}
}
