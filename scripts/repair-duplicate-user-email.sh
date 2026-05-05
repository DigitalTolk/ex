#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/repair-duplicate-user-email.sh --email <email> --canonical-user-id <old-user-id> --duplicate-user-id <new-user-id> [--execute]

Repairs a duplicate SSO user by:
  - repointing USEREMAIL#<normalized-email> / PROFILE to the canonical user ID
  - deleting USER#<duplicate-user-id> / PROFILE

Safety:
  - Dry-run by default. Add --execute to modify DynamoDB.
  - Validates that both user profiles exist.
  - Validates that both profiles have the same normalized email as --email.
  - Uses one DynamoDB TransactWriteItems call for the lookup update + profile delete.

Environment:
  DYNAMODB_TABLE     required, production table name
  AWS_REGION         optional, passed to AWS CLI when set
  AWS_PROFILE        optional, honored by AWS CLI
  DYNAMODB_ENDPOINT  optional, for local/dev DynamoDB only

Example dry-run:
  DYNAMODB_TABLE=infra-ex AWS_PROFILE=dt-infra scripts/repair-duplicate-user-email.sh \
    --email Jill@digitaltolk.com \
    --canonical-user-id 01KQ7J62ETZPTF2SY2QSD71DNM \
    --duplicate-user-id 01KQWT9FGJTZK68X37WB9QY9VB

Example execute:
  DYNAMODB_TABLE=infra-ex AWS_PROFILE=dt-infra scripts/repair-duplicate-user-email.sh \
    --email Jill@digitaltolk.com \
    --canonical-user-id 01KQ7J62ETZPTF2SY2QSD71DNM \
    --duplicate-user-id 01KQWT9FGJTZK68X37WB9QY9VB \
    --execute
USAGE
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

normalize_email() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

aws_dynamodb() {
  local args=(dynamodb "$@")
  if [[ -n "${DYNAMODB_ENDPOINT:-}" ]]; then
    args+=(--endpoint-url "$DYNAMODB_ENDPOINT")
  fi
  if [[ -n "${AWS_REGION:-}" ]]; then
    args+=(--region "$AWS_REGION")
  fi
  aws "${args[@]}"
}

get_profile() {
  local user_id=$1
  aws_dynamodb get-item \
    --table-name "$DYNAMODB_TABLE" \
    --key "$(jq -cn --arg pk "USER#$user_id" '{PK:{S:$pk},SK:{S:"PROFILE"}}')" \
    --output json
}

profile_email() {
  jq -r '.Item.email.S // ""'
}

profile_name() {
  jq -r '.Item.displayName.S // ""'
}

profile_created_at() {
  jq -r '.Item.createdAt.S // ""'
}

profile_exists() {
  jq -e '.Item != null' >/dev/null
}

main() {
  local email=""
  local canonical_user_id=""
  local duplicate_user_id=""
  local execute="false"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --email)
        email="${2:-}"
        shift 2
        ;;
      --canonical-user-id)
        canonical_user_id="${2:-}"
        shift 2
        ;;
      --duplicate-user-id)
        duplicate_user_id="${2:-}"
        shift 2
        ;;
      --execute)
        execute="true"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "Unknown argument: $1" >&2
        usage >&2
        exit 1
        ;;
    esac
  done

  need_cmd aws
  need_cmd jq

  if [[ -z "${DYNAMODB_TABLE:-}" ]]; then
    echo "DYNAMODB_TABLE is required." >&2
    exit 1
  fi
  if [[ -z "$email" || -z "$canonical_user_id" || -z "$duplicate_user_id" ]]; then
    echo "--email, --canonical-user-id, and --duplicate-user-id are required." >&2
    usage >&2
    exit 1
  fi
  if [[ "$canonical_user_id" == "$duplicate_user_id" ]]; then
    echo "Canonical and duplicate user IDs must differ." >&2
    exit 1
  fi

  local normalized_email
  normalized_email=$(normalize_email "$email")
  if [[ -z "$normalized_email" ]]; then
    echo "Email is empty after normalization." >&2
    exit 1
  fi

  local canonical_json duplicate_json
  canonical_json=$(get_profile "$canonical_user_id")
  duplicate_json=$(get_profile "$duplicate_user_id")

  if ! profile_exists <<<"$canonical_json"; then
    echo "Canonical user profile not found: $canonical_user_id" >&2
    exit 1
  fi
  if ! profile_exists <<<"$duplicate_json"; then
    echo "Duplicate user profile not found: $duplicate_user_id" >&2
    exit 1
  fi

  local canonical_email duplicate_email
  canonical_email=$(profile_email <<<"$canonical_json")
  duplicate_email=$(profile_email <<<"$duplicate_json")
  if [[ "$(normalize_email "$canonical_email")" != "$normalized_email" ]]; then
    echo "Canonical user email mismatch: $canonical_email does not normalize to $normalized_email" >&2
    exit 1
  fi
  if [[ "$(normalize_email "$duplicate_email")" != "$normalized_email" ]]; then
    echo "Duplicate user email mismatch: $duplicate_email does not normalize to $normalized_email" >&2
    exit 1
  fi

  local current_lookup_user_id
  current_lookup_user_id=$(
    aws_dynamodb get-item \
      --table-name "$DYNAMODB_TABLE" \
      --key "$(jq -cn --arg pk "USEREMAIL#$normalized_email" '{PK:{S:$pk},SK:{S:"PROFILE"}}')" \
      --query 'Item.userID.S' \
      --output text
  )
  if [[ "$current_lookup_user_id" == "None" ]]; then
    current_lookup_user_id=""
  fi

  echo "Table: $DYNAMODB_TABLE"
  echo "Normalized email: $normalized_email"
  echo "Current USEREMAIL lookup: ${current_lookup_user_id:-missing}"
  echo "Canonical user:"
  echo "  userID=$canonical_user_id email=$canonical_email name=$(profile_name <<<"$canonical_json") createdAt=$(profile_created_at <<<"$canonical_json")"
  echo "Duplicate user to delete:"
  echo "  userID=$duplicate_user_id email=$duplicate_email name=$(profile_name <<<"$duplicate_json") createdAt=$(profile_created_at <<<"$duplicate_json")"
  echo

  local transact_items
  transact_items=$(
    jq -cn \
      --arg table "$DYNAMODB_TABLE" \
      --arg emailPk "USEREMAIL#$normalized_email" \
      --arg canonicalUserID "$canonical_user_id" \
      --arg duplicatePk "USER#$duplicate_user_id" \
      '[
        {
          Put: {
            TableName: $table,
            Item: {
              PK: {S: $emailPk},
              SK: {S: "PROFILE"},
              userID: {S: $canonicalUserID}
            }
          }
        },
        {
          Delete: {
            TableName: $table,
            Key: {
              PK: {S: $duplicatePk},
              SK: {S: "PROFILE"}
            },
            ConditionExpression: "attribute_exists(PK)"
          }
        }
      ]'
  )

  if [[ "$execute" != "true" ]]; then
    echo "Dry-run only. No changes were made."
    echo "Would run this TransactWriteItems payload:"
    jq . <<<"$transact_items"
    echo
    echo "Add --execute to apply."
    exit 0
  fi

  echo "Executing repair transaction..."
  aws_dynamodb transact-write-items --transact-items "$transact_items" >/dev/null
  echo "Done. USEREMAIL#$normalized_email now points to $canonical_user_id and duplicate profile $duplicate_user_id was deleted."
  echo "Note: this does not migrate memberships, messages, state, refresh tokens, or other rows that may reference the duplicate user ID."
}

main "$@"
