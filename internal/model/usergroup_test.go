package model

import "testing"

func TestUserGroupLinked(t *testing.T) {
	if (UserGroup{}).Linked() {
		t.Fatal("a group with no Entra group reads as linked")
	}
	if !(UserGroup{EntraGroupID: "entra-1"}).Linked() {
		t.Fatal("a group with an Entra group reads as unlinked")
	}
}
