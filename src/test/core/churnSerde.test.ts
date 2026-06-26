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
      authorCommits: [
        { name: 'Alice Smith', commits: 1 },
        { name: 'Bob Jones', commits: 1 },
      ],
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
      authorCommits: [{ name: 'Carol Lee', commits: 1 }],
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
    // S4-A: per-author commit counts survive the round-trip too.
    expect(restored.get('src/core/gitReader.ts')?.authorCommits).toEqual([
      { name: 'Alice Smith', commits: 1 },
      { name: 'Bob Jones', commits: 1 },
    ]);
  });

  it('stamps schema version 2 (S4-A authorCommits bump)', () => {
    expect(CHURN_SERDE_VERSION).toBe(2);
    expect(serializeChurn(sampleMap()).version).toBe(2);
  });

  it('cache-busts a v1 entry (no authorCommits) to an empty map → cold scan', () => {
    const v1 = {
      version: 1,
      files: [
        {
          path: 'old.ts',
          commits: 3,
          bugfixCommits: 0,
          linesAdded: 9,
          linesDeleted: 1,
          authors: ['Alice'],
          firstSeen: '2026-01-01T00:00:00+00:00',
          lastSeen: '2026-01-02T00:00:00+00:00',
        },
      ],
    } as unknown as SerializedChurnMap;
    expect(deserializeChurn(v1)).toEqual(new Map());
  });

  it('defaults a missing authorCommits to [] on deserialize (defensive)', () => {
    const wire = {
      version: CHURN_SERDE_VERSION,
      files: [{ path: 'x.ts', commits: 1, authors: ['A'] }],
    } as unknown as SerializedChurnMap;
    const restored = deserializeChurn(wire);
    expect(restored.get('x.ts')?.authorCommits).toEqual([]);
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
