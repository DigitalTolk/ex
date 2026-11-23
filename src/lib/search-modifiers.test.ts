import { describe, it, expect } from 'vitest';
import { dateRange, foldName, parseSearchModifiers, resolveDay, resolveFromPerson, resolveInPlace, unmatchedNote, withoutModifier } from './search-modifiers';

describe('parseSearchModifiers', () => {
  it('takes from: and in: out of the words, anywhere in the query', () => {
    expect(parseSearchModifiers('datadog from:Günter')).toEqual({ text: 'datadog', from: 'Günter' });
    expect(parseSearchModifiers('in:~ops  deploy failed  FROM:@ada')).toEqual({ text: 'deploy failed', in: '~ops', from: '@ada' });
  });

  it('reads a quoted value with spaces', () => {
    expect(parseSearchModifiers('from:"Günter Weber" alerts')).toEqual({ text: 'alerts', from: 'Günter Weber' });
  });

  it('leaves text that only looks like a modifier', () => {
    // No value, a word ending in "from:", or an empty quote: all just words.
    expect(parseSearchModifiers('from: x')).toEqual({ text: 'from: x' });
    expect(parseSearchModifiers('datafrom:x')).toEqual({ text: 'datafrom:x' });
    expect(parseSearchModifiers('from:"" x')).toEqual({ text: 'x' });
  });

  it('keeps the last of a repeated modifier', () => {
    expect(parseSearchModifiers('from:a from:b')).toEqual({ text: '', from: 'b' });
  });
});

describe('withoutModifier', () => {
  it('drops one kind of modifier and keeps the rest as typed', () => {
    expect(withoutModifier('datadog from:"Günter Weber" in:~ops', 'from')).toBe('datadog in:~ops');
    expect(withoutModifier('datadog from:ada in:~ops', 'in')).toBe('datadog from:ada');
    expect(withoutModifier('datadog', 'from')).toBe('datadog');
  });
});

describe('foldName', () => {
  it('ignores case and accents', () => {
    expect(foldName(' Günter ')).toBe('gunter');
    expect(foldName('ÅSA')).toBe('asa');
  });
});

describe('resolveFromPerson', () => {
  const people = [
    { id: 'u-gw', displayName: 'Günter Weber', email: 'gw@example.com' },
    { id: 'u-gb', displayName: 'Günter Brandt', email: 'gunter.b@example.com' },
    { id: 'u-ada', displayName: 'Ada Lovelace', email: 'ada@example.com' },
    { id: 'u-bot', displayName: 'Deploy bot' },
  ];
  const who = (v: string) => resolveFromPerson(v, people)?.id;

  it('matches an email, then its part before the @, then the full name', () => {
    expect(who('gw@example.com')).toBe('u-gw');
    expect(who('@gunter.b')).toBe('u-gb');
    expect(who('Gunter Weber')).toBe('u-gw');
  });

  it('then a first name (the first by name when several share it), then the start of a name', () => {
    expect(who('günter')).toBe('u-gb');
    expect(who('Lov')).toBeUndefined();
    expect(who('ad')).toBe('u-ada');
    expect(who('deploy')).toBe('u-bot');
  });

  it('matches no one for nothing or a stranger', () => {
    expect(who('@')).toBeUndefined();
    expect(who('zed')).toBeUndefined();
  });
});

describe('resolveInPlace', () => {
  const places = [
    { id: 'c-ops', name: 'ops' },
    { id: 'c-ops-alerts', name: 'ops-alerts' },
    { id: 'd-1', name: 'Ada Lovelace' },
  ];
  it('matches a channel with or without ~, then a DM by name, then the start of a name', () => {
    expect(resolveInPlace('~ops', places)?.id).toBe('c-ops');
    expect(resolveInPlace('ops-alerts', places)?.id).toBe('c-ops-alerts');
    expect(resolveInPlace('ada lovelace', places)?.id).toBe('d-1');
    expect(resolveInPlace('ops-al', places)?.id).toBe('c-ops-alerts');
    expect(resolveInPlace('~', places)).toBeUndefined();
    expect(resolveInPlace('nowhere', places)).toBeUndefined();
  });
});

describe('date modifiers', () => {
  // A fixed "now", local time: Monday 23 November 2026, 15:00.
  const now = new Date(2026, 10, 23, 15, 0);
  const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);

  it('are parsed like the others', () => {
    expect(parseSearchModifiers('deploy on:today before:2026-11-20 after:"2026-11-01"')).toEqual({
      text: 'deploy',
      on: 'today',
      before: '2026-11-20',
      after: '2026-11-01',
    });
    expect(withoutModifier('deploy on:today from:ada', 'on')).toBe('deploy from:ada');
  });

  it('name a day by date, today or yesterday, at local midnight', () => {
    expect(resolveDay('2026-11-05', now)).toEqual(day(2026, 11, 5));
    expect(resolveDay('2026-1-5', now)).toEqual(day(2026, 1, 5));
    expect(resolveDay(' Today ', now)).toEqual(day(2026, 11, 23));
    expect(resolveDay('yesterday', now)).toEqual(day(2026, 11, 22));
    // Defaults to the real now.
    expect(resolveDay('today')).toEqual(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()));
  });

  it('are no day when not a real one', () => {
    for (const v of ['2026-02-30', '2026-13-01', 'tomorow', '20261105', '']) expect(resolveDay(v, now)).toBeUndefined();
  });

  it('read as Mattermost does: on: the day, after: from the next day, before: up to the day', () => {
    expect(dateRange({ on: '2026-11-05' }, now)).toEqual({ after: day(2026, 11, 5), before: day(2026, 11, 6) });
    expect(dateRange({ after: '2026-11-05' }, now)).toEqual({ after: day(2026, 11, 6) });
    expect(dateRange({ before: '2026-11-05' }, now)).toEqual({ before: day(2026, 11, 5) });
    expect(dateRange({}, now)).toEqual({});
  });

  it('narrow each other, and name the first that is no day', () => {
    expect(dateRange({ on: '2026-11-05', after: '2026-11-01', before: '2026-11-30' }, now)).toEqual({
      after: day(2026, 11, 5),
      before: day(2026, 11, 6),
    });
    expect(dateRange({ after: '2026-11-08', before: '2026-11-03' }, now)).toEqual({ after: day(2026, 11, 9), before: day(2026, 11, 3) });
    expect(dateRange({ on: 'someday', before: 'never' }, now)).toEqual({ invalid: 'on:someday' });
    expect(dateRange({ before: '2026-11-05' }).before).toEqual(day(2026, 11, 5));
  });

  it('say why a modifier found nothing', () => {
    expect(unmatchedNote('on:someday')).toBe("“on:someday” isn't a day. Use a date like 2026-11-20, today or yesterday.");
    expect(unmatchedNote('from:zed')).toBe('Nothing matches “from:zed”.');
  });
});
