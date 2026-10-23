import { afterEach, describe, expect, it } from 'vitest';
import {
  formatDocumentTitle,
  getDocumentNotificationCount,
  setDocumentNotificationCount,
} from './document-title';

describe('document title formatting', () => {
  afterEach(() => {
    setDocumentNotificationCount(0);
  });

  it('prefixes the title when there are unread notifications', () => {
    expect(formatDocumentTitle('Threads', 15)).toBe('(15) Threads · ex');
  });

  it('uses the bare title when there are no unread notifications', () => {
    expect(formatDocumentTitle('Threads', 0)).toBe('Threads · ex');
    expect(formatDocumentTitle(null, 0)).toBe('ex');
  });

  it('normalizes invalid notification counts', () => {
    setDocumentNotificationCount(2.9);
    expect(getDocumentNotificationCount()).toBe(2);
    setDocumentNotificationCount(-4);
    expect(getDocumentNotificationCount()).toBe(0);
  });
});

// The count is a zustand store: the per-test reset clears what a test left.
describe('document title between tests', () => {
  it('a test leaves a count behind', () => {
    setDocumentNotificationCount(9);
    expect(formatDocumentTitle('General')).toBe('(9) General · ex');
  });

  it('the next test starts from none', () => {
    expect(getDocumentNotificationCount()).toBe(0);
    expect(formatDocumentTitle('General')).toBe('General · ex');
  });
});
