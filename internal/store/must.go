package store

import (
	"fmt"

	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// The must* helpers wrap SDK calls whose failure is a programmer error, not a
// runtime condition: expression.Build over compile-time-constant names, and
// MarshalMap over structs of scalar/string/time fields. Such calls cannot fail
// for any input this package produces, so their error branches at ~50 call
// sites were permanently dead — untestable without faking the SDK itself.
// Collapsing them into panic-on-impossible (the template.Must idiom) keeps the
// contract explicit while leaving no unreachable lines behind. NOTE: unmarshal
// of data read back from DynamoDB is NOT in this family — a corrupt or
// foreign-written row is a runtime condition, so those error branches stay and
// are exercised by fault-injection tests feeding type-mismatched items.

// mustExpr returns the built expression, panicking on the impossible error.
func mustExpr(expr expression.Expression, err error) expression.Expression {
	if err != nil {
		panic(fmt.Sprintf("store: static expression failed to build: %v", err))
	}
	return expr
}

// mustAttrs returns the marshaled attribute map, panicking on the impossible
// error.
func mustAttrs(av map[string]types.AttributeValue, err error) map[string]types.AttributeValue {
	if err != nil {
		panic(fmt.Sprintf("store: static struct failed to marshal: %v", err))
	}
	return av
}

// mustJSON returns the encoded bytes, panicking on the impossible error —
// used only for models made of scalar/string/time fields (json.Marshal of
// such shapes cannot fail).
func mustJSON(b []byte, err error) []byte {
	if err != nil {
		panic(fmt.Sprintf("store: static struct failed to marshal to JSON: %v", err))
	}
	return b
}
