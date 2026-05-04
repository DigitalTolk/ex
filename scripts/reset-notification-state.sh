#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/reset-notification-state.sh [email]

Clears notification-counter state for a local/dev user:
  - Redis DM unread keys: unread:conversation:<userID>:*
  - DynamoDB notification rows:
    STATE#channel_notification#*
    STATE#thread_notification#*
    STATE#thread_seen#*

Environment overrides:
  DYNAMODB_ENDPOINT  default: http://localhost:8000
  DYNAMODB_TABLE     default: exdb
  AWS_REGION         default: us-east-1
  REDIS_CONTAINER    default: redis
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

json_escape() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '%s' "$value"
}

aws_dynamodb() {
  AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-local}" \
    AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-local}" \
    AWS_REGION="$AWS_REGION" \
    aws dynamodb "$@" --endpoint-url "$DYNAMODB_ENDPOINT" --table-name "$DYNAMODB_TABLE"
}

redis_cli() {
  if command -v redis-cli >/dev/null 2>&1; then
    redis-cli "$@"
    return
  fi
  need_cmd docker
  docker compose exec -T "$REDIS_CONTAINER" redis-cli "$@"
}

delete_state_rows() {
  local user_id=$1
  local kind=$2
  local prefix="STATE#$kind#"
  local deleted=0
  local expression_values
  local rows_json

  expression_values=$(printf '{":pk":{"S":"USER#%s"},":sk":{"S":"%s"}}' \
    "$(json_escape "$user_id")" \
    "$(json_escape "$prefix")")

  rows_json=$(
    aws_dynamodb query \
    --key-condition-expression 'PK = :pk AND begins_with(SK, :sk)' \
    --expression-attribute-values "$expression_values" \
    --projection-expression 'PK, SK' \
    --output json
  )

  if [[ "$(jq '.Items | length' <<<"$rows_json")" -gt 0 ]]; then
    while IFS=$'\t' read -r pk sk; do
      if [[ -z "${pk:-}" || -z "${sk:-}" ]]; then
        continue
      fi
      aws_dynamodb delete-item \
        --key "{\"PK\":{\"S\":\"$(json_escape "$pk")\"},\"SK\":{\"S\":\"$(json_escape "$sk")\"}}" \
        >/dev/null
      deleted=$((deleted + 1))
    done < <(jq -r '.Items[] | [.PK.S, .SK.S] | @tsv' <<<"$rows_json")
  fi

  echo "Deleted $deleted DynamoDB $kind row(s)."
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi

  need_cmd aws
  need_cmd jq

  DYNAMODB_ENDPOINT="${DYNAMODB_ENDPOINT:-http://localhost:8000}"
  DYNAMODB_TABLE="${DYNAMODB_TABLE:-exdb}"
  AWS_REGION="${AWS_REGION:-us-east-1}"
  REDIS_CONTAINER="${REDIS_CONTAINER:-redis}"

  local email="${1:-}"
  if [[ -z "$email" ]]; then
    read -r -p "User email: " email
  fi
  email=$(normalize_email "$email")
  if [[ -z "$email" ]]; then
    echo "Email is required." >&2
    exit 1
  fi

  local user_id
  user_id=$(
    aws_dynamodb get-item \
      --key "{\"PK\":{\"S\":\"USEREMAIL#$(json_escape "$email")\"},\"SK\":{\"S\":\"PROFILE\"}}" \
      --projection-expression 'userID' \
      --query 'Item.userID.S' \
      --output text
  )
  if [[ -z "$user_id" || "$user_id" == "None" ]]; then
    echo "No user found for email: $email" >&2
    exit 1
  fi

  echo "Resetting notification state for $email ($user_id)."

  local redis_pattern="unread:conversation:$user_id:*"
  local redis_deleted=0
  local redis_keys

  redis_keys=$(redis_cli --scan --pattern "$redis_pattern")
  if [[ -n "$redis_keys" ]]; then
    while IFS= read -r key; do
      if [[ -z "$key" ]]; then
        continue
      fi
      redis_cli del "$key" >/dev/null
      redis_deleted=$((redis_deleted + 1))
    done <<<"$redis_keys"
  fi
  echo "Deleted $redis_deleted Redis conversation unread key(s)."

  delete_state_rows "$user_id" "channel_notification"
  delete_state_rows "$user_id" "thread_notification"
  delete_state_rows "$user_id" "thread_seen"

  echo "Done. Hard-refresh the browser tab or restart the desktop app before retesting."
}

main "$@"
