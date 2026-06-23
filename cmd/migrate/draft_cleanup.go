package main

import (
	"context"
	"log/slog"

	"github.com/DigitalTolk/ex/internal/store"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// runDraftCleanup deletes orphaned DRAFT# rows left in DynamoDB after drafts
// moved to Redis. Those rows are inert (nothing reads them anymore); this reaps
// them for tidiness. Scans the whole table filtering SK begins_with "DRAFT#",
// then deletes each by its (PK, SK) key.
//
// Idempotent: a re-run simply finds nothing left to delete (DeleteItem on an
// already-absent key is a no-op too), so it can be run as many times as needed.
func runDraftCleanup(ctx context.Context, db *store.DB, args []string) int {
	dryRun, verbose, mode := migrateFlags("draft-cleanup", args, nil)

	slog.Info("starting draft-cleanup", "mode", mode, "table", db.Table)

	var scanned, deleted, errCount int
	var startKey map[string]types.AttributeValue
	for {
		out, err := db.Client.Scan(ctx, &dynamodb.ScanInput{
			TableName:                 aws.String(db.Table),
			FilterExpression:          aws.String("begins_with(SK, :p)"),
			ProjectionExpression:      aws.String("PK, SK"),
			ExpressionAttributeValues: map[string]types.AttributeValue{":p": &types.AttributeValueMemberS{Value: "DRAFT#"}},
			ExclusiveStartKey:         startKey,
		})
		if err != nil {
			fatal("scan drafts", err)
		}
		for _, item := range out.Items {
			scanned++
			pk, sk := item["PK"], item["SK"]
			if pk == nil || sk == nil {
				continue
			}
			if verbose {
				slog.Info("orphan draft", "PK", avString(pk), "SK", avString(sk))
			}
			if dryRun {
				deleted++
				continue
			}
			if _, err := db.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
				TableName: aws.String(db.Table),
				Key:       map[string]types.AttributeValue{"PK": pk, "SK": sk},
			}); err != nil {
				slog.Warn("delete draft failed", "PK", avString(pk), "SK", avString(sk), "error", err)
				errCount++
				continue
			}
			deleted++
		}
		if out.LastEvaluatedKey == nil {
			break
		}
		startKey = out.LastEvaluatedKey
	}

	slog.Info("draft-cleanup complete", "mode", mode, "scanned", scanned, "deleted", deleted, "errors", errCount)
	if errCount > 0 {
		return 1
	}
	return 0
}

// avString renders a string AttributeValue for logging, or "" for anything else.
func avString(v types.AttributeValue) string {
	if s, ok := v.(*types.AttributeValueMemberS); ok {
		return s.Value
	}
	return ""
}
