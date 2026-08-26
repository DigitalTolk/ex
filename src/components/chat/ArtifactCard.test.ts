import { describe, expect, it } from 'vitest';

import { parseArtifactMarker } from '@/lib/artifact-marker';

describe('parseArtifactMarker', () => {
  it('parses a well-formed marker', () => {
    const m = parseArtifactMarker('[artifact:01KZRUN:01KZART|My Design Doc|markdown|3584]');
    expect(m).toEqual({
      runID: '01KZRUN',
      artifactID: '01KZART',
      title: 'My Design Doc',
      kind: 'markdown',
      bytes: 3584,
    });
  });

  it('rejects ordinary prose and partial markers', () => {
    expect(parseArtifactMarker('hello world')).toBeNull();
    expect(parseArtifactMarker('[artifact:x:y|title]')).toBeNull();
    expect(parseArtifactMarker('prefix [artifact:a:b|t|k|1] suffix')).toBeNull();
  });

  it('defaults empty title/kind', () => {
    const m = parseArtifactMarker('[artifact:A1:B2| ||12]');
    expect(m?.title).toBe('Untitled artifact');
    expect(m?.kind).toBe('text');
  });
});
