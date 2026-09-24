// Local-dev seeder: users, channels, memberships, and a few messages so a
// fresh DynamoDB-local stack is immediately testable — including the agent
// flow (mention an agent in #general once the desktop runner registers).
//
//	go run ./cmd/seed                       # against the compose stack defaults
//	DYNAMODB_ENDPOINT=... go run ./cmd/seed # override
//
// Idempotent: every write tolerates "already exists", so re-running after a
// wipe or on a live DB is safe. Never shipped — local dev only.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	mathrand "math/rand"
	"os"
	"time"

	"github.com/oklog/ulid/v2"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"golang.org/x/crypto/bcrypt"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/search"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

type seedUser struct {
	id       string
	email    string
	name     string
	role     model.SystemRole
	password string
}

// Alice is an admin (can create channels, use admin pages) — the dev stack
// sets GUEST_LOGIN_ANY_ROLE=true so password login accepts her. Bob and
// Carol stay guests so guest restrictions remain testable.
var seedUsers = []seedUser{
	{"u-seed-alice", "alice@example.com", "Alice", model.SystemRoleAdmin, "password123"},
	{"u-seed-bob", "bob@example.com", "Bob", model.SystemRoleGuest, "password123"},
	{"u-seed-carol", "carol@example.com", "Carol", model.SystemRoleGuest, "password123"},
}

