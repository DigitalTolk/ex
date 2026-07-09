package main

import "testing"

func TestUploadConnectSrcOrigins(t *testing.T) {
	cases := []struct {
		name             string
		public, internal string
		want             []string
	}{
		{"public http endpoint is allow-listed", "http://localhost:29000", "http://minio:9000", []string{"http://localhost:29000"}},
		{"falls back to the internal endpoint", "", "http://minio:9000", []string{"http://minio:9000"}},
		{"https endpoints ride the base policy", "https://s3.eu-north-1.amazonaws.com", "", nil},
		{"no endpoints configured", "", "", nil},
		{"unparseable endpoint yields nothing", "http://bad host", "", nil},
		{"scheme-less endpoint yields nothing", "localhost:29000", "", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := uploadConnectSrcOrigins(tc.public, tc.internal)
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Fatalf("got %v, want %v", got, tc.want)
				}
			}
		})
	}
}
