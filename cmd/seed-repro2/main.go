// Temporary local-repro seeding tool #2 — NOT shipped. Adds a second guest
// user to the repro channel so another-person-authored roots can be tested.
package main

import (
	"context"
	"log"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

func main() {
	ctx := context.Background()
	db, err := store.New(ctx, store.DBConfig{
		Region:   "us-east-1",
		Endpoint: "http://localhost:28000",
		Table:    "exdb",
	})
	if err != nil {
		log.Fatalf("dynamo: %v", err)
	}

	users := store.NewUserStore(db)
	channels := store.NewChannelStore(db)
	memberships := store.NewMembershipStore(db)

	hash, err := bcrypt.GenerateFromPassword([]byte("repro-pass-123"), bcrypt.DefaultCost)
	if err != nil {
		log.Fatalf("bcrypt: %v", err)
	}
	user := &model.User{
		ID:           "u-other",
		Email:        "other@example.com",
		DisplayName:  "Other Person",
		SystemRole:   model.SystemRoleGuest,
		PasswordHash: string(hash),
		Status:       "active",
		CreatedAt:    time.Now(),
	}
	if err := users.Create(ctx, user); err != nil {
		log.Printf("user create (may already exist): %v", err)
	}

	ch, err := channels.GetByID(ctx, "ch-repro")
	if err != nil {
		log.Fatalf("channel missing (run seed 1 first): %v", err)
	}
	now := time.Now()
	err = memberships.AddChannelMember(ctx, ch,
		&model.ChannelMembership{ChannelID: ch.ID, UserID: user.ID, Role: model.ChannelRoleMember, DisplayName: user.DisplayName, JoinedAt: now},
		&model.UserChannel{UserID: user.ID, ChannelID: ch.ID, ChannelName: ch.Name, ChannelType: ch.Type, Role: model.ChannelRoleMember, JoinedAt: now},
	)
	if err != nil {
		log.Printf("membership (may already exist): %v", err)
	}
	log.Println("seeded: other@example.com / repro-pass-123 in ~repro")
}
