package app

import (
	"context"
	"errors"
	"io/fs"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/DigitalTolk/ex/internal/config"
	"github.com/DigitalTolk/ex/internal/model"
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
			if got := wsOriginPatternsFromCORS(tc.in); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("got %v, want %v", got, tc.want)
			}
		})
	}
}

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
			if got := uploadConnectSrcOrigins(tc.public, tc.internal); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestCORSOrigins(t *testing.T) {
	if got := corsOrigins(&config.Config{Env: "development"}); !reflect.DeepEqual(got, []string{"*"}) {
		t.Fatalf("development = %v, want any origin", got)
	}
	want := []string{"https://ex.example.com", "tauri://localhost", "capacitor://localhost", "http://localhost"}
	if got := corsOrigins(&config.Config{Env: "production", BaseURL: "https://ex.example.com"}); !reflect.DeepEqual(got, want) {
		t.Fatalf("production = %v, want %v", got, want)
	}
}

type fakeIDLists struct {
	channels, convs       []string
	channelErr, convErr   error
	gotChannel, gotConvID string
	sawDeadline           bool
}

func (f *fakeIDLists) ListUserChannelIDs(ctx context.Context, userID string) ([]string, error) {
	f.gotChannel = userID
	_, f.sawDeadline = ctx.Deadline()
	return f.channels, f.channelErr
}

func (f *fakeIDLists) ListUserConversationIDs(_ context.Context, userID string) ([]string, error) {
	f.gotConvID = userID
	return f.convs, f.convErr
}

func TestPresenceAudienceListsChannelAndConversationTopics(t *testing.T) {
	lists := &fakeIDLists{channels: []string{"c1", "c2"}, convs: []string{"d1"}}
	// A disconnect's request context is already cancelled: the resolver must
	// not depend on it.
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	got := presenceAudience(lists, lists)(cancelled, "u1")
	want := []string{"chan:c1", "chan:c2", "conv:d1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("topics = %v, want %v", got, want)
	}
	if lists.gotChannel != "u1" || lists.gotConvID != "u1" || !lists.sawDeadline {
		t.Fatalf("lookups = %q/%q deadline=%v, want both for u1 on a bounded context", lists.gotChannel, lists.gotConvID, lists.sawDeadline)
	}
}

func TestPresenceAudienceIsBestEffortPerSide(t *testing.T) {
	boom := errors.New("boom")
	got := presenceAudience(&fakeIDLists{channelErr: boom, convs: []string{"d1"}}, &fakeIDLists{convs: []string{"d1"}})(context.Background(), "u1")
	if !reflect.DeepEqual(got, []string{"conv:d1"}) {
		t.Fatalf("failed channel side: topics = %v, want only the conversation", got)
	}
	both := &fakeIDLists{channelErr: boom, convErr: boom}
	if got := presenceAudience(both, both)(context.Background(), "u1"); len(got) != 0 {
		t.Fatalf("both sides failed: topics = %v, want none", got)
	}
}

type fakeAgents struct {
	list []*model.User
	err  error
}

func (f fakeAgents) ListAgents(context.Context) ([]*model.User, error) { return f.list, f.err }

func TestAlwaysOnlineAgents(t *testing.T) {
	r := httptest.NewRequest("GET", "/api/v1/presence", nil)
	got := alwaysOnlineAgents(fakeAgents{list: []*model.User{{ID: "a1"}, {ID: "a2"}}})(r)
	if !reflect.DeepEqual(got, []string{"a1", "a2"}) {
		t.Fatalf("roster = %v, want both agents", got)
	}
	if got := alwaysOnlineAgents(fakeAgents{err: errors.New("down")})(r); got != nil {
		t.Fatalf("failed lookup = %v, want nobody", got)
	}
}

// subFailFS is an FS whose Sub refuses, standing in for a build without the
// embedded SPA.
type subFailFS struct{ fstest.MapFS }

func (subFailFS) Sub(string) (fs.FS, error) { return nil, errors.New("no dist") }

