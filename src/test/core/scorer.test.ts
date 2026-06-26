// Unit tests for the pure risk scorer. Synthetic ChurnMap + ComplexityResult
// maps only — no git, no vscode. Runner: Vitest (`npm run unit`).

import { describe, it, expect } from 'vitest';

import { computeRisk, type ScoreOptions } from '../../core/scorer';
import type { ChurnMap, FileChurn } from '../../core/types';
import type { ComplexityResult } from '../../core/complexity';

interface ChurnSpec {
  path: string;
  commits: number;
  added: number;
  deleted: number;
  authors: number;
}

function churnMap(specs: ChurnSpec[]): ChurnMap {
  const map: ChurnMap = new Map();
  for (const s of specs) {
    const fc: FileChurn = {
      path: s.path,
      commits: s.commits,
      linesAdded: s.added,
      linesDeleted: s.deleted,
      authors: Array.from({ length: s.authors }, (_, i) => `dev${i}`),
      firstSeen: '2026-01-01T00:00:00+00:00',
      lastSeen: '2026-01-02T00:00:00+00:00',
    };
    map.set(s.path, fc);
  }
  return map;
}

function cx(total: number): ComplexityResult {
  return { total, mean: 0, max: 0, lines: 0 };
}

function complexityMap(entries: Record<string, number>): Map<string, ComplexityResult> {
  return new Map(Object.entries(entries).map(([p, t]) => [p, cx(t)]));
}

function run(churn: ChurnMap, cxm: Map<string, ComplexityResult>, opts?: ScoreOptions) {
  const results = computeRisk(churn, cxm, opts);
  const byPath = new Map(results.map((r) => [r.path, r]));
  return { results, byPath };
}

