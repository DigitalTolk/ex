#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/audit-user-email-index.sh [email]

Read-only DynamoDB audit for user email lookup consistency.

Checks:
  - duplicate USER# profile rows with the same normalized email
  - duplicate users shadowed by the single USEREMAIL#<email> lookup row
  - non-canonical USEREMAIL lookup keys (case/space variants)
  - USER# profile rows missing their USEREMAIL#<email> lookup row
  - USEREMAIL# lookup rows pointing at missing users
  - USEREMAIL# lookup rows pointing at a user with a different email

Environment:
  DYNAMODB_TABLE     required, production table name
  AWS_REGION         optional, passed to AWS CLI when set
  AWS_PROFILE        optional, honored by AWS CLI
  DYNAMODB_ENDPOINT  optional, for local/dev DynamoDB only

Examples:
  DYNAMODB_TABLE=ex-prod scripts/audit-user-email-index.sh
  DYNAMODB_TABLE=ex-prod scripts/audit-user-email-index.sh Jill@digitaltolk.com
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
    --projection-expression '#pk, #sk, id, email, displayName, userID, createdAt, authProvider, systemRole, #status' \
    --expression-attribute-names '{"#pk":"PK","#sk":"SK","#status":"status"}' \
    --expression-attribute-values "{\":pk\":{\"S\":\"$pk_prefix\"},\":profile\":{\"S\":\"PROFILE\"}}" \
    --output json
}

tmpdir=""
cleanup() {
  if [[ -n "$tmpdir" ]]; then
    rm -rf "$tmpdir"
  fi
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi

  need_cmd aws
  need_cmd jq

  if [[ -z "${DYNAMODB_TABLE:-}" ]]; then
    echo "DYNAMODB_TABLE is required." >&2
    echo "Example: DYNAMODB_TABLE=ex-prod scripts/audit-user-email-index.sh" >&2
    exit 1
  fi

  local only_email="${1:-}"
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
        createdAt: (.createdAt.S // ""),
        authProvider: (.authProvider.S // ""),
        systemRole: (.systemRole.S // ""),
        status: (.status.S // "")
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
    def maybe_filter:
      if $only == "" then .
      else map(select(.normalizedEmail == $only))
      end;
    maybe_filter
    | sort_by(.normalizedEmail, .createdAt, .userID)
  ' "$tmpdir/users.jsonl" >"$tmpdir/users.json"

  jq -s --arg only "$only_normalized" '
    def maybe_filter:
      if $only == "" then .
      else map(select(.normalizedEmail == $only))
      end;
    maybe_filter
    | sort_by(.normalizedEmail)
  ' "$tmpdir/email-index.jsonl" >"$tmpdir/email-index.json"

  local user_count email_count
  user_count=$(jq 'length' "$tmpdir/users.json")
  email_count=$(jq 'length' "$tmpdir/email-index.json")
  echo "User profile rows checked: $user_count"
  echo "Email lookup rows checked: $email_count"
  echo

  echo "Duplicate normalized emails:"
  jq -r '
    group_by(.normalizedEmail)
    | map(select(.[0].normalizedEmail != "" and length > 1))
    | if length == 0 then "  none"
      else .[]
        | "  " + .[0].normalizedEmail + " (" + (length|tostring) + " users)"
        , (.[] | "    userID=" + .userID + " email=" + .email + " name=" + .displayName + " createdAt=" + .createdAt + " role=" + .systemRole + " provider=" + .authProvider + " status=" + .status)
      end
  ' "$tmpdir/users.json"
  echo

  echo "Users missing USEREMAIL lookup:"
  jq -r --slurpfile idx "$tmpdir/email-index.json" '
    ($idx[0] | map({key: .normalizedEmail, value: .userID}) | from_entries) as $emailToUser
    | map(select(.normalizedEmail != "" and (($emailToUser[.normalizedEmail] // "") == "")))
    | if length == 0 then "  none"
      else .[]
        | "  userID=" + .userID + " email=" + .email + " normalized=" + .normalizedEmail + " name=" + .displayName + " createdAt=" + .createdAt
      end
  ' "$tmpdir/users.json"
  echo

  echo "Duplicate users not referenced by USEREMAIL lookup:"
  jq -r --slurpfile idx "$tmpdir/email-index.json" '
    ($idx[0] | map({key: .normalizedEmail, value: .userID}) | from_entries) as $emailToUser
    | group_by(.normalizedEmail)
    | map(select(.[0].normalizedEmail != "" and length > 1))
    | if length == 0 then "  none"
      else .[]
        | .[0].normalizedEmail as $email
        | ($emailToUser[$email] // "") as $lookupUserID
        | if $lookupUserID == "" then
            "  " + $email + " has no USEREMAIL lookup row"
          else
            ("  " + $email + " lookup points to userID=" + $lookupUserID),
            (.[] | select(.userID != $lookupUserID) | "    shadowed userID=" + .userID + " email=" + .email + " name=" + .displayName + " createdAt=" + .createdAt + " role=" + .systemRole + " provider=" + .authProvider + " status=" + .status)
          end
      end
  ' "$tmpdir/users.json"
  echo

  echo "Non-canonical USEREMAIL lookup rows:"
  jq -r '
    map(select(.normalizedEmail != "" and .pk != ("USEREMAIL#" + .normalizedEmail)))
    | if length == 0 then "  none"
      else .[]
        | "  pk=" + .pk + " normalized=" + .normalizedEmail + " userID=" + .userID + " canonicalPK=USEREMAIL#" + .normalizedEmail
      end
  ' "$tmpdir/email-index.json"
  echo

  echo "Stale/mismatched USEREMAIL lookup rows:"
  jq -r --slurpfile users "$tmpdir/users.json" '
    ($users[0] | map({key: .userID, value: .}) | from_entries) as $userByID
    | map({
        lookupEmail: .normalizedEmail,
        lookupUserID: .userID,
        user: ($userByID[.userID] // null)
      })
    | map(select(.user == null or .user.normalizedEmail != .lookupEmail))
    | if length == 0 then "  none"
      else .[]
        | if .user == null then
            "  lookup=" + .lookupEmail + " -> missing userID=" + .lookupUserID
          else
            "  lookup=" + .lookupEmail + " -> userID=" + .lookupUserID + " but profile email=" + .user.email + " normalized=" + .user.normalizedEmail
          end
      end
  ' "$tmpdir/email-index.json"

  echo
  echo "Audit complete. This script is read-only; it did not modify DynamoDB."
}

main "$@"
