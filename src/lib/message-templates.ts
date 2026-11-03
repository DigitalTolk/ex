// Message templates (rich webhooks): a saved payload whose strings hold
// {{placeholders}}, filled by the server from the data the app posts.

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]{1,40})\s*\}\}/g;

// templatePlaceholders lists a template's placeholder names, each once, in
// the order they first appear.
export function templatePlaceholders(payload: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(PLACEHOLDER)) found.add(m[1]);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  };
  walk(payload);
  return [...found];
}

// templateCurl is the command that posts a template with data to fill. The
// body is re-serialized JSON in a quoted heredoc, so nothing in it can run in
// the reader's shell.
export function templateCurl(url: string | undefined, key: string, fields: string[]): string {
  const data = Object.fromEntries(fields.map((f) => [f, '…']));
  const body = JSON.stringify({ template: key, data }, null, 2);
  const target = url ? `'${url}'` : '"$EX_WEBHOOK_URL"';
  return `curl -X POST ${target} \\\n  -H 'Content-Type: application/json' \\\n  -H "Authorization: Bearer $EX_BOT_TOKEN" \\\n  --data-binary @- <<'JSON'\n${body}\nJSON`;
}

export const STARTER_TEMPLATE = JSON.stringify(
  {
    text: '{{service}} {{version}} is live',
    blocks: [
      {
        type: 'rich_text',
        content: [
          {
            type: 'paragraph',
            spans: [{ text: '{{service}} {{version}}', bold: true }, { text: ' is live on production.' }],
          },
        ],
      },
    ],
  },
  null,
  2,
);