describe('computeRisk — ranking', () => {
  it('ranks a frequently-changed, complex file above a quiet, simple one', () => {
    const churn = churnMap([
      { path: 'hot.ts', commits: 50, added: 800, deleted: 400, authors: 6 },
      { path: 'cold.ts', commits: 1, added: 5, deleted: 0, authors: 1 },
    ]);
    const cxm = complexityMap({ 'hot.ts': 900, 'cold.ts': 10 });
    const { results } = run(churn, cxm);

    expect(results.map((r) => r.path)).toEqual(['hot.ts', 'cold.ts']);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('returns results sorted descending by score', () => {
    const churn = churnMap([
      { path: 'a.ts', commits: 5, added: 50, deleted: 10, authors: 2 },
      { path: 'b.ts', commits: 40, added: 600, deleted: 300, authors: 5 },
      { path: 'c.ts', commits: 20, added: 200, deleted: 100, authors: 3 },
    ]);
    const cxm = complexityMap({ 'a.ts': 30, 'b.ts': 700, 'c.ts': 250 });
    const { results } = run(churn, cxm);

    const scores = results.map((r) => r.score);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
    expect(results[0].path).toBe('b.ts');
  });

  it('breaks score ties by path for deterministic ordering', () => {
    // Identical signals → all normalize to 0 → all score 0 → tie on path.
    const churn = churnMap([
      { path: 'z.ts', commits: 3, added: 9, deleted: 1, authors: 2 },
      { path: 'a.ts', commits: 3, added: 9, deleted: 1, authors: 2 },
      { path: 'm.ts', commits: 3, added: 9, deleted: 1, authors: 2 },
    ]);
    const cxm = complexityMap({ 'z.ts': 5, 'a.ts': 5, 'm.ts': 5 });
    const { results } = run(churn, cxm);
    expect(results.map((r) => r.path)).toEqual(['a.ts', 'm.ts', 'z.ts']);
  });
});

describe('computeRisk — raw signals', () => {
  it('reports raw (pre-normalization) signal values', () => {
    const churn = churnMap([
      { path: 'x.ts', commits: 7, added: 120, deleted: 30, authors: 4 },
      { path: 'y.ts', commits: 1, added: 0, deleted: 0, authors: 1 },
    ]);
    const cxm = complexityMap({ 'x.ts': 333 });
    const { byPath } = run(churn, cxm);

    expect(byPath.get('x.ts')!.signals).toEqual({
      freq: 7,
      churn: 150, // 120 + 30
      authors: 4,
      ownership: 0, // no ownership map supplied → fragmentation reported as 0
      complexity: 333,
    });
  });
});

describe('computeRisk — edge cases', () => {
  it('returns [] for an empty churn map', () => {
    expect(computeRisk(new Map(), new Map())).toEqual([]);
  });

  it('scores a single file 0 (no discriminating signal) → low tier', () => {
    const churn = churnMap([{ path: 'solo.ts', commits: 99, added: 999, deleted: 999, authors: 9 }]);
    const cxm = complexityMap({ 'solo.ts': 9999 });
    const { results } = run(churn, cxm);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(0);
    expect(results[0].tier).toBe('low');
    // raw signals are still reported faithfully
    expect(results[0].signals.freq).toBe(99);
  });

  it('scores every file 0 when all signals are equal', () => {
    const churn = churnMap([
      { path: 'a.ts', commits: 10, added: 100, deleted: 50, authors: 3 },
      { path: 'b.ts', commits: 10, added: 100, deleted: 50, authors: 3 },
    ]);
    const cxm = complexityMap({ 'a.ts': 200, 'b.ts': 200 });
    const { results } = run(churn, cxm);
    expect(results.every((r) => r.score === 0 && r.tier === 'low')).toBe(true);
  });

  it('falls back to complexity 0 when a file has no complexity entry', () => {
    const churn = churnMap([
      { path: 'has.ts', commits: 30, added: 400, deleted: 200, authors: 4 },
      { path: 'missing.ts', commits: 5, added: 40, deleted: 10, authors: 2 },
    ]);
    const cxm = complexityMap({ 'has.ts': 500 }); // missing.ts absent on purpose
    const { byPath } = run(churn, cxm);
    expect(byPath.get('missing.ts')!.signals.complexity).toBe(0);
    expect(byPath.has('missing.ts')).toBe(true);
  });
});

describe('computeRisk — tiers', () => {
  // The top file in a 2-file set maxes every normalized signal → score 100.
  // Drive thresholds around that known score to exercise every boundary.
  const churn = churnMap([
    { path: 'top.ts', commits: 50, added: 900, deleted: 500, authors: 6 },
    { path: 'bottom.ts', commits: 1, added: 1, deleted: 0, authors: 1 },
  ]);
  const cxm = complexityMap({ 'top.ts': 900, 'bottom.ts': 1 });

  it('defaults: max file is critical, min file is low', () => {
    const { byPath } = run(churn, cxm);
    expect(byPath.get('top.ts')!.score).toBe(100);
    expect(byPath.get('top.ts')!.tier).toBe('critical');
    expect(byPath.get('bottom.ts')!.score).toBe(0);
    expect(byPath.get('bottom.ts')!.tier).toBe('low');
  });

  it('classifies a score=100 file by configurable thresholds (high boundary inclusive of critical)', () => {
    const top = (opts: ScoreOptions) => run(churn, cxm, opts).byPath.get('top.ts')!.tier;
    expect(top({ thresholds: { medium: 25, high: 50, critical: 75 } })).toBe('critical');
    expect(top({ thresholds: { medium: 25, high: 50, critical: 101 } })).toBe('high');
    expect(top({ thresholds: { medium: 25, high: 101, critical: 102 } })).toBe('medium');
    expect(top({ thresholds: { medium: 101, high: 102, critical: 103 } })).toBe('low');
  });
});

describe('computeRisk — bugfixDensity hook (forward-compat)', () => {
  // A 3-file spread so the middle file has 0 < normalized signals < 1, leaving
  // headroom for the (1 + density) multiplier to raise its score.
  const churn = churnMap([
    { path: 'hi.ts', commits: 100, added: 2000, deleted: 1000, authors: 8 },
    { path: 'mid.ts', commits: 12, added: 150, deleted: 80, authors: 3 },
    { path: 'lo.ts', commits: 1, added: 2, deleted: 1, authors: 1 },
  ]);
  const cxm = complexityMap({ 'hi.ts': 2500, 'mid.ts': 200, 'lo.ts': 3 });

  it('defaults to multiplier 1 (no effect) when omitted', () => {
    const without = run(churn, cxm).byPath.get('mid.ts')!.score;
    const withZero = run(churn, cxm, {
      bugfixDensity: new Map([['mid.ts', 0]]),
    }).byPath.get('mid.ts')!.score;
    expect(withZero).toBe(without);
  });

  it('raises a file’s score when its bug-fix density is positive', () => {
    const without = run(churn, cxm).byPath.get('mid.ts')!.score;
    const boosted = run(churn, cxm, {
      bugfixDensity: new Map([['mid.ts', 1]]),
    }).byPath.get('mid.ts')!.score;
    expect(boosted).toBeGreaterThan(without);
    expect(boosted).toBeLessThanOrEqual(100);
  });
});

describe('computeRisk — ownership signal (S4-A)', () => {
  // Two files identical in freq / churn / complexity (those normalize to 0), so
  // the author weight slot is the ONLY discriminating term. By count, the
  // 5-author file outranks the 2-author file; by ownership fragmentation we can
  // flip that — proving fragmentation REPLACES the raw count in the slot.
  const churn = churnMap([
    { path: 'concentrated.ts', commits: 10, added: 100, deleted: 50, authors: 5 },
    { path: 'fragmented.ts', commits: 10, added: 100, deleted: 50, authors: 2 },
  ]);
  const cxm = complexityMap({ 'concentrated.ts': 100, 'fragmented.ts': 100 });

  it('ranks by distinct-author COUNT when no ownership map is supplied (fallback)', () => {
    const { results, byPath } = run(churn, cxm);
    expect(results[0].path).toBe('concentrated.ts'); // 5 authors > 2 by count
    expect(byPath.get('concentrated.ts')!.signals.ownership).toBe(0);
  });

  it('feeds fragmentation into the author slot, replacing the raw count', () => {
    // concentrated.ts has MORE authors but a dominant owner (low fragmentation);
    // fragmented.ts has fewer authors but weak ownership (high fragmentation).
    const { results } = run(churn, cxm, {
      ownership: new Map([
        ['concentrated.ts', 0.1],
        ['fragmented.ts', 0.7],
      ]),
    });
    expect(results[0].path).toBe('fragmented.ts'); // fragmentation now wins
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('surfaces the fragmentation value in signals.ownership', () => {
    const { byPath } = run(churn, cxm, {
      ownership: new Map([
        ['concentrated.ts', 0.1],
        ['fragmented.ts', 0.7],
      ]),
    });
    expect(byPath.get('fragmented.ts')!.signals.ownership).toBe(0.7);
    expect(byPath.get('concentrated.ts')!.signals.ownership).toBe(0.1);
    // raw distinct-author count is still reported alongside.
    expect(byPath.get('concentrated.ts')!.signals.authors).toBe(5);
  });

  it('treats a missing ownership entry as 0 fragmentation', () => {
    const { byPath } = run(churn, cxm, { ownership: new Map([['fragmented.ts', 0.7]]) });
    expect(byPath.get('concentrated.ts')!.signals.ownership).toBe(0);
  });
});

describe('computeRisk — custom weights', () => {
  it('honors overridden weights', () => {
    const churn = churnMap([
      { path: 'manyAuthors.ts', commits: 2, added: 10, deleted: 5, authors: 9 },
      { path: 'manyCommits.ts', commits: 40, added: 12, deleted: 6, authors: 1 },
    ]);
    const cxm = complexityMap({ 'manyAuthors.ts': 100, 'manyCommits.ts': 100 });

    // Author-dominant weighting should rank the many-authors file on top.
    const authorWeighted = computeRisk(churn, cxm, {
      weights: { freq: 0.1, churn: 0.1, authors: 0.8 },
    });
    expect(authorWeighted[0].path).toBe('manyAuthors.ts');

    // Frequency-dominant weighting flips the ranking.
    const freqWeighted = computeRisk(churn, cxm, {
      weights: { freq: 0.8, churn: 0.1, authors: 0.1 },
    });
    expect(freqWeighted[0].path).toBe('manyCommits.ts');
  });
});
