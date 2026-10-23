import { describe, expect, it } from 'vitest';
import { EPHEMERAL_EVENT_TYPES, EventType, SERVER_INTERNAL_EVENT_TYPES } from './event-types';
import * as wire from '@/types/generated-events';
// Written by internal/events (TestEphemeralTypesFixture) from the Go
// ephemeralTypes set; that test fails when this file is stale.
import goEphemeral from '@/test/wire-fixtures/ephemeral_event_types.json';

describe('event types', () => {
  it('names every event Go declares, and nothing else', () => {
    const goEvents = Object.entries(wire)
      .filter(([name]) => name.startsWith('Event'))
      .map(([, value]) => value)
      .sort();
    expect([...Object.values(EventType), ...SERVER_INTERNAL_EVENT_TYPES].sort()).toEqual(goEvents);
  });

  // A frame the client wrongly treats as durable moves the replay cursor past
  // an in-flight message.new, which the next reconnect then never replays.
  it('treats exactly the events Go never replays as ephemeral', () => {
    const clientVisible = goEphemeral.filter((type) => !(SERVER_INTERNAL_EVENT_TYPES as readonly string[]).includes(type));
    expect([...EPHEMERAL_EVENT_TYPES].sort()).toEqual(clientVisible);
  });

  it('carries typing under its Go name', () => {
    expect(EventType.Typing).toBe('typing');
    expect(EPHEMERAL_EVENT_TYPES.has(EventType.Typing)).toBe(true);
  });
});
