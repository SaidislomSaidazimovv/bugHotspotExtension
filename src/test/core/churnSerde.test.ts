// Round-trip tests for the churn cache serde (pure layer). A raw Map does NOT
// survive JSON, so these assert the full JSON.stringify → parse → deserialize
// path the way ADR-7 caching uses it. As of S4-B1 the cache holds BOTH the
// ChurnMap and the change-coupling co-change counts (serde v3).

import { describe, it, expect } from 'vitest';

import {
  serializeChurn,
  deserializeChurn,
  CHURN_SERDE_VERSION,
  type SerializedChurnMap,
} from '../../core/churnSerde';
import { coChangeKey } from '../../core/types';
import type { ChurnMap, CoChangeCount, FileChurn } from '../../core/types';

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
      recencyWeight: 1.5,
      recentCommits: 2,
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
      recencyWeight: 0.5,
      recentCommits: 0,
    },
  ];
  return new Map(files.map((f) => [f.path, f]));
}

function sampleCoChange(): CoChangeCount {
  return new Map([
    [coChangeKey('src/core/gitReader.ts', 'README.md'), 6],
    [coChangeKey('src/core/gitReader.ts', 'src/core/types.ts'), 9],
  ]);
}

/** Simulate the real cache path: serialize → JSON → parse → deserialize. */
function roundTrip(churn: ChurnMap, coChange: CoChangeCount) {
  const wire = JSON.parse(JSON.stringify(serializeChurn(churn, coChange))) as SerializedChurnMap;
  return deserializeChurn(wire);
}

describe('serializeChurn / deserializeChurn', () => {
  it('demonstrates why these helpers exist: JSON.stringify(Map) loses everything', () => {
    expect(JSON.stringify(sampleMap())).toBe('{}');
  });

  it('round-trips churn + co-change through JSON without loss', () => {
    const churn = sampleMap();
    const coChange = sampleCoChange();
    const restored = roundTrip(churn, coChange);

    expect(restored.churn).toEqual(churn);
    expect(restored.coChange).toEqual(coChange);
    // Guard the S2-D / S4-A fields survive the JSON round-trip.
    expect(restored.churn.get('src/core/gitReader.ts')?.bugfixCommits).toBe(1);
    expect(restored.churn.get('src/core/gitReader.ts')?.authorCommits).toEqual([
      { name: 'Alice Smith', commits: 1 },
      { name: 'Bob Jones', commits: 1 },
    ]);
    // S4-B1: co-change counts survive (NUL-separated keys included).
    expect(restored.coChange.get(coChangeKey('src/core/gitReader.ts', 'src/core/types.ts'))).toBe(9);
    // S7-B1: recency fields survive the JSON round-trip.
    expect(restored.churn.get('src/core/gitReader.ts')?.recencyWeight).toBe(1.5);
    expect(restored.churn.get('src/core/gitReader.ts')?.recentCommits).toBe(2);
  });

  it('stamps schema version 4 (S7-B1 recency bump)', () => {
    expect(CHURN_SERDE_VERSION).toBe(4);
    expect(serializeChurn(sampleMap(), sampleCoChange()).version).toBe(4);
  });

  it('cache-busts a v3 entry (no recency fields) to empty maps → cold scan', () => {
    const v3 = {
      version: 3,
      files: [
        {
          path: 'old.ts',
          commits: 3,
          bugfixCommits: 0,
          linesAdded: 9,
          linesDeleted: 1,
          authors: ['Alice'],
          authorCommits: [{ name: 'Alice', commits: 3 }],
          firstSeen: '2026-01-01T00:00:00+00:00',
          lastSeen: '2026-01-02T00:00:00+00:00',
        },
      ],
      coChange: [],
    } as unknown as SerializedChurnMap;
    const { churn, coChange } = deserializeChurn(v3);
    expect(churn.size).toBe(0);
    expect(coChange.size).toBe(0);
  });

  it('defaults missing recency fields to 0 on a same-version malformed row', () => {
    const wire = {
      version: CHURN_SERDE_VERSION,
      files: [{ path: 'x.ts', commits: 1, authors: ['A'], authorCommits: [{ name: 'A', commits: 1 }] }],
      coChange: [],
    } as unknown as SerializedChurnMap;
    const fc = deserializeChurn(wire).churn.get('x.ts');
    expect(fc?.recencyWeight).toBe(0);
    expect(fc?.recentCommits).toBe(0);
  });

  it('defaults a missing authorCommits to [] on deserialize (defensive)', () => {
    const wire = {
      version: CHURN_SERDE_VERSION,
      files: [{ path: 'x.ts', commits: 1, authors: ['A'] }],
      coChange: [],
    } as unknown as SerializedChurnMap;
    expect(deserializeChurn(wire).churn.get('x.ts')?.authorCommits).toEqual([]);
  });

  it('tolerates a missing / malformed coChange array', () => {
    const noCoChange = {
      version: CHURN_SERDE_VERSION,
      files: [{ path: 'x.ts', commits: 1, authors: [], authorCommits: [] }],
    } as unknown as SerializedChurnMap;
    expect(deserializeChurn(noCoChange).coChange).toEqual(new Map());

    const badEntries = {
      version: CHURN_SERDE_VERSION,
      files: [],
      coChange: [['ok', 5], ['missingCount'], [42, 7], ['x', 'notNumber']],
    } as unknown as SerializedChurnMap;
    expect([...deserializeChurn(badEntries).coChange.entries()]).toEqual([['ok', 5]]);
  });

  it('round-trips empty maps', () => {
    const { churn, coChange } = roundTrip(new Map(), new Map());
    expect(churn).toEqual(new Map());
    expect(coChange).toEqual(new Map());
  });

  it('degrades to empty maps on undefined / version-mismatch / malformed input', () => {
    const empty = { churn: new Map(), coChange: new Map() };
    expect(deserializeChurn(undefined)).toEqual(empty);
    expect(deserializeChurn(null)).toEqual(empty);
    expect(
      deserializeChurn({ version: 99, files: [], coChange: [] } as unknown as SerializedChurnMap),
    ).toEqual(empty);
    expect(
      deserializeChurn({ version: CHURN_SERDE_VERSION } as unknown as SerializedChurnMap),
    ).toEqual(empty);
  });

  it('skips malformed file entries without a string path', () => {
    const wire = {
      version: CHURN_SERDE_VERSION,
      files: [{ nope: true }, { path: 'ok.ts', commits: 1 }],
      coChange: [],
    } as unknown as SerializedChurnMap;
    expect([...deserializeChurn(wire).churn.keys()]).toEqual(['ok.ts']);
  });
});
