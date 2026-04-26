package events

import (
	"testing"
)

func TestNewClient(t *testing.T) {
	c := NewClient("user-1")
	if c.UserID != "user-1" {
		t.Errorf("UserID = %q, want %q", c.UserID, "user-1")
	}
	if c.Events == nil {
		t.Fatal("Events channel is nil")
	}
}

func TestClientSend(t *testing.T) {
	c := NewClient("user-1")
	c.Send([]byte("hello"))

	select {
	case got := <-c.Events:
		if string(got) != "hello" {
			t.Errorf("received = %q, want %q", got, "hello")
		}
	default:
		t.Fatal("expected data on Events channel, got nothing")
	}
}

func TestClientSendDropsWhenFull(t *testing.T) {
	c := NewClient("user-1")
	for i := 0; i < eventBufferSize; i++ {
		c.Send([]byte("msg"))
	}
	c.Send([]byte("overflow"))
	c.Send([]byte("overflow2"))

	if got := c.DropCount(); got != 2 {
		t.Errorf("DropCount = %d, want 2", got)
	}

	count := 0
	for {
		select {
		case <-c.Events:
			count++
		default:
			goto done
		}
	}
done:
	if count != eventBufferSize {
		t.Errorf("received %d messages, want %d (overflow should be dropped)", count, eventBufferSize)
	}
}

func TestClientSendAfterCloseIsNoOp(t *testing.T) {
	c := NewClient("user-1")
	c.Close()
	c.Send([]byte("ignored"))

	select {
	case data := <-c.Events:
		t.Fatalf("expected no send after close, got %q", string(data))
	default:
	}
	if got := c.DropCount(); got != 0 {
		t.Errorf("post-close send should not count as a drop; DropCount = %d", got)
	}
}

func TestClientClose(t *testing.T) {
	c := NewClient("user-1")
	c.Close()

	select {
	case <-c.Done():
	default:
		t.Fatal("Done() channel not closed after Close()")
	}
}

func TestClientCloseIdempotent(t *testing.T) {
	c := NewClient("user-1")
	c.Close()
	c.Close()
	c.Close()

	select {
	case <-c.Done():
	default:
		t.Fatal("Done() channel not closed after multiple Close() calls")
	}
}

func TestClientDoneNotClosedBeforeClose(t *testing.T) {
	c := NewClient("user-1")
	select {
	case <-c.Done():
		t.Fatal("Done() channel should not be closed before Close()")
	default:
	}
}

func TestClientDropCountStartsZero(t *testing.T) {
	c := NewClient("user-1")
	if got := c.DropCount(); got != 0 {
		t.Errorf("initial DropCount = %d, want 0", got)
	}
}
