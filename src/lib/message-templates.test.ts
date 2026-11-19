import { describe, expect, it } from 'vitest';
import { STARTER_TEMPLATE, templateCurl, templatePlaceholders } from './message-templates';

describe('templatePlaceholders', () => {
  it('lists each placeholder once, in order, from strings at any depth', () => {
    const payload = {
      text: '{{service}} {{ version }} is live',
      n: 3,
      on: true,
      none: null,
      blocks: [{ type: 'rich_text', content: [{ spans: [{ text: '{{service}} by {{owner}}' }, { text: 'no fields' }] }] }],
    };
    expect(templatePlaceholders(payload)).toEqual(['service', 'version', 'owner']);
    expect(templatePlaceholders(JSON.parse(STARTER_TEMPLATE))).toEqual(['service', 'version']);
  });
});

describe('templateCurl', () => {
  it('posts the template with its fields, to the webhook or a placeholder URL', () => {
    const cmd = templateCurl('https://chat.example/hooks/abc', 'deploy', ['service', 'version']);
    expect(cmd).toContain("curl -X POST 'https://chat.example/hooks/abc'");
    expect(cmd).toContain('Authorization: Bearer $EX_BOT_TOKEN');
    expect(cmd).toContain(`"template": "deploy"`);
    expect(cmd).toContain(`"service": "…"`);
    expect(cmd.endsWith('\nJSON')).toBe(true);
    expect(templateCurl(undefined, 'deploy', [])).toContain('curl -X POST "$EX_WEBHOOK_URL"');
  });
});
