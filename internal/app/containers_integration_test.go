//go:build integration

package app

import (
	"context"
	"fmt"
	"log"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

// One DynamoDB Local and one Redis container serve every boot test; each
// boot gets its own table.
var (
	dynamoEndpoint string
	redisAddr      string
	containersUp   bool
)

func runWithContainers(m *testing.M) int {
	ctx := context.Background()
	rc, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        "redis:7-alpine",
			ExposedPorts: []string{"6379/tcp"},
			WaitingFor:   wait.ForListeningPort("6379/tcp").WithStartupTimeout(60 * time.Second),
		},
		Started: true,
	})
	if err != nil {
		log.Printf("app boot tests will skip: docker/redis unavailable: %v", err)
		return m.Run()
	}
	defer func() { _ = rc.Terminate(ctx) }()
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
		log.Printf("app boot tests will skip: docker/dynamodb unavailable: %v", err)
		return m.Run()
	}
	defer func() { _ = dc.Terminate(ctx) }()

	rHost, _ := rc.Host(ctx)
	rPort, _ := rc.MappedPort(ctx, "6379")
	dHost, _ := dc.Host(ctx)
	dPort, _ := dc.MappedPort(ctx, "8000")
	redisAddr = fmt.Sprintf("%s:%s", rHost, rPort.Port())
	dynamoEndpoint = fmt.Sprintf("http://%s:%s", dHost, dPort.Port())
	containersUp = true
	return m.Run()
}
