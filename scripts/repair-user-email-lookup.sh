#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/repair-user-email-lookup.sh --email <email> --user-id <canonical-user-id> [--execute]

Repairs duplicate/case-variant USEREMAIL lookup rows for one user by:
  - writing USEREMAIL#<normalized-email> / PROFILE -> canonical user ID
  - deleting any other USEREMAIL#... / PROFILE rows that normalize to the same email

Safety:
  - Dry-run by default. Add --execute to modify DynamoDB.
  - Validates that the canonical user profile exists.
  - Validates that the canonical profile email normalizes to --email.
  - Uses one DynamoDB TransactWriteItems call.

Environment:
  DYNAMODB_TABLE     required, production table name
  AWS_REGION         optional, passed to AWS CLI when set
  AWS_PROFILE        optional, honored by AWS CLI
  DYNAMODB_ENDPOINT  optional, for local/dev DynamoDB only

Example dry-run:
  DYNAMODB_TABLE=infra-ex AWS_PROFILE=dt-infra scripts/repair-user-email-lookup.sh \
    --email Jill@digitaltolk.com \
    --user-id 01KQ7J62ETZPTF2SY2QSD71DNM

Example execute:
  DYNAMODB_TABLE=infra-ex AWS_PROFILE=dt-infra scripts/repair-user-email-lookup.sh \
    --email Jill@digitaltolk.com \
    --user-id 01KQ7J62ETZPTF2SY2QSD71DNM \
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

scan_email_lookup_rows() {
  aws_dynamodb scan \
    --table-name "$DYNAMODB_TABLE" \
    --filter-expression 'begins_with(#pk, :pk) AND #sk = :profile' \
    --projection-expression '#pk, #sk, userID' \
    --expression-attribute-names '{"#pk":"PK","#sk":"SK"}' \
    --expression-attribute-values '{":pk":{"S":"USEREMAIL#"},":profile":{"S":"PROFILE"}}' \
    --output json
}

tmpdir=""
cleanup() {
  if [[ -n "$tmpdir" ]]; then
    rm -rf "$tmpdir"
  fi
}

get_profile() {
  local user_id=$1
  aws_dynamodb get-item \
    --table-name "$DYNAMODB_TABLE" \
    --key "$(jq -cn --arg pk "USER#$user_id" '{PK:{S:$pk},SK:{S:"PROFILE"}}')" \
    --output json
}

main() {
  local email=""
  local user_id=""
  local execute="false"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --email)
        email="${2:-}"
        shift 2
        ;;
      --user-id)
        user_id="${2:-}"
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
  if [[ -z "$email" || -z "$user_id" ]]; then
    echo "--email and --user-id are required." >&2
    usage >&2
    exit 1
  fi

  local normalized_email canonical_pk
  normalized_email=$(normalize_email "$email")
  canonical_pk="USEREMAIL#$normalized_email"
  if [[ -z "$normalized_email" ]]; then
    echo "Email is empty after normalization." >&2
    exit 1
  fi

  local profile_json profile_email
  profile_json=$(get_profile "$user_id")
  if ! jq -e '.Item != null' >/dev/null <<<"$profile_json"; then
    echo "User profile not found: $user_id" >&2
    exit 1
  fi
  profile_email=$(jq -r '.Item.email.S // ""' <<<"$profile_json")
  if [[ "$(normalize_email "$profile_email")" != "$normalized_email" ]]; then
    echo "User profile email mismatch: $profile_email does not normalize to $normalized_email" >&2
    exit 1
  fi

  tmpdir=$(mktemp -d)
  trap cleanup EXIT

  scan_email_lookup_rows >"$tmpdir/email-raw.json"
  jq -r --arg email "$normalized_email" '
    .Items[]
    | {
        pk: .PK.S,
        normalizedEmail: ((.PK.S | sub("^USEREMAIL#"; "")) | ascii_downcase | gsub("^\\s+|\\s+$"; "")),
        userID: (.userID.S // "")
      }
    | select(.normalizedEmail == $email)
    | @json
  ' "$tmpdir/email-raw.json" >"$tmpdir/matching-lookups.jsonl"

  jq -s '.' "$tmpdir/matching-lookups.jsonl" >"$tmpdir/matching-lookups.json"

  local lookup_count noncanonical_count
  lookup_count=$(jq 'length' "$tmpdir/matching-lookups.json")
  noncanonical_count=$(jq --arg canonical "$canonical_pk" '[.[] | select(.pk != $canonical)] | length' "$tmpdir/matching-lookups.json")

  echo "Table: $DYNAMODB_TABLE"
  echo "Normalized email: $normalized_email"
  echo "Canonical userID: $user_id"
  echo "Canonical lookup PK: $canonical_pk"
  echo "Matching lookup rows: $lookup_count"
  jq -r 'if length == 0 then "  none" else .[] | "  pk=" + .pk + " userID=" + .userID end' "$tmpdir/matching-lookups.json"
  echo

  local transact_items
  transact_items=$(
    jq -cn \
      --arg table "$DYNAMODB_TABLE" \
      --arg canonicalPk "$canonical_pk" \
      --arg userID "$user_id" \
      --slurpfile lookups "$tmpdir/matching-lookups.json" \
      '[
        {
          Put: {
            TableName: $table,
            Item: {
              PK: {S: $canonicalPk},
              SK: {S: "PROFILE"},
              userID: {S: $userID}
            }
          }
        }
      ] + (
        $lookups[0]
        | map(select(.pk != $canonicalPk))
        | map({
            Delete: {
              TableName: $table,
              Key: {
                PK: {S: .pk},
                SK: {S: "PROFILE"}
              }
            }
          })
      )'
  )

  if [[ "$execute" != "true" ]]; then
    echo "Dry-run only. No changes were made."
    echo "Would delete $noncanonical_count non-canonical lookup row(s) and upsert the canonical lookup:"
    jq . <<<"$transact_items"
    echo
    echo "Add --execute to apply."
    exit 0
  fi

  echo "Executing lookup repair transaction..."
  aws_dynamodb transact-write-items --transact-items "$transact_items" >/dev/null
  echo "Done. USEREMAIL#$normalized_email points to $user_id; deleted $noncanonical_count non-canonical lookup row(s)."
}

main "$@"
