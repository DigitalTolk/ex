import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventType } from './event-types';
import { dispatchWSEvent, wsEventSchemas } from './ws-events';
import { expectInvalidPayloadReported, parseNotification, wireMessage, wsHandlers } from '@/test/ws-frames';
import notificationMessage from '@/test/wire-fixtures/notification_message.json';
import notificationWebhook from '@/test/wire-fixtures/notification_webhook.json';
import notificationReminder from '@/test/wire-fixtures/notification_reminder.json';

const reportError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/sentry', () => ({ reportError }));

afterEach(() => {
  reportError.mockReset();
});

describe('wsEventSchemas', () => {
  it('has a schema for every event name', () => {
    expect(Object.keys(wsEventSchemas).sort()).toEqual(Object.values(EventType).sort());
  });
});

describe('dispatchWSEvent', () => {
  it('hands the parsed payload to the event handler', () => {
    const onMessageNew = vi.fn();
    dispatchWSEvent('message.new', wireMessage({ extra: 1 }), wsHandlers({ 'message.new': onMessageNew }));
    expect(onMessageNew).toHaveBeenCalledWith(wireMessage({ extra: 1 }));
  });

  it('ignores unknown event types, transport frames and events the app does not handle', () => {
    const handlers = wsHandlers();
    for (const type of ['pong', 'toString', EventType.ReplayDone, EventType.ReplayExhausted, EventType.MessageNew]) {
      expect(() => dispatchWSEvent(type, {}, handlers)).not.toThrow();
    }
    expect(reportError).not.toHaveBeenCalled();
  });

  it('reports a payload that fails its schema to the console and Sentry, and runs the fallback', () => {
    const onMembersChanged = vi.fn();
    const fallback = vi.fn();
    expectInvalidPayloadReported('members.changed', () =>
      dispatchWSEvent('members.changed', { channelID: '' }, wsHandlers({ 'members.changed': onMembersChanged }), {
        'members.changed': fallback,
      }),
    );
    expect(onMembersChanged).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      type: 'members.changed',
      issues: [expect.stringMatching(/^channelID: /)],
    });
  });

  it('names the whole payload when it is not an object at all, and needs no fallback', () => {
    expectInvalidPayloadReported('typing', () => dispatchWSEvent('typing', null, wsHandlers({ typing: vi.fn() })));
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      type: 'typing',
      issues: [expect.stringMatching(/^\(payload\): /)],
    });
  });

  it("lets a handler's throw propagate, so the socket can leave the frame replayable", () => {
    const boom = new Error('cache patch failed');
    const handlers = wsHandlers({
      'draft.updated': () => {
        throw boom;
      },
    });
    expect(() => dispatchWSEvent('draft.updated', {}, handlers)).toThrow(boom);
  });
});

// notification.new is an alert the backend already decided to deliver: its
// schema may not drop one over a field delivery doesn't need.
describe('notification.new schema (lenient)', () => {
  it('parses every notification the backend encodes', () => {
    for (const golden of [notificationMessage, notificationWebhook, notificationReminder]) {
      expect(parseNotification(golden)).toEqual(golden);
    }
  });

  it('keeps unknown fields, and accepts kinds the client has no special handling for', () => {
    const parsed = parseNotification({ ...notificationMessage, kind: 'catchup', futureField: { nested: true } });
    expect(parsed).toMatchObject({ kind: 'catchup', futureField: { nested: true } });
  });

  it('fills missing or mistyped fields it does not need instead of rejecting the alert', () => {
    expect(
      parseNotification({
        kind: 'mention',
        parentID: 'ch-1',
        parentType: 'thread',
        title: 42,
        messageID: 7,
        alertID: null,
        parentMessageID: false,
        authorID: {},
        webhook: 'yes',
        createdAt: 1714564800,
        parentUnreadNotifyCount: 'two',
      }),
    ).toEqual({
      kind: 'mention',
      parentID: 'ch-1',
      parentType: 'channel',
      title: '',
      body: '',
      deepLink: '',
    });
  });

  it('rejects only a payload with no kind or no parentID', () => {
    expect(parseNotification({ parentID: 'ch-1' })).toBeNull();
    expect(parseNotification({ kind: '', parentID: 'ch-1' })).toBeNull();
    expect(parseNotification({ kind: 'message' })).toBeNull();
    expect(parseNotification({ kind: 'message', parentID: '' })).not.toBeNull();
  });
});
