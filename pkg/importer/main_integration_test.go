//go:build integration

package importer

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/search"
	"github.com/DigitalTolk/ex/internal/store"
)

// One DynamoDB Local and one Redis container serve the whole package; each test
// gets its own table.
var (
	dynamoEndpoint string
	dynamoReady    bool
	redisAddr      string
	redisReady     bool
	tableSeq       atomic.Uint64
)

func TestMain(m *testing.M) {
	ctx := context.Background()
	rc, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        "redis:7-alpine",
			ExposedPorts: []string{"6379/tcp"},
			WaitingFor:   wait.ForListeningPort("6379/tcp").WithStartupTimeout(60 * time.Second),
		},
		Started: true,
	})
	if err == nil {
		host, _ := rc.Host(ctx)
		port, _ := rc.MappedPort(ctx, "6379")
		redisAddr, redisReady = fmt.Sprintf("%s:%s", host, port.Port()), true
	} else {
		log.Printf("redis unavailable, Open tests will skip: %v", err)
	}
	dc, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        "amazon/dynamodb-local:latest",
			ExposedPorts: []string{"8000/tcp"},
			WaitingFor:   wait.ForListeningPort("8000/tcp").WithStartupTimeout(60 * time.Second),
			Cmd:          []string{"-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb"},
		},
		Started: true,
	})
	if err != nil {
		log.Printf("integration tests will skip: docker unavailable: %v", err)
		os.Exit(m.Run())
	}
	host, _ := dc.Host(ctx)
	port, _ := dc.MappedPort(ctx, "8000")
	dynamoEndpoint, dynamoReady = fmt.Sprintf("http://%s:%s", host, port.Port()), true
	code := m.Run()
	_ = dc.Terminate(ctx)
	if rc != nil {
		_ = rc.Terminate(ctx)
	}
	os.Exit(code)
}

func newTable(t *testing.T) *store.DB {
	t.Helper()
	if !dynamoReady {
		t.Skip("skipping: DynamoDB Local not available")
	}
	ctx := context.Background()
	cfg, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion("us-east-1"),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider("dummy", "dummy", "dummy")),
		awsconfig.WithRetryMaxAttempts(10),
	)
	if err != nil {
		t.Fatal(err)
	}
	db := &store.DB{
		Client: dynamodb.NewFromConfig(cfg, func(o *dynamodb.Options) { o.BaseEndpoint = aws.String(dynamoEndpoint) }),
		Table:  fmt.Sprintf("importer-%d", tableSeq.Add(1)),
	}
	if err := db.EnsureTable(ctx); err != nil {
		t.Fatal(err)
	}
	return db
}

var errFault = errors.New("injected fault")

// faultDynamo wraps the real client; fail decides per operation (and its
// 1-based call number) whether to return errFault instead. before runs
// ahead of a forwarded TransactWriteItems, to stage races.
type faultDynamo struct {
	store.DynamoAPI
	mu     sync.Mutex
	calls  map[string]int
	fail   func(op string, n int) bool
	before func()
}

func (f *faultDynamo) hit(op string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.calls == nil {
		f.calls = map[string]int{}
	}
	f.calls[op]++
	return f.fail != nil && f.fail(op, f.calls[op])
}

func (f *faultDynamo) GetItem(ctx context.Context, in *dynamodb.GetItemInput, o ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	if f.hit("GetItem") {
		return nil, errFault
	}
	return f.DynamoAPI.GetItem(ctx, in, o...)
}

func (f *faultDynamo) PutItem(ctx context.Context, in *dynamodb.PutItemInput, o ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error) {
	if f.hit("PutItem") {
		return nil, errFault
	}
	return f.DynamoAPI.PutItem(ctx, in, o...)
}

func (f *faultDynamo) UpdateItem(ctx context.Context, in *dynamodb.UpdateItemInput, o ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	if f.hit("UpdateItem") {
		return nil, errFault
	}
	return f.DynamoAPI.UpdateItem(ctx, in, o...)
}

func (f *faultDynamo) DeleteItem(ctx context.Context, in *dynamodb.DeleteItemInput, o ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error) {
	if f.hit("DeleteItem") {
		return nil, errFault
	}
	return f.DynamoAPI.DeleteItem(ctx, in, o...)
}

func (f *faultDynamo) Query(ctx context.Context, in *dynamodb.QueryInput, o ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	if f.hit("Query") {
		return nil, errFault
	}
	return f.DynamoAPI.Query(ctx, in, o...)
}

func (f *faultDynamo) Scan(ctx context.Context, in *dynamodb.ScanInput, o ...func(*dynamodb.Options)) (*dynamodb.ScanOutput, error) {
	if f.hit("Scan") {
		return nil, errFault
	}
	return f.DynamoAPI.Scan(ctx, in, o...)
}

func (f *faultDynamo) BatchGetItem(ctx context.Context, in *dynamodb.BatchGetItemInput, o ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error) {
	if f.hit("BatchGetItem") {
		return nil, errFault
	}
	return f.DynamoAPI.BatchGetItem(ctx, in, o...)
}