func TestFrontendDist(t *testing.T) {
	dist := frontendDist(fstest.MapFS{"dist/index.html": {Data: []byte("<html></html>")}})
	if b, err := fs.ReadFile(dist, "index.html"); err != nil || string(b) != "<html></html>" {
		t.Fatalf("dist index.html = %q, %v", b, err)
	}
	if got := frontendDist(subFailFS{}); got != nil {
		t.Fatalf("missing SPA = %v, want nil (SPA disabled)", got)
	}
}

func TestWaitBounded(t *testing.T) {
	if !waitBounded(func() {}, time.Minute) {
		t.Fatal("a wait that returns must report done")
	}
	release := make(chan struct{})
	defer close(release)
	if waitBounded(func() { <-release }, time.Millisecond) {
		t.Fatal("a wedged wait must time out")
	}
	// A panicking wait is isolated and counts as not done.
	if waitBounded(func() { panic("boom") }, 10*time.Millisecond) {
		t.Fatal("a panicking wait must not report done")
	}
}

type fakeSeeder struct {
	err   error
	calls int
}

func (f *fakeSeeder) SeedDefaults(context.Context) error { f.calls++; return f.err }

func TestSeedAgents(t *testing.T) {
	ok := &fakeSeeder{}
	seedAgents(context.Background(), ok)
	failing := &fakeSeeder{err: errors.New("dynamo down")}
	seedAgents(context.Background(), failing) // logged, never fatal
	if ok.calls != 1 || failing.calls != 1 {
		t.Fatalf("seed calls = %d/%d, want 1 each", ok.calls, failing.calls)
	}
}

// dueFake reports each ProcessDue call on calls; the first call fails, later
// ones succeed. n is only touched by the poller goroutine.
type dueFake struct {
	n     int
	calls chan int
}

func (f *dueFake) ProcessDue(context.Context) (int, error) {
	f.n++
	f.calls <- f.n
	if f.n == 1 {
		return 0, errors.New("claim failed")
	}
	return 1, nil
}

func TestRunDuePollerPollsUntilCancelled(t *testing.T) {
	f := &dueFake{calls: make(chan int, 16)}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		runDuePoller(ctx, "reminder", f, time.Millisecond)
		close(done)
	}()
	// A failed tick is logged and the loop keeps polling.
	for want := 1; want <= 2; want++ {
		if got := <-f.calls; got != want {
			t.Fatalf("poll %d, want %d", got, want)
		}
	}
	cancel()
	<-done
}

type panicDue struct{}

func (panicDue) ProcessDue(context.Context) (int, error) { panic("bad tick") }

func TestRunDuePollerIsolatesAPanic(t *testing.T) {
	// The panic ends this poller but never the process.
	runDuePoller(context.Background(), "scheduled message", panicDue{}, time.Millisecond)
}

type fakeRebuilder struct {
	started bool
	err     error
	now     int64
}

func (f *fakeRebuilder) StartIfStale(_ context.Context, now func() int64) (bool, error) {
	f.now = now()
	return f.started, f.err
}

func TestAutoMappingRebuild(t *testing.T) {
	for _, f := range []*fakeRebuilder{{started: true}, {}, {err: errors.New("search down")}} {
		before := time.Now().Unix()
		autoMappingRebuild(context.Background(), f)
		if f.now < before {
			t.Fatalf("StartIfStale clock = %d, want the current time", f.now)
		}
	}
}

type panicRebuilder struct{}

func (panicRebuilder) StartIfStale(context.Context, func() int64) (bool, error) { panic("boom") }

func TestAutoMappingRebuildIsolatesAPanic(t *testing.T) {
	autoMappingRebuild(context.Background(), panicRebuilder{})
}

func TestMustRedisOptions(t *testing.T) {
	defer func() {
		if r := recover(); r == nil || !strings.Contains(r.(string), "already-parsed URL") {
			t.Fatalf("recover = %v, want the programmer-error panic", r)
		}
	}()
	opts := &redis.Options{Addr: "localhost:6379"}
	if got := mustRedisOptions(opts, nil); got != opts {
		t.Fatalf("mustRedisOptions = %v, want the options through", got)
	}
	mustRedisOptions(nil, errors.New("parse"))
}
