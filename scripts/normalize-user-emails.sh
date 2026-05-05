#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/normalize-user-emails.sh [--email <email>] [--verbose] [--execute]

Normalizes existing DynamoDB user email storage by:
  - lowercasing and trimming USER# profile email attributes
  - upserting USEREMAIL#<normalized-email> / PROFILE lookup rows
  - deleting non-canonical USEREMAIL# case/space variant lookup rows

Safety:
  - Dry-run by default. Add --execute to modify DynamoDB.
  - Refuses to run when multiple USER# profiles normalize to the same email.
    Resolve duplicates first with scripts/repair-duplicate-user-email.sh.
  - Can be scoped to one email with --email.
  - Safe to rerun.

Environment:
  DYNAMODB_TABLE     required, production table name
  AWS_REGION         optional, passed to AWS CLI when set
  AWS_PROFILE        optional, honored by AWS CLI
  DYNAMODB_ENDPOINT  optional, for local/dev DynamoDB only

Examples:
  DYNAMODB_TABLE=infra-ex AWS_PROFILE=dt-infra scripts/normalize-user-emails.sh
  DYNAMODB_TABLE=infra-ex AWS_PROFILE=dt-infra scripts/normalize-user-emails.sh --execute
  DYNAMODB_TABLE=infra-ex AWS_PROFILE=dt-infra scripts/normalize-user-emails.sh --verbose
  DYNAMODB_TABLE=infra-ex AWS_PROFILE=dt-infra scripts/normalize-user-emails.sh --email Jill@digitaltolk.com --execute
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

scan_rows() {
  local pk_prefix=$1
  aws_dynamodb scan \
    --table-name "$DYNAMODB_TABLE" \
    --filter-expression 'begins_with(#pk, :pk) AND #sk = :profile' \
    --projection-expression '#pk, #sk, id, email, displayName, userID, createdAt' \
    --expression-attribute-names '{"#pk":"PK","#sk":"SK"}' \
    --expression-attribute-values "{\":pk\":{\"S\":\"$pk_prefix\"},\":profile\":{\"S\":\"PROFILE\"}}" \
    --output json
}

json_key() {
  local pk=$1
  jq -cn --arg pk "$pk" '{PK:{S:$pk},SK:{S:"PROFILE"}}'
}

tmpdir=""
cleanup() {
  if [[ -n "$tmpdir" ]]; then
    rm -rf "$tmpdir"
  fi
}

