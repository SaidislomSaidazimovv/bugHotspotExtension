// Round-trip tests for ChurnMap serialization (pure layer). The point of these
// helpers is that a raw Map does NOT survive JSON — so the tests assert the
// full JSON.stringify → parse → deserialize path, the way ADR-7 caching uses it.

import { describe, it, expect } from 'vitest';

import {
  serializeChurn,
  deserializeChurn,
  CHURN_SERDE_VERSION,
  type SerializedChurnMap,
} from '../../core/churnSerde';
import type { ChurnMap, FileChurn } from '../../core/types';

function sampleMap(): ChurnMap {
  const files: FileChurn[] = [
    {
      path: 'src/core/gitReader.ts',
      commits: 2,
      bugfixCommits: 1,
      linesAdded: 13,
      linesDeleted: 3,
      authors: ['Alice Smith', 'Bob Jones'],
      firstSeen: '2026-06-20T14:00:00+09:00',
      lastSeen: '2026-06-20T10:00:00+00:00',
    },
    {
      path: 'README.md',
      commits: 1,
      bugfixCommits: 1,
      linesAdded: 7,
      linesDeleted: 0,
      authors: ['Carol Lee'],
      firstSeen: '2026-06-01T12:00:00+00:00',
      lastSeen: '2026-06-01T12:00:00+00:00',
    },
  ];
  return new Map(files.map((f) => [f.path, f]));
}

describe('serializeChurn / deserializeChurn', () => {
  it('demonstrates why these helpers exist: JSON.stringify(Map) loses everything', () => {
    expect(JSON.stringify(sampleMap())).toBe('{}');
  });

  it('round-trips a ChurnMap through JSON without loss', () => {
    const original = sampleMap();
    const wire = JSON.parse(JSON.stringify(serializeChurn(original))) as SerializedChurnMap;
    const restored = deserializeChurn(wire);
    expect(restored).toEqual(original);
    // Explicitly guard the S2-D bugfixCommits field survives the JSON round-trip.
    expect(restored.get('src/core/gitReader.ts')?.bugfixCommits).toBe(1);
  });

  it('stamps the schema version on the serialized form', () => {
    expect(serializeChurn(sampleMap()).version).toBe(CHURN_SERDE_VERSION);
  });

  it('round-trips an empty map', () => {
    expect(deserializeChurn(serializeChurn(new Map()))).toEqual(new Map());
  });

  it('degrades to an empty map on undefined / version-mismatch / malformed input', () => {
    expect(deserializeChurn(undefined)).toEqual(new Map());
    expect(deserializeChurn(null)).toEqual(new Map());
    expect(
      deserializeChurn({ version: 99, files: [] } as unknown as SerializedChurnMap),
    ).toEqual(new Map());
    expect(
      deserializeChurn({ version: CHURN_SERDE_VERSION } as unknown as SerializedChurnMap),
    ).toEqual(new Map());
  });

  it('skips malformed file entries without a string path', () => {
    const wire = {
      version: CHURN_SERDE_VERSION,
      files: [{ nope: true }, { path: 'ok.ts', commits: 1 }],
    } as unknown as SerializedChurnMap;
    const restored = deserializeChurn(wire);
    expect([...restored.keys()]).toEqual(['ok.ts']);
  });
});
