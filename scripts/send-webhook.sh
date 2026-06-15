#!/usr/bin/env bash
#
# send-webhook.sh — post two demo messages to an Ex incoming webhook:
#   1. a plain text message
#   2. a message with a Mattermost-style attachment
#
# Usage:
#   scripts/send-webhook.sh <webhook-url>
#   WEBHOOK_URL=https://chat.example/hooks/<id> scripts/send-webhook.sh
#
# Create a webhook URL in the app under the "Incoming webhooks" page
# (avatar menu → Incoming webhooks).

set -euo pipefail

WEBHOOK_URL="${1:-${WEBHOOK_URL:-}}"
if [[ -z "$WEBHOOK_URL" ]]; then
  echo "usage: $0 <webhook-url>" >&2
  echo "   or: WEBHOOK_URL=https://chat.example/hooks/<id> $0" >&2
  exit 1
fi

post() {
  # -f: fail on HTTP >= 400, -s: silent, -S: still show errors.
  curl -fsS -X POST "$WEBHOOK_URL" -H 'Content-Type: application/json' -d "$1"
  echo
}

echo "→ 1/2 simple message"
post '{"text":"Hello from the webhook test script :wave:"}'

echo "→ 2/2 message with attachments"
post '{
  "text": "Deploy finished",
  "attachments": [
    {
      "fallback": "Build #123 succeeded",
      "color": "#36a64f",
      "pretext": "CI pipeline update",
      "author_name": "CI Bot",
      "author_link": "https://ci.example.com",
      "title": "Build #123 succeeded",
      "title_link": "https://ci.example.com/builds/123",
      "text": "All **42** tests passed in 3m12s.",
      "fields": [
        { "title": "Branch", "value": "main", "short": true },
        { "title": "Commit", "value": "a1b2c3d", "short": true },
        { "title": "Notes", "value": "Deployed to production", "short": false }
      ],
      "image_url": "https://placehold.co/600x400/png",
      "thumb_url": "https://placehold.co/75x75/png",
      "footer": "ex webhook demo",
      "footer_icon": "https://placehold.co/16x16/png"
    }
  ]
}'

echo "✓ done"
