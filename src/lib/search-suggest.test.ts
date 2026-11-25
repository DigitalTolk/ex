import { describe, it, expect } from 'vitest';
import { activeModifier, completeModifier, isoDay, personHandle, placeHandle, suggestDays, suggestPeople, suggestPlaces, type Place } from './search-suggest';

describe('activeModifier', () => {
  it('is the from: or in: being typed as the last word', () => {
    expect(activeModifier('deploy from:ca')).toEqual({ key: 'from', partial: 'ca', start: 7 });
    expect(activeModifier('IN:')).toEqual({ key: 'in', partial: '', start: 0 });
    expect(activeModifier('from:"carol n')).toEqual({ key: 'from', partial: 'carol n', start: 0 });
  });

  it('is nothing once the word is done, or for other words', () => {
    expect(activeModifier('from:carol ')).toBeNull();
    expect(activeModifier('from:"carol ng"')).toBeNull();
    expect(activeModifier('datafrom:x')).toBeNull();
    expect(activeModifier('deploy')).toBeNull();
  });
});

describe('completeModifier', () => {
  it('writes the picked value in place, ready for the next word', () => {
    const q = 'deploy from:ca';
    expect(completeModifier(q, activeModifier(q)!, 'Carol')).toBe('deploy from:Carol ');
  });
});

describe('personHandle', () => {
  const people = [
    { id: 'u-1', displayName: 'Carol Ng', email: 'carol@example.com' },
    { id: 'u-2', displayName: 'Carol Diaz', email: 'cd@example.com' },
    { id: 'u-3', displayName: 'Zed', email: 'zed@example.com' },
    { id: 'u-4', displayName: 'Zed', email: 'zed2@example.com' },
    { id: 'u-5', displayName: 'Ann Lee' },
    { id: 'u-6', displayName: 'Ann Lee' },
  ];
  it('is the shortest name that finds this person alone', () => {
    // "Carol" is Carol Ng's email before the @, which wins over a first
    // name: she is "Carol", and Carol Diaz is written in full.
    expect(personHandle(people[0], people)).toBe('Carol');
    expect(personHandle(people[1], people)).toBe('"Carol Diaz"');
    // Same names: the email.
    expect(personHandle(people[3], people)).toBe('zed2');
    // Nothing that finds them alone: their name, quoted.
    expect(personHandle(people[5], people)).toBe('"Ann Lee"');
  });
});

describe('placeHandle', () => {
  const places: Place[] = [
    { id: 'c-1', name: 'ops', kind: 'channel' },
    { id: 'd-1', name: 'Ada Lovelace', kind: 'conversation' },
    { id: 'd-2', name: 'ops', kind: 'conversation' },
  ];
  it('writes a channel as ~name and a DM by its name', () => {
    expect(placeHandle(places[0], places)).toBe('~ops');
    expect(placeHandle(places[1], places)).toBe('"Ada Lovelace"');
    // A DM named like a channel can't be written apart from it: its name.
    expect(placeHandle(places[2], places)).toBe('ops');
  });
});

describe('suggestPeople / suggestPlaces', () => {
  const people = [
    { id: 'a', displayName: 'Alice Cooper', email: 'alice@example.com' },
    { id: 'c', displayName: 'Carol Ng', email: 'carol@example.com' },
    { id: 'm', displayName: 'Marc', email: 'mcarr@example.com' },
    { id: 'n', displayName: 'Nocturne' },
  ];
  it('ranks a name\'s start, then a later word\'s, then anywhere; never the email domain', () => {
    expect(suggestPeople('c', people).map((p) => p.id)).toEqual(['c', 'a', 'm', 'n']);
    expect(suggestPeople('carr', people).map((p) => p.id)).toEqual(['m']);
    expect(suggestPeople('example', people)).toEqual([]);
    expect(suggestPeople('', people, 2).map((p) => p.id)).toEqual(['a', 'c']);
  });
  it('matches chats with or without ~', () => {
    const places: Place[] = [
      { id: 'c-1', name: 'ops', kind: 'channel' },
      { id: 'c-2', name: 'dev-ops', kind: 'channel' },
    ];
    expect(suggestPlaces('~op', places).map((p) => p.id)).toEqual(['c-1', 'c-2']);
  });
});

describe('date suggestions', () => {
  const now = new Date(2026, 10, 23, 15, 0);

  it('are the date modifier being typed', () => {
    expect(activeModifier('deploy before:2026-11')).toEqual({ key: 'before', partial: '2026-11', start: 7 });
    expect(activeModifier('after:')?.key).toBe('after');
    expect(activeModifier('on:to')?.key).toBe('on');
  });

  it('writes a day in the reader\'s calendar', () => {
    expect(isoDay(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('offer today, yesterday and the days before, each dated', () => {
    const days = suggestDays('', now);
    expect(days.map((d) => d.value)).toEqual(['today', 'yesterday', '2026-11-21', '2026-11-20', '2026-11-19', '2026-11-18', '2026-11-17']);
    expect(days[0].detail).toBeTruthy();
    expect(days[2].detail).toBeUndefined();
    expect(suggestDays('', now, 3)).toHaveLength(3);
  });

  it('match a word, a weekday or a date\'s start, and offer a whole date typed as itself', () => {
    expect(suggestDays('yes', now).map((d) => d.value)).toEqual(['yesterday']);
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(2026, 10, 20)).toLowerCase();
    expect(suggestDays(weekday, now).map((d) => d.value)).toContain('2026-11-20');
    // "2026-11-2" is a whole date itself (November 2nd), first; then the
    // listed days it starts.
    expect(suggestDays('2026-11-2', now).map((d) => d.value)).toEqual(['2026-11-02', '2026-11-21', '2026-11-20']);
    expect(suggestDays('2026-11-', now).map((d) => d.value)).toHaveLength(5);
    expect(suggestDays('2025-01-31', now).map((d) => d.value)).toEqual(['2025-01-31']);
    // Today's date typed out is offered as typed; a listed date only once.
    expect(suggestDays('2026-11-23', now).map((d) => d.value)).toEqual(['2026-11-23']);
    expect(suggestDays('2026-11-20', now).map((d) => d.value)).toEqual(['2026-11-20']);
    expect(suggestDays('zzz', now)).toEqual([]);
    expect(suggestDays('today').map((d) => d.value)).toEqual(['today']);
  });
});
