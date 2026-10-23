package service

import (
	"context"
	"sync"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// The rendered tree is cached per message version and shared; naming the
// pills on one read must leave the cached tree as rendered, so a later read
// shows the names as they are then.
func TestRenderedMentionsNeverPatchTheCachedTree(t *testing.T) {
	r := &fakeMentionResolver{names: MentionNames{}}
	svc := mentionService(r)
	first := &model.Message{ID: "m-1", Body: "hi @[u-bob|Alice]"}
	svc.attachRendered(context.Background(), first)
	if findFirstByTag(first.Rendered, "ex-mention-user") != nil {
		t.Fatal("an unknown mention still renders as a pill")
	}

	r.names = bobAndGeneral
	again := &model.Message{ID: "m-1", Body: "hi @[u-bob|Alice]"}
	svc.attachRendered(context.Background(), again)
	user := findFirstByTag(again.Rendered, "ex-mention-user")
	if user == nil || user.Properties["data-name"] != "Bob" {
		t.Fatalf("second read pill = %+v, want Bob", user)
	}
	if first.Rendered == again.Rendered {
		t.Fatal("two reads share one patched tree")
	}
}

// fixedMentions answers every lookup the same way; safe for concurrent use.
type fixedMentions MentionNames

func (f fixedMentions) ResolveMentions(context.Context, []string, []string) (MentionNames, error) {
	return MentionNames(f), nil
}

// Reads of the same message version run concurrently (run with -race).
func TestRenderedMentionsConcurrentReadsOfOneVersion(t *testing.T) {
	svc := mentionService(fixedMentions(bobAndGeneral))
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m := &model.Message{ID: "m-1", Body: "hi @[u-bob|Alice] and @[u-x|X]"}
			svc.attachRendered(context.Background(), m)
		}()
	}
	wg.Wait()
}

// A tree without mentions is served as cached, no copy made.
func TestRenderedWithoutMentionsServesTheCachedTree(t *testing.T) {
	svc := mentionService(&fakeMentionResolver{names: bobAndGeneral})
	a := &model.Message{ID: "m-2", Body: "plain **text**"}
	b := &model.Message{ID: "m-2", Body: "plain **text**"}
	svc.attachRendered(context.Background(), a, b)
	if a.Rendered != b.Rendered {
		t.Fatal("a mention-free tree was copied")
	}
}

func TestCloneHastCopiesNodesPropertiesAndChildren(t *testing.T) {
	orig := &HastNode{Type: "root", Children: []*HastNode{
		{Type: "element", TagName: "p", Properties: map[string]interface{}{"k": "v"}, Children: []*HastNode{{Type: "text", Value: "x"}}},
	}}
	c := cloneHast(orig)
	c.Children[0].Properties["k"] = "changed"
	c.Children[0].Children[0].Value = "y"
	if orig.Children[0].Properties["k"] != "v" || orig.Children[0].Children[0].Value != "x" {
		t.Fatalf("clone shares state with the original: %+v", orig.Children[0])
	}
}