func (f *faultDynamo) BatchWriteItem(ctx context.Context, in *dynamodb.BatchWriteItemInput, o ...func(*dynamodb.Options)) (*dynamodb.BatchWriteItemOutput, error) {
	if f.hit("BatchWriteItem") {
		return nil, errFault
	}
	return f.DynamoAPI.BatchWriteItem(ctx, in, o...)
}

func (f *faultDynamo) TransactWriteItems(ctx context.Context, in *dynamodb.TransactWriteItemsInput, o ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error) {
	if f.hit("TransactWriteItems") {
		return nil, errFault
	}
	if f.before != nil {
		b := f.before
		f.before = nil
		b()
	}
	return f.DynamoAPI.TransactWriteItems(ctx, in, o...)
}

// failOn fails the n-th call of op (n = 0: every call).
func failOn(op string, n int) func(string, int) bool {
	return func(o string, c int) bool { return o == op && (n == 0 || c == n) }
}

type env struct {
	t       *testing.T
	db      *store.DB
	im      *Importer
	objects *fakeObjects
	search  *fakeSearch
	cache   *fakeCache
}

func newEnv(t *testing.T) *env {
	t.Helper()
	db := newTable(t)
	e := &env{t: t, db: db, objects: &fakeObjects{}, search: &fakeSearch{}, cache: &fakeCache{}}
	im, err := New(Deps{DB: db, Objects: e.objects, Search: e.search, Cache: e.cache, TempDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	e.im = im
	return e
}

// faulty returns an importer over the same table whose DynamoDB client fails
// as configured.
func (e *env) faulty(fail func(string, int) bool) *Importer {
	e.t.Helper()
	im, err := New(Deps{DB: &store.DB{Client: &faultDynamo{DynamoAPI: e.db.Client, fail: fail}, Table: e.db.Table},
		Objects: e.objects, Search: e.search, Cache: e.cache, TempDir: e.t.TempDir()})
	if err != nil {
		e.t.Fatal(err)
	}
	return im
}

func (e *env) racing(before func()) *Importer {
	e.t.Helper()
	im, err := New(Deps{DB: &store.DB{Client: &faultDynamo{DynamoAPI: e.db.Client, before: before}, Table: e.db.Table},
		Objects: e.objects, Search: e.search, TempDir: e.t.TempDir()})
	if err != nil {
		e.t.Fatal(err)
	}
	return im
}

// --- fakes for the non-DynamoDB collaborators ---

type fakeObjects struct {
	mu          sync.Mutex
	objects     map[string][]byte
	sums        map[string]string
	err         error
	headErr     error
	deleteErr   error
	deletedKeys []string
}

func (f *fakeObjects) PutChecksummedObject(_ context.Context, key, _ string, body io.ReadSeeker, size int64, sha string) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	buf := make([]byte, size)
	if _, err := io.ReadFull(body, buf); err != nil {
		return "", err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.objects == nil {
		f.objects, f.sums = map[string][]byte{}, map[string]string{}
	}
	f.objects[key], f.sums[key] = buf, sha
	return `"etag-` + key + `"`, nil
}

func (f *fakeObjects) HeadObject(_ context.Context, key string) (bool, error) {
	if f.headErr != nil {
		return false, f.headErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.objects[key]
	return ok, nil
}

func (f *fakeObjects) DeleteObject(_ context.Context, key string) error {
	if f.deleteErr != nil {
		return f.deleteErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.objects, key)
	f.deletedKeys = append(f.deletedKeys, key)
	return nil
}

type fakeSearch struct {
	mu        sync.Mutex
	bulk      map[string]int
	deleted   []string
	bulkErr   error
	deleteErr error
}

func (f *fakeSearch) Bulk(_ context.Context, index string, entries []search.BulkEntry) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.bulkErr != nil {
		return f.bulkErr
	}
	if f.bulk == nil {
		f.bulk = map[string]int{}
	}
	f.bulk[index] += len(entries)
	return nil
}

func (f *fakeSearch) DeleteDoc(_ context.Context, _ string, id string) error {
	if f.deleteErr != nil {
		return f.deleteErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, id)
	return nil
}

type fakeCache struct {
	deleted []string
	err     error
}

func (f *fakeCache) DeleteUsers(_ context.Context, ids []string) error {
	if f.err != nil {
		return f.err
	}
	f.deleted = append(f.deleted, ids...)
	return nil
}

// errIndexer fails every per-document index call.
type errIndexer struct{ search.NoopIndexer }

func (errIndexer) IndexUser(context.Context, *model.User) error       { return errFault }
func (errIndexer) IndexChannel(context.Context, *model.Channel) error { return errFault }

func mustNoErr(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func wantErr(t *testing.T, err error, target error) {
	t.Helper()
	if !errors.Is(err, target) {
		t.Fatalf("want %v, got %v", target, err)
	}
}
