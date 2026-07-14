import { describe, it, expect } from 'vitest';
import { renderMentionOption, type MentionCompletion } from './optionRender';

function render(meta: MentionCompletion['meta']): HTMLElement | null {
  return renderMentionOption({ label: 'x', meta } as MentionCompletion) as HTMLElement | null;
}

describe('renderMentionOption', () => {
  it('returns null when the completion carries no meta (default rendering)', () => {
    expect(renderMentionOption({ label: 'x' })).toBeNull();
  });

  it('renders a user with an avatar image and email second row', () => {
    const row = render({ kind: 'user', displayName: 'Alice', email: 'a@x.test', avatarURL: 'https://x/a.png', online: true })!;
    expect(row.querySelector('.cm-option-avatar img')?.getAttribute('src')).toBe('https://x/a.png');
    expect(row.querySelector('.cm-option-title')?.textContent).toBe('Alice');
    expect(row.querySelector('.cm-option-sub')?.textContent).toBe('a@x.test');
    expect(row.querySelector('.cm-option-dot')?.getAttribute('data-presence')).toBe('online');
    // The dot is a SIBLING of the notch-masked avatar, never a child — a
    // masked parent would clip it (mirrors UserAvatar's structure).
    expect(row.querySelector('.cm-option-avatar .cm-option-dot')).toBeNull();
    expect(row.querySelector('.cm-option-avatarwrap > .cm-option-dot')).not.toBeNull();
    expect(row.querySelector('.cm-option-avatar')?.classList.contains('cm-option-avatar--notched')).toBe(true);
  });

  it('renders a user without an avatar as an initial, hollow offline dot, no email/status row', () => {
    const row = render({ kind: 'user', displayName: 'bob', online: false })!;
    const avatar = row.querySelector('.cm-option-avatar')!;
    expect(avatar.querySelector('img')).toBeNull();
    expect(avatar.textContent).toBe('B'); // uppercased initial
    // Offline renders the hollow-ring state (shape-coded like PresenceDot),
    // not "no indicator at all".
    expect(row.querySelector('.cm-option-dot')?.getAttribute('data-presence')).toBe('offline');
    expect(row.querySelector('.cm-option-sub')).toBeNull();
    expect(row.querySelector('.cm-option-status')).toBeNull();
  });

  it('renders the user custom-status emoji (resolving a shortcode) next to the name', () => {
    const row = render({ kind: 'user', displayName: 'Alice', online: true, statusEmoji: ':palm_tree:' })!;
    const status = row.querySelector('.cm-option-status')!;
    expect(status).not.toBeNull();
    // :palm_tree: resolves to its unicode glyph (not the literal shortcode).
    expect(status.textContent).not.toBe(':palm_tree:');
  });

  it('passes a unicode status emoji through unchanged', () => {
    const row = render({ kind: 'user', displayName: 'Alice', online: true, statusEmoji: '🌴' })!;
    expect(row.querySelector('.cm-option-status')?.textContent).toBe('🌴');
  });

  it('falls back to "?" for an empty display name', () => {
    const row = render({ kind: 'user', displayName: '   ', online: false })!;
    expect(row.querySelector('.cm-option-avatar')?.textContent).toBe('?');
  });

  it('renders a group as an avatar circle with "@", plus title and description', () => {
    const row = render({ kind: 'group', title: '@all', description: 'Notify everyone' })!;
    const icon = row.querySelector('.cm-option-group')!;
    expect(icon.textContent).toBe('@');
    // The "@" badge reuses the avatar circle styling.
    expect(icon.classList.contains('cm-option-avatar')).toBe(true);
    expect(row.querySelector('.cm-option-title')?.textContent).toBe('@all');
    expect(row.querySelector('.cm-option-sub')?.textContent).toBe('Notify everyone');
  });

  it('renders a public channel with the hash icon', () => {
    const row = render({ kind: 'channel', slug: 'general', isPrivate: false })!;
    expect(row.querySelector('.cm-option-icon svg')).not.toBeNull();
    // hash icon has 4 lines; lock has a rect — distinguish by tag presence.
    expect(row.querySelector('.cm-option-icon rect')).toBeNull();
    expect(row.querySelector('.cm-option-title')?.textContent).toBe('~general');
  });

  it('renders a private channel with the lock icon', () => {
    const row = render({ kind: 'channel', slug: 'secret', isPrivate: true })!;
    expect(row.querySelector('.cm-option-icon rect')).not.toBeNull(); // lock has a rect
  });

  it('renders a standard emoji as a large glyph first', () => {
    const row = render({ kind: 'emoji', name: 'smile', glyph: '😄' })!;
    const glyph = row.querySelector('.cm-option-emoji')!;
    expect(glyph.textContent).toBe('😄');
    expect(row.querySelector('.cm-option-title')?.textContent).toBe(':smile:');
    // glyph is the first child (shown first).
    expect(row.firstElementChild).toBe(glyph);
  });

  it('renders a custom emoji as an image', () => {
    const row = render({ kind: 'emoji', name: 'parrot', imageURL: 'https://x/p.gif' })!;
    expect(row.querySelector('.cm-option-emoji img')?.getAttribute('src')).toBe('https://x/p.gif');
    expect(row.querySelector('.cm-option-title')?.textContent).toBe(':parrot:');
  });

  it('renders an emoji with neither glyph nor image as an empty slot', () => {
    const row = render({ kind: 'emoji', name: 'mystery' })!;
    const glyph = row.querySelector('.cm-option-emoji')!;
    expect(glyph.textContent).toBe('');
    expect(glyph.querySelector('img')).toBeNull();
    expect(row.querySelector('.cm-option-title')?.textContent).toBe(':mystery:');
  });

  it('renders a slash command with a "/" circle, name and description', () => {
    const row = render({ kind: 'command', name: 'mstmeetings', description: 'Start a Microsoft Teams meeting' })!;
    const circle = row.querySelector('.cm-option-avatar.cm-option-group')!;
    expect(circle.textContent).toBe('/');
    expect(row.querySelector('.cm-option-title')?.textContent).toBe('/mstmeetings');
    expect(row.querySelector('.cm-option-sub')?.textContent).toBe('Start a Microsoft Teams meeting');
  });
});