main() {
  local only_email=""
  local execute="false"
  local verbose="false"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --email)
        only_email="${2:-}"
        shift 2
        ;;
      --execute)
        execute="true"
        shift
        ;;
      --verbose)
        verbose="true"
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

  local only_normalized=""
  if [[ -n "$only_email" ]]; then
    only_normalized=$(normalize_email "$only_email")
    if [[ -z "$only_normalized" ]]; then
      echo "Email is empty after normalization." >&2
      exit 1
    fi
  fi

  tmpdir=$(mktemp -d)
  trap cleanup EXIT

  echo "Scanning $DYNAMODB_TABLE for user profiles and email lookup rows..."
  scan_rows "USER#" >"$tmpdir/users-raw.json"
  scan_rows "USEREMAIL#" >"$tmpdir/email-raw.json"

  jq -r '
    .Items[]
    | {
        pk: .PK.S,
        userID: (.id.S // ""),
        email: (.email.S // ""),
        normalizedEmail: ((.email.S // "") | ascii_downcase | gsub("^\\s+|\\s+$"; "")),
        displayName: (.displayName.S // ""),
        createdAt: (.createdAt.S // "")
      }
    | @json
  ' "$tmpdir/users-raw.json" >"$tmpdir/users.jsonl"

  jq -r '
    .Items[]
    | {
        pk: .PK.S,
        normalizedEmail: ((.PK.S | sub("^USEREMAIL#"; "")) | ascii_downcase | gsub("^\\s+|\\s+$"; "")),
        userID: (.userID.S // "")
      }
    | @json
  ' "$tmpdir/email-raw.json" >"$tmpdir/email-index.jsonl"

  jq -s --arg only "$only_normalized" '
    if $only == "" then . else map(select(.normalizedEmail == $only)) end
    | sort_by(.normalizedEmail, .createdAt, .userID)
  ' "$tmpdir/users.jsonl" >"$tmpdir/users.json"

  jq -s --arg only "$only_normalized" '
    if $only == "" then . else map(select(.normalizedEmail == $only)) end
    | sort_by(.normalizedEmail, .pk)
  ' "$tmpdir/email-index.jsonl" >"$tmpdir/email-index.json"

  jq -r '
    group_by(.normalizedEmail)
    | map(select(.[0].normalizedEmail != "" and length > 1))
    | .[]
    | "  " + .[0].normalizedEmail + " (" + (length|tostring) + " users)"
      , (.[] | "    userID=" + .userID + " email=" + .email + " name=" + .displayName + " createdAt=" + .createdAt)
  ' "$tmpdir/users.json" >"$tmpdir/duplicates.txt"

  if [[ -s "$tmpdir/duplicates.txt" ]]; then
    echo "Refusing to normalize because duplicate normalized emails exist:"
    cat "$tmpdir/duplicates.txt"
    echo
    echo "Resolve duplicates first, then rerun this script."
    exit 1
  fi

  jq -c --slurpfile idx "$tmpdir/email-index.json" '
    ($idx[0] | group_by(.normalizedEmail) | map({key: .[0].normalizedEmail, value: .}) | from_entries) as $lookupByEmail
    | .[]
    | select(.normalizedEmail != "")
    | ($lookupByEmail[.normalizedEmail] // []) as $lookups
    | ("USEREMAIL#" + .normalizedEmail) as $canonicalPK
    | {
        userID,
        profilePK: .pk,
        email,
        normalizedEmail,
        updateProfile: (.email != .normalizedEmail),
        canonicalLookupPK: $canonicalPK,
        canonicalLookupUserID: ([$lookups[] | select(.pk == $canonicalPK) | .userID][0] // ""),
        deleteLookupPKs: [$lookups[] | select(.pk != $canonicalPK) | .pk]
      }
    | select(.updateProfile or .canonicalLookupUserID != .userID or (.deleteLookupPKs | length) > 0)
  ' "$tmpdir/users.json" >"$tmpdir/plan.jsonl"

  jq -c --slurpfile idx "$tmpdir/email-index.json" '
    ($idx[0] | group_by(.normalizedEmail) | map({key: .[0].normalizedEmail, value: .}) | from_entries) as $lookupByEmail
    | .[]
    | select(.normalizedEmail != "")
    | ($lookupByEmail[.normalizedEmail] // []) as $lookups
    | ("USEREMAIL#" + .normalizedEmail) as $canonicalPK
    | {
        userID,
        email,
        normalizedEmail,
        canonicalLookupPK: $canonicalPK,
        canonicalLookupUserID: ([$lookups[] | select(.pk == $canonicalPK) | .userID][0] // ""),
        nonCanonicalLookupPKs: [$lookups[] | select(.pk != $canonicalPK) | .pk]
      }
    | select(.email == .normalizedEmail and .canonicalLookupUserID == .userID and (.nonCanonicalLookupPKs | length) == 0)
  ' "$tmpdir/users.json" >"$tmpdir/canonical.jsonl"

  local plan_count profile_updates lookup_upserts lookup_deletes
  plan_count=$(wc -l <"$tmpdir/plan.jsonl" | tr -d ' ')
  profile_updates=$(jq -s '[.[] | select(.updateProfile)] | length' "$tmpdir/plan.jsonl")
  lookup_upserts=$(jq -s '[.[] | select(.canonicalLookupUserID != .userID)] | length' "$tmpdir/plan.jsonl")
  lookup_deletes=$(jq -s '[.[].deleteLookupPKs[]] | length' "$tmpdir/plan.jsonl")

  echo "User profile rows checked: $(jq 'length' "$tmpdir/users.json")"
  echo "Email lookup rows checked: $(jq 'length' "$tmpdir/email-index.json")"
  echo "Users needing changes: $plan_count"
  echo "Profile email updates: $profile_updates"
  echo "Canonical lookup upserts: $lookup_upserts"
  echo "Non-canonical lookup deletes: $lookup_deletes"
  echo "Already canonical users not shown: $(wc -l <"$tmpdir/canonical.jsonl" | tr -d ' ')"
  echo

  if [[ "$verbose" == "true" ]]; then
    echo "Already canonical users:"
    jq -r '
      if . == null then empty else
        "  userID=" + .userID + " email=" + .email + " lookup=" + .canonicalLookupPK
      end
    ' "$tmpdir/canonical.jsonl"
    echo
  fi

  if [[ "$plan_count" == "0" ]]; then
    echo "No email normalization changes needed."
    exit 0
  fi

  echo "Planned changes:"
  jq -r '
    "  userID=" + .userID + " email=" + .email + " normalized=" + .normalizedEmail
    + (if .updateProfile then " update-profile" else "" end)
    + (if .canonicalLookupUserID != .userID then " upsert-lookup" else "" end)
    + (if (.deleteLookupPKs | length) > 0 then " delete-lookups=" + (.deleteLookupPKs | join(",")) else "" end)
  ' "$tmpdir/plan.jsonl"
  echo

  if [[ "$execute" != "true" ]]; then
    echo "Dry-run only. No changes were made. Add --execute to apply."
    exit 0
  fi

  echo "Applying email normalization..."
  while IFS= read -r item; do
    local user_id profile_pk email normalized canonical_pk current_lookup
    user_id=$(jq -r '.userID' <<<"$item")
    profile_pk=$(jq -r '.profilePK' <<<"$item")
    email=$(jq -r '.email' <<<"$item")
    normalized=$(jq -r '.normalizedEmail' <<<"$item")
    canonical_pk=$(jq -r '.canonicalLookupPK' <<<"$item")
    current_lookup=$(jq -r '.canonicalLookupUserID' <<<"$item")

    if [[ "$(jq -r '.updateProfile' <<<"$item")" == "true" ]]; then
      echo "  update profile $user_id: $email -> $normalized"
      aws_dynamodb update-item \
        --table-name "$DYNAMODB_TABLE" \
        --key "$(json_key "$profile_pk")" \
        --update-expression 'SET email = :email' \
        --condition-expression 'attribute_exists(PK)' \
        --expression-attribute-values "$(jq -cn --arg email "$normalized" '{":email":{S:$email}}')" \
        >/dev/null
    fi

    if [[ "$current_lookup" != "$user_id" ]]; then
      echo "  upsert $canonical_pk -> $user_id"
      aws_dynamodb put-item \
        --table-name "$DYNAMODB_TABLE" \
        --item "$(jq -cn --arg pk "$canonical_pk" --arg userID "$user_id" '{PK:{S:$pk},SK:{S:"PROFILE"},userID:{S:$userID}}')" \
        >/dev/null
    fi

    jq -r '.deleteLookupPKs[]' <<<"$item" | while IFS= read -r stale_pk; do
      echo "  delete $stale_pk"
      aws_dynamodb delete-item \
        --table-name "$DYNAMODB_TABLE" \
        --key "$(json_key "$stale_pk")" \
        >/dev/null
    done
  done <"$tmpdir/plan.jsonl"

  echo
  echo "Done. Rerun scripts/audit-user-email-index.sh to verify the table is clean."
}

main "$@"
