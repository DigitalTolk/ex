package main

import (
	"reflect"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func TestNKSeededSettings(t *testing.T) {
	withKeywords := func(kw ...string) *model.NotificationSettings {
		ns := model.DefaultNotificationSettings()
		ns.Keywords = kw
		return &ns
	}
	cases := []struct {
		name     string
		user     *model.User
		want     []string
		wantSkip bool
	}{
		{"no settings seeds the defaults", &model.User{DisplayName: "John Smith"}, []string{"John", "John Smith"}, false},
		{"empty keywords are seeded", &model.User{DisplayName: "John Smith", NotificationSettings: withKeywords()}, []string{"John", "John Smith"}, false},
		{"no display name is left alone", &model.User{NotificationSettings: withKeywords()}, nil, true},
		{"hand-edited keywords are kept", &model.User{DisplayName: "John Smith", NotificationSettings: withKeywords("deploy")}, nil, true},
		{"a seeded prefix becomes the name after it",
			&model.User{DisplayName: "Muhammad Ali Khan", NotificationSettings: withKeywords("Muhammad", "Muhammad Ali Khan", "deploy")},
			[]string{"Ali Khan", "Muhammad Ali Khan", "deploy"}, false},
		{"the name after it isn't listed twice",
			&model.User{DisplayName: "Muhammad Ali Khan", NotificationSettings: withKeywords("ali khan", "muhammad")},
			[]string{"ali khan"}, false},
		{"a name that is only a prefix loses the keyword",
			&model.User{DisplayName: "Muhammad", NotificationSettings: withKeywords("Muhammad")},
			[]string{}, false},
		{"a prefixed name without the prefix keyword is left alone",
			&model.User{DisplayName: "Muhammad Ali", NotificationSettings: withKeywords("Ali", "Muhammad Ali")},
			nil, true},
		{"a seeded prefix-only name with no keywords seeds nothing", &model.User{DisplayName: "Muhammad", NotificationSettings: withKeywords()}, nil, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ns, changed := nkSeededSettings(c.user)
			if c.wantSkip {
				if changed || ns != nil {
					t.Fatalf("nkSeededSettings = (%+v, %v), want the user left alone", ns, changed)
				}
				return
			}
			if !changed || ns == nil {
				t.Fatal("nkSeededSettings left the user alone, want a change")
			}
			if !reflect.DeepEqual(ns.Keywords, c.want) {
				t.Errorf("keywords = %#v, want %#v", ns.Keywords, c.want)
			}
		})
	}
}

// The rewrite must not touch the stored list in place: the caller may skip
// persisting it (dry run).
func TestNKWithoutSeededPrefixCopies(t *testing.T) {
	ns := model.DefaultNotificationSettings()
	ns.Keywords = []string{"Muhammad", "Muhammad Ali"}
	u := &model.User{DisplayName: "Muhammad Ali", NotificationSettings: &ns}
	if _, changed := nkSeededSettings(u); !changed {
		t.Fatal("want a change")
	}
	if !reflect.DeepEqual(u.NotificationSettings.Keywords, []string{"Muhammad", "Muhammad Ali"}) {
		t.Errorf("stored keywords mutated: %v", u.NotificationSettings.Keywords)
	}
}
