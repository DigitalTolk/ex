// This file was created by `orchestrion pin`, and is used to ensure the
// `go.mod` file contains the necessary entries to ensure repeatable builds when
// using `orchestrion`. It is also used to set up which integrations are enabled.

//go:build tools

//go:generate go run github.com/DataDog/orchestrion pin -generate

package tools

// Imports in this file determine which tracer integrations are enabled in
// orchestrion. New integrations can be automatically discovered by running
// `orchestrion pin` again. You can also manually add new imports here to
// enable additional integrations. When doing so, you can run `orchestrion pin`
// to make sure manually added integrations are valid (i.e, the imported package
// includes a valid `orchestrion.yml` file).
import (
	// Ensures `orchestrion` is present in `go.mod` so that builds are repeatable.
	// Do not remove.
	_ "github.com/DataDog/orchestrion" // integration

	// Deliberately NOT the `orchestrion/all` meta-package: it pulls every
	// contrib (gqlgen, gorm, kafka, …) into go.mod. Only the surfaces this
	// service actually uses are instrumented:
	//   - core tracer (auto-started at boot; runtime enablement is
	//     controlled by DD_TRACE_ENABLED — see Dockerfile)
	_ "github.com/DataDog/dd-trace-go/v2/ddtrace/tracer" // integration
	//   - net/http server (the router) and outbound clients
	_ "github.com/DataDog/dd-trace-go/contrib/net/http/v2" // integration
	//   - Redis (cache, pub/sub, drafts, activity, reminders)
	_ "github.com/DataDog/dd-trace-go/contrib/redis/go-redis.v9/v2" // integration
	//   - AWS SDK v2 (DynamoDB, S3)
	_ "github.com/DataDog/dd-trace-go/contrib/aws/aws-sdk-go-v2/v2/aws" // integration
)
