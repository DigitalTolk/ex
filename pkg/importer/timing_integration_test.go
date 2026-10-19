//go:build integration

package importer

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"
)

// TestImportTiming logs per-phase timings for importing one large parent
// (IMPORTER_TIMING=1 to run; it asserts nothing beyond success). Useful for
// throughput work on the write path against DynamoDB Local.
func TestImportTiming(t *testing.T) {
	if os.Getenv("IMPORTER_TIMING") == "" {
		t.Skip("set IMPORTER_TIMING=1 to run")
	}
	e := newEnv(t)
	ctx := context.Background()
	_, err := e.im.EnsureChannel(ctx, ChannelSpec{ID: "big", Slug: "big", Type: "public", CreatedAt: t0})
	mustNoErr(t, err)
	var members []MemberSpec
	for i := 0; i < 20; i++ {
		members = append(members, MemberSpec{UserID: fmt.Sprintf("u%d", i)})
	}
	_, err = e.im.AddChannelMembers(ctx, "big", members)
	mustNoErr(t, err)
	for i := 0; i < 20; i++ {
		_, err := e.im.PutAttachment(ctx, AttachmentSpec{ID: fmt.Sprintf("a%d", i), Filename: "f.txt"}, bodyOf("data"))
		mustNoErr(t, err)
	}

	// 2,000 messages: 1,500 top-level, 500 replies over 100 threads; every
	// 75th message carries a file, every 100th is pinned.
	var specs []MessageSpec
	var roots []string
	for i := 0; i < 2000; i++ {
		at := t0.Add(time.Duration(i) * time.Second)
		s := MessageSpec{ID: mid(at, byte(i%250)), AuthorID: fmt.Sprintf("u%d", i%20), Body: fmt.Sprintf("message %d", i), CreatedAt: at}
		if i%4 == 3 && len(roots) > 0 {
			s.ParentMessageID = roots[len(roots)-1-(i%len(roots))%min(len(roots), 100)]
		} else if len(roots) < 100 {
			roots = append(roots, s.ID)
		}
		if i%75 == 0 {
			s.AttachmentIDs = []string{fmt.Sprintf("a%d", (i/75)%20)}
		}
		if i%100 == 0 {
			s.Pinned, s.PinnedBy = true, "u1"
		}
		specs = append(specs, s)
	}

	var put PutResult
	start := time.Now()
	for i := 0; i < len(specs); i += 100 {
		r, err := e.im.PutMessages(ctx, "big", ParentChannel, specs[i:min(i+100, len(specs))])
		mustNoErr(t, err)
		put.Inserted += r.Inserted
		put.TopLevelInserted += r.TopLevelInserted
		put.ThreadRootIDs = append(put.ThreadRootIDs, r.ThreadRootIDs...)
		if r.LastCreatedAt.After(put.LastCreatedAt) {
			put.LastCreatedAt = r.LastCreatedAt
		}
	}
	putDur := time.Since(start)

	start = time.Now()
	fin, err := e.im.FinalizeParent(ctx, FinalizeSpec{ParentID: "big", ParentType: ParentChannel, NewTopLevel: put.TopLevelInserted,
		ThreadRootIDs: dedupe(put.ThreadRootIDs), LastActivityAt: put.LastCreatedAt})
	mustNoErr(t, err)
	finDur := time.Since(start)

	start = time.Now()
	n, _, err := e.im.IndexParent(ctx, "big", ParentChannel)
	mustNoErr(t, err)
	idxDur := time.Since(start)

	t.Logf("put %d msgs: %s (%.0f msg/s) | finalize %d threads, %d follows: %s | index %d docs: %s",
		put.Inserted, putDur.Round(time.Millisecond), float64(put.Inserted)/putDur.Seconds(),
		fin.ThreadsUpdated, fin.FollowsWritten, finDur.Round(time.Millisecond), n, idxDur.Round(time.Millisecond))
}
