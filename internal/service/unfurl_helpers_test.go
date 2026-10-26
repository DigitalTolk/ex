package service

import (
	"net"
	"net/url"
	"testing"
)

func TestImageExtFromURL_Variants(t *testing.T) {
	cases := map[string]string{
		"http://x/a.png":  ".png",
		"http://x/a.JPG":  ".jpg",
		"http://x/a.webp": ".webp",
		"http://x/a.txt":  "",
		"http://x/noext":  "",
	}
	for in, want := range cases {
		if got := imageExtFromURL(in); got != want {
			t.Errorf("imageExtFromURL(%q) = %q, want %q", in, got, want)
		}
	}
	// Malformed URL → parse error → "".
	if got := imageExtFromURL("http://%zz"); got != "" {
		t.Errorf("malformed url ext = %q, want empty", got)
	}
}

func TestValidateURL_IPLiteralHosts(t *testing.T) {
	host := func(ip string) *url.URL {
		return &url.URL{Scheme: "https", Host: net.JoinHostPort(ip, "443"), Path: "/x"}
	}
	pub := []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"}
	for _, s := range pub {
		if err := validateURL(host(s)); err != nil {
			t.Errorf("validateURL(%s) = %v, want public", s, err)
		}
	}
	priv := []string{"127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.1.1", "0.0.0.0", "224.0.0.1", "::1"}
	for _, s := range priv {
		if err := validateURL(host(s)); err == nil {
			t.Errorf("validateURL(%s) admitted a private address", s)
		}
	}
}

func TestValidateURL_Branches(t *testing.T) {
	if err := validateURL(nil); err == nil {
		t.Error("nil url should error")
	}
	mustParse := func(s string) *url.URL { u, _ := url.Parse(s); return u }
	if err := validateURL(mustParse("ftp://example.com")); err == nil {
		t.Error("ftp scheme should error")
	}
	if err := validateURL(mustParse("http://")); err == nil {
		t.Error("empty host should error")
	}
	if err := validateURL(mustParse("http://10.0.0.1/x")); err == nil {
		t.Error("private IP host should error")
	}
	if err := validateURL(mustParse("https://8.8.8.8/x")); err != nil {
		t.Errorf("public IP host should be allowed, got %v", err)
	}
	if err := validateURL(mustParse("https://example.com/x")); err != nil {
		t.Errorf("public hostname should be allowed, got %v", err)
	}
}

func TestScrapePreview_EdgeCases(t *testing.T) {
	// Empty content is skipped; single-quoted attrs parse; relative image
	// resolves against the page URL.
	html := `<title>T</title>` +
		`<meta property="og:title" content="">` +
		`<meta property='og:description' content='desc'>` +
		`<meta property="og:image" content="/social.png">`
	p := scrapePreview(html, "https://example.com/page")
	if p.Description != "desc" {
		t.Errorf("description = %q, want desc", p.Description)
	}
	if p.Image != "https://example.com/social.png" {
		t.Errorf("image = %q, want resolved absolute", p.Image)
	}
}
