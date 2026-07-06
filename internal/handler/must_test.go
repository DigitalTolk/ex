package handler

import (
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/events"
)

func TestMustEventPanicsOnImpossibleFailure(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("mustEvent must panic on error")
		}
	}()
	mustEvent(nil, errors.New("boom"))
}

func TestMustEventPassthrough(t *testing.T) {
	evt := mustEvent(events.NewEvent("x.y", map[string]string{"a": "b"}))
	if evt == nil || evt.Type != "x.y" {
		t.Fatalf("mustEvent = %#v", evt)
	}
}

func TestMustJSONHandlerPanicsOnImpossibleFailure(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("mustJSON must panic on error")
		}
	}()
	mustJSON(nil, errors.New("boom"))
}

func TestMustJSONHandlerPassthrough(t *testing.T) {
	if got := string(mustJSON([]byte("{}"), nil)); got != "{}" {
		t.Fatalf("mustJSON = %q", got)
	}
}
