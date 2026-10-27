package model

import "testing"

func TestShortName(t *testing.T) {
	cases := map[string]string{
		"":                    "",
		"   ":                 "",
		"Cher":                "Cher",
		"John Smith":          "John",
		"Muhammad Ali Khan":   "Ali Khan",
		"MUHAMMAD Ali":        "Ali",
		"Mohammed Bilal":      "Bilal",
		"Md. Rahim Uddin":     "Rahim Uddin",
		"Mohd Aslam":          "Aslam",
		"Muhammad Mohd Faraz": "Faraz",
		"Muhammad":            "Muhammad",
		"Muhammad Mohammed":   "Muhammad",
		"Ali Muhammad":        "Ali",
	}
	for in, want := range cases {
		if got := ShortName(in); got != want {
			t.Errorf("ShortName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIsNamePrefix(t *testing.T) {
	for _, w := range []string{"Muhammad", "muhammed", "MOHAMMAD", "Mohammed", "Mohamed", "Mohamad", "Muhamad", "Mohd.", "Md", "md."} {
		if !IsNamePrefix(w) {
			t.Errorf("IsNamePrefix(%q) = false, want true", w)
		}
	}
	for _, w := range []string{"Ali", "Mo", "Mohammadi", ""} {
		if IsNamePrefix(w) {
			t.Errorf("IsNamePrefix(%q) = true, want false", w)
		}
	}
}
