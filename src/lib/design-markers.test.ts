import { describe, it, expect } from 'vitest';
import { appendDesignNote, hasDesignMarkers, LEARNED_HEADING, noteSaved, parseDesignMarkers } from './design-markers';

describe('design markers', () => {
  it('spots marker messages cheaply', () => {
    expect(hasDesignMarkers('v1 — header\n<!-- ex:before acme/ABC -->')).toBe(true);
    expect(hasDesignMarkers('plain text')).toBe(false);
    expect(hasDesignMarkers('<!-- a normal comment -->')).toBe(false);
  });

  it('parses the compare target and design-note suggestions', () => {
    const body = [
      'v2 — tiles',
      '<!-- ex:before cliffhub/att:01ABC -->',
      '<!-- ex:design-note cliffhub | Corner radius is 4px,\n  never 8px -->',
      '<!-- ex:design-note cliffhub |   -->',
      '<!-- ex:design-note other-app | Tables are the default list view -->',
    ].join('\n');
    expect(parseDesignMarkers(body)).toEqual({
      before: { project: 'cliffhub', attachmentID: '01ABC' },
      notes: [
        { project: 'cliffhub', text: 'Corner radius is 4px, never 8px' },
        { project: 'other-app', text: 'Tables are the default list view' },
      ],
    });
    expect(parseDesignMarkers('<!-- ex:before Bad/x -->')).toEqual({ before: null, notes: [] });
  });

  it('appends learned rules under one heading', () => {
    expect(appendDesignNote('', 'A')).toBe(`${LEARNED_HEADING}\n- A`);
    expect(appendDesignNote('Font: Inter\n\n', 'A')).toBe(`Font: Inter\n\n${LEARNED_HEADING}\n- A`);
    expect(appendDesignNote(`Font: Inter\n\n${LEARNED_HEADING}\n- A\n`, 'B')).toBe(`Font: Inter\n\n${LEARNED_HEADING}\n- A\n- B`);
  });

  it('knows when a rule is already in the notes', () => {
    expect(noteSaved('x\n- corner radius is 4px', 'Corner radius is 4px')).toBe(true);
    expect(noteSaved('x', 'Corner radius is 4px')).toBe(false);
    expect(noteSaved(undefined, 'y')).toBe(false);
  });
});