func main() {
	ctx := context.Background()
	// dynamodb-local signs with whatever creds are present; provide dummies
	// BEFORE the SDK loads its config so the seeder runs on machines with no
	// AWS setup at all.
	if os.Getenv("AWS_ACCESS_KEY_ID") == "" {
		_ = os.Setenv("AWS_ACCESS_KEY_ID", "local")
		_ = os.Setenv("AWS_SECRET_ACCESS_KEY", "local")
	}
	db, err := store.New(ctx, store.DBConfig{
		Region: envOr("AWS_REGION", "us-east-1"),
		// 28000 is the host port docker-compose.yml publishes dynamodb-local on.
		Endpoint: envOr("DYNAMODB_ENDPOINT", "http://localhost:28000"),
		Table:    envOr("DYNAMODB_TABLE", "exdb"),
	})
	if err != nil {
		log.Fatalf("dynamo: %v", err)
	}

	if err := db.EnsureTable(ctx); err != nil {
		log.Fatalf("ensure table: %v", err)
	}

	users := store.NewUserStore(db)
	channels := store.NewChannelStore(db)
	memberships := store.NewMembershipStore(db)
	messages := store.NewMessageStore(db)

	// ---------------------------------------------------------------- users
	hash, err := bcrypt.GenerateFromPassword([]byte(seedUsers[0].password), bcrypt.DefaultCost)
	if err != nil {
		log.Fatalf("bcrypt: %v", err)
	}
	now := time.Now()
	var created []*model.User
	for _, su := range seedUsers {
		u := &model.User{
			ID:           su.id,
			Email:        su.email,
			DisplayName:  su.name,
			SystemRole:   su.role,
			AuthProvider: model.AuthProviderGuest,
			PasswordHash: string(hash), // same password for all seed users
			Status:       "active",
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := users.CreateUser(ctx, u); err != nil {
			if errors.Is(err, store.ErrAlreadyExists) {
				// Converge the existing row to the seed spec (role, password,
				// provider) so re-running the seeder always yields loginable
				// accounts, even after the spec changes.
				existing, gerr := users.GetUserByEmail(ctx, su.email)
				if gerr != nil {
					log.Fatalf("load existing user %s: %v", su.email, gerr)
				}
				existing.SystemRole = su.role
				existing.AuthProvider = model.AuthProviderGuest
				existing.PasswordHash = string(hash)
				existing.Status = "active"
				existing.UpdatedAt = now
				if uerr := users.UpdateUser(ctx, existing); uerr != nil {
					log.Fatalf("converge user %s: %v", su.email, uerr)
				}
				log.Printf("user %s already existed — converged to seed spec", su.email)
				created = append(created, existing)
				continue
			}
			log.Fatalf("create user %s: %v", su.email, err)
		}
		log.Printf("user %s (%s / %s)", su.name, su.email, su.password)
		created = append(created, u)
	}
	alice := created[0]

	// ------------------------------------------------------------- channels
	// #general uses the same DeriveID the server's ensureGeneralChannel uses,
	// so login-time auto-join lands everyone in the SAME channel row.
	general := &model.Channel{
		ID:          store.DeriveID("channel:general"),
		Name:        "general",
		Slug:        "general",
		Description: "Company-wide announcements and work-based matters",
		Type:        model.ChannelTypePublic,
		CreatedBy:   alice.ID,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	eng := &model.Channel{
		ID:          store.DeriveID("channel:seed-eng"),
		Name:        "engineering",
		Slug:        "engineering",
		Description: "Build things, discuss things",
		Type:        model.ChannelTypePublic,
		CreatedBy:   alice.ID,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	for _, ch := range []*model.Channel{general, eng} {
		if err := channels.CreateChannel(ctx, ch); err != nil {
			if errors.Is(err, store.ErrAlreadyExists) {
				log.Printf("channel #%s already exists", ch.Name)
				continue
			}
			log.Fatalf("create channel #%s: %v", ch.Name, err)
		}
		log.Printf("channel #%s", ch.Name)
	}

	// ---------------------------------------------------------- memberships
	for _, ch := range []*model.Channel{general, eng} {
		for i, u := range created {
			role := model.ChannelRoleMember
			if i == 0 {
				role = model.ChannelRoleOwner
			}
			err := memberships.AddChannelMember(ctx, ch,
				&model.ChannelMembership{
					ChannelID: ch.ID, UserID: u.ID, Role: role,
					DisplayName: u.DisplayName, JoinedAt: now,
				},
				&model.UserChannel{
					UserID: u.ID, ChannelID: ch.ID, ChannelName: ch.Name,
					ChannelType: ch.Type, Role: role, JoinedAt: now,
				},
			)
			if err != nil && !errors.Is(err, store.ErrAlreadyExists) {
				log.Printf("membership %s → #%s: %v (continuing)", u.DisplayName, ch.Name, err)
			}
		}
	}
	log.Printf("memberships: all seed users in #general and #engineering")

	// ------------------------------------------------------------- messages
	// A little history so thread views, context bundles, and search have
	// something to chew on.
	//
	// IDs must be time-sortable ULIDs, NOT literal strings: the message store
	// orders by ID (MSG#<id> in the SK), and every real message ID is a ULID,
	// so ID order == chronological order. A literal like "m-seed-1" sorts AFTER
	// every real ULID (lowercase 'm' > the digits/uppercase a ULID starts
	// with), which shoved these seed messages BELOW anything posted later and
	// scrambled the date separators. We derive each ID from its OWN CreatedAt
	// (entropy seeded by index for stability), so the ID and the timestamp
	// always agree — the invariant the whole ordering relies on.
	seedMsgs := []struct {
		author string
		body   string
	}{
		{created[0].ID, "Welcome to the local dev workspace 👋"},
		{created[1].ID, "The deploy pipeline is green again — the flaky test was a timezone assumption."},
		{created[2].ID, "I'm drafting the Q3 retro doc, will share here for review tomorrow."},
		{created[0].ID, "Reminder: once your desktop app is running, try mentioning your agent (open **My agents** in the sidebar to see its name)."},
	}
	for i, sm := range seedMsgs {
		createdAt := now.Add(time.Duration(i-len(seedMsgs)) * time.Minute)
		// ULID from createdAt so ID order == time order; index-seeded entropy
		// keeps re-seeds at the same instant stable.
		entropy := ulid.Monotonic(mathrand.New(mathrand.NewSource(int64(i)+1)), 0)
		id := ulid.MustNew(ulid.Timestamp(createdAt), entropy).String()
		msg := &model.Message{
			ID:        id,
			ParentID:  eng.ID,
			AuthorID:  sm.author,
			Body:      sm.body,
			CreatedAt: createdAt,
		}
		if err := messages.CreateMessage(ctx, msg); err != nil && !errors.Is(err, store.ErrAlreadyExists) {
			log.Printf("message %s: %v (continuing)", id, err)
		}
	}
	log.Printf("messages: %d in #engineering", len(seedMsgs))

	// --------------------------------------------------------------- agents
	// The two SHARED workspace agents (gg + qib) — plain users owned by no
	// one; runs execute on whoever invokes them. Same seeding the server does
	// at boot, done here too so a fresh DB is complete before first boot.
	agentStore := store.NewAgentStore(db)
	agentSvc := service.NewAgentService(agentStore, users)
	if err := agentSvc.SeedDefaults(ctx); err != nil {
		log.Fatalf("agent seed: %v", err)
	}
	agentUsers, err := agentSvc.ListAgents(ctx)
	if err != nil {
		log.Fatalf("agent list: %v", err)
	}
	// Converge agent rows seeded by older code that carried a synthetic
	// placeholder email — agents display no email anywhere.
	for _, au := range agentUsers {
		if au.Email == "" {
			continue
		}
		au.Email = ""
		if err := users.UpdateUser(ctx, au); err != nil {
			log.Printf("agent email scrub %s: %v (continuing)", au.DisplayName, err)
		}
	}
	log.Printf("agents: %d shared agents (gg, qib)", len(agentUsers))
	// Converge template LIMITS to the current platform defaults (dev DBs
	// keep rows seeded by older code — e.g. the starvation-prone MaxTurns=3).
	// Personas are left alone so local prompt experiments survive re-seeding.
	for _, slug := range []string{service.AgentSlugGG, service.AgentSlugQib} {
		tpl, err := agentStore.GetTemplate(ctx, slug)
		if err != nil {
			continue
		}
		tpl.Limits = model.DefaultAgentLimits()
		tpl.UpdatedAt = time.Now()
		if err := agentStore.PutTemplate(ctx, tpl); err != nil {
			log.Printf("template limits converge %s: %v (continuing)", slug, err)
		}
	}
	cleanupLegacyOwnedAgents(ctx, db, created)

	// --------------------------------------------------------------- search
	// User/message search is OpenSearch-backed — rows written straight to
	// DynamoDB are invisible to the DM "To:" search until indexed. Best
	// effort: a stack without OpenSearch still seeds everything else.
	indexSeed(ctx, created, agentUsers, []*model.Channel{general, eng})

	fmt.Println()
	fmt.Println("Seed complete. Log in at your local server (password form):")
	for _, su := range seedUsers {
		role := "guest"
		if su.role == model.SystemRoleAdmin {
			role = "admin — can create channels"
		}
		fmt.Printf("  %-22s %s  (%s)\n", su.email, su.password, role)
	}
	fmt.Println("Channels: #general, #engineering (all three users are members)")
	fmt.Println("Agents:   @gg and @qib (shared) — a mention runs on YOUR machine via the desktop app")
}

// cleanupLegacyOwnedAgents deletes the per-owner agent instances ("Alice's
// gg") an earlier iteration of this design created — agents are shared now,
// and the stale rows would otherwise linger in pickers and search. Safe on
// databases that never had them (deletes are no-ops).
func cleanupLegacyOwnedAgents(ctx context.Context, db *store.DB, owners []*model.User) {
	removed := 0
	for _, owner := range owners {
		for _, slug := range []string{service.AgentSlugGG, service.AgentSlugQib} {
			legacyID := store.DeriveID("agent#" + owner.ID + "#" + slug)
			_, err := db.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
				TableName: aws.String(db.Table),
				Key: map[string]types.AttributeValue{
					"PK": &types.AttributeValueMemberS{Value: "USER#" + legacyID},
					"SK": &types.AttributeValueMemberS{Value: "PROFILE"},
				},
			})
			if err != nil {
				log.Printf("legacy agent cleanup %s/%s: %v (continuing)", owner.DisplayName, slug, err)
				continue
			}
			removed++
		}
	}
	log.Printf("legacy per-owner agent rows purged (%d delete calls)", removed)
}

// indexSeed pushes the seeded users (human + agent) and channels into
// OpenSearch so search-backed surfaces (DM "To:" field, global search) see
// them immediately. Failures log and continue — search is an enhancement,
// not a seeding dependency.
func indexSeed(ctx context.Context, humans, agents []*model.User, channels []*model.Channel) {
	client := search.NewClient(envOr("OPENSEARCH_URL", "http://localhost:9200"))
	if client == nil {
		log.Printf("search: no OpenSearch URL; skipping indexing")
		return
	}
	if err := client.EnsureIndices(ctx); err != nil {
		log.Printf("search: unreachable (%v); DM search won't find seeded users until reindex", err)
		return
	}
	indexer := search.NewIndexer(client)
	indexed := 0
	for _, u := range append(append([]*model.User{}, humans...), agents...) {
		if err := indexer.IndexUser(ctx, u); err != nil {
			log.Printf("search: index user %s: %v", u.DisplayName, err)
			continue
		}
		indexed++
	}
	for _, ch := range channels {
		if err := indexer.IndexChannel(ctx, ch); err != nil {
			log.Printf("search: index channel #%s: %v", ch.Name, err)
		}
	}
	log.Printf("search: indexed %d users + %d channels", indexed, len(channels))
}
