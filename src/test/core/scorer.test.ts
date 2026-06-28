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
  /** Raw time-decay recency weight (FileChurn.recencyWeight); default 0. */
  recency?: number;
  /** Commits inside the recency window (FileChurn.recentCommits); default 0. */
  recentCommits?: number;
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
      recencyWeight: s.recency ?? 0,
      recentCommits: s.recentCommits ?? 0,
    } as FileChurn;
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

describe('computeRisk — trend edge cases', () => {
  it('classifies a zero-commit (malformed/empty) file as stable, not cooling', () => {
    const churn = churnMap([{ path: 'z.ts', commits: 0, added: 0, deleted: 0, authors: 0 }]);
    const { byPath } = run(churn, new Map());
    // commits=0 → ratio 0 would hit the cooling rule (≤0.1); the guard makes it stable.
    expect(byPath.get('z.ts')?.trend).toBe('stable');
  });
});

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
      recency: 0, // no recencyWeight on the helper-built churn → reported as 0
      authors: 4,
      ownership: 0, // no ownership map supplied → fragmentation reported as 0
      coupling: 0, // no coupling map supplied → strength reported as 0
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
  // To hit score 100 under the 6-term model (weights sum to 1.0), the top file
  // must max ALL SIX additive terms — so ownership + coupling maps are supplied
  // alongside the freq/churn/recency/authors/complexity spread (recency comes
  // from FileChurn.recencyWeight). Drive thresholds around that known score to
  // exercise every boundary.
  const churn = churnMap([
    { path: 'top.ts', commits: 50, added: 900, deleted: 500, authors: 6, recency: 50 },
    { path: 'bottom.ts', commits: 1, added: 1, deleted: 0, authors: 1, recency: 0 },
  ]);
  const cxm = complexityMap({ 'top.ts': 900, 'bottom.ts': 1 });
  const maxed: ScoreOptions = {
    ownership: new Map([['top.ts', 0.9], ['bottom.ts', 0]]),
    coupling: new Map([['top.ts', 0.9], ['bottom.ts', 0]]),
  };

  it('defaults: max file is critical (100), min file is low (0)', () => {
    const { byPath } = run(churn, cxm, maxed);
    expect(byPath.get('top.ts')!.score).toBe(100);
    expect(byPath.get('top.ts')!.tier).toBe('critical');
    expect(byPath.get('bottom.ts')!.score).toBe(0);
    expect(byPath.get('bottom.ts')!.tier).toBe('low');
  });

  it('classifies a score=100 file by configurable thresholds (high boundary inclusive of critical)', () => {
    const top = (opts: ScoreOptions) =>
      run(churn, cxm, { ...maxed, ...opts }).byPath.get('top.ts')!.tier;
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

describe('computeRisk — ownership signal (S4-A/B1: own additive term)', () => {
  // Two files identical in freq / churn / authors / complexity (all normalize to
  // 0), so the ownership term is the ONLY discriminator. Since S4-B1 ownership is
  // its OWN additive term (no longer borrowing the author slot), higher
  // fragmentation alone should raise the score.
  const churn = churnMap([
    { path: 'concentrated.ts', commits: 10, added: 100, deleted: 50, authors: 3 },
    { path: 'fragmented.ts', commits: 10, added: 100, deleted: 50, authors: 3 },
  ]);
  const cxm = complexityMap({ 'concentrated.ts': 100, 'fragmented.ts': 100 });

  it('contributes nothing (signals.ownership 0) when no ownership map is supplied', () => {
    const { byPath } = run(churn, cxm);
    expect(byPath.get('concentrated.ts')!.signals.ownership).toBe(0);
    // identical files ⇒ all terms 0 ⇒ tie broken by path.
    expect(run(churn, cxm).results.map((r) => r.path)).toEqual([
      'concentrated.ts',
      'fragmented.ts',
    ]);
  });

  it('raises the more fragmented file when ownership is the only differing signal', () => {
    const { results } = run(churn, cxm, {
      ownership: new Map([
        ['concentrated.ts', 0.1],
        ['fragmented.ts', 0.7],
      ]),
    });
    expect(results[0].path).toBe('fragmented.ts');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('surfaces the fragmentation value in signals.ownership (count still reported)', () => {
    const { byPath } = run(churn, cxm, {
      ownership: new Map([['concentrated.ts', 0.1], ['fragmented.ts', 0.7]]),
    });
    expect(byPath.get('fragmented.ts')!.signals.ownership).toBe(0.7);
    expect(byPath.get('concentrated.ts')!.signals.ownership).toBe(0.1);
    expect(byPath.get('concentrated.ts')!.signals.authors).toBe(3);
  });

  it('treats a missing ownership entry as 0 fragmentation', () => {
    const { byPath } = run(churn, cxm, { ownership: new Map([['fragmented.ts', 0.7]]) });
    expect(byPath.get('concentrated.ts')!.signals.ownership).toBe(0);
  });
});

describe('computeRisk — change-coupling signal (S4-B1)', () => {
  // Identical files except for the coupling signal → it is the only discriminator.
  const churn = churnMap([
    { path: 'lonely.ts', commits: 10, added: 100, deleted: 50, authors: 3 },
    { path: 'coupled.ts', commits: 10, added: 100, deleted: 50, authors: 3 },
  ]);
  const cxm = complexityMap({ 'lonely.ts': 100, 'coupled.ts': 100 });

  it('contributes nothing (signals.coupling 0) when no coupling map is supplied', () => {
    const { byPath } = run(churn, cxm);
    expect(byPath.get('coupled.ts')!.signals.coupling).toBe(0);
  });

  it('raises a strongly-coupled file above an uncoupled one', () => {
    const { results, byPath } = run(churn, cxm, {
      coupling: new Map([['coupled.ts', 0.8], ['lonely.ts', 0]]),
    });
    expect(results[0].path).toBe('coupled.ts');
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(byPath.get('coupled.ts')!.signals.coupling).toBe(0.8);
  });

  it('treats a missing coupling entry as 0', () => {
    const { byPath } = run(churn, cxm, { coupling: new Map([['coupled.ts', 0.8]]) });
    expect(byPath.get('lonely.ts')!.signals.coupling).toBe(0);
  });

  it('adds ownership and coupling as independent terms', () => {
    // One file wins on ownership, the other on coupling; both > the term weight 0.
    const { byPath } = run(churn, cxm, {
      ownership: new Map([['lonely.ts', 0.9], ['coupled.ts', 0]]),
      coupling: new Map([['lonely.ts', 0], ['coupled.ts', 0.9]]),
    });
    // Symmetric contributions ⇒ equal scores ⇒ deterministic path-order tie-break.
    expect(byPath.get('lonely.ts')!.score).toBe(byPath.get('coupled.ts')!.score);
  });
});

describe('computeRisk — recency signal (S7-B1)', () => {
  // Identical files except for the recency weight → it is the only discriminator.
  const churn = churnMap([
    { path: 'stale.ts', commits: 10, added: 100, deleted: 50, authors: 3, recency: 0.5 },
    { path: 'fresh.ts', commits: 10, added: 100, deleted: 50, authors: 3, recency: 10 },
  ]);
  const cxm = complexityMap({ 'stale.ts': 100, 'fresh.ts': 100 });

  it('raises the more recently-changed file above a stale one', () => {
    const { results } = run(churn, cxm);
    expect(results[0].path).toBe('fresh.ts');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('surfaces the raw recency weight in signals.recency', () => {
    const { byPath } = run(churn, cxm);
    expect(byPath.get('fresh.ts')!.signals.recency).toBe(10);
    expect(byPath.get('stale.ts')!.signals.recency).toBe(0.5);
  });

  it('treats a missing recencyWeight as 0 (forward-compat, no throw)', () => {
    // Simulate a pre-S7-B1 / hand-built FileChurn with no recency fields.
    const legacy: ChurnMap = new Map([
      ['a.ts', { path: 'a.ts', commits: 5, bugfixCommits: 0, linesAdded: 10, linesDeleted: 2, authors: ['x'], authorCommits: [{ name: 'x', commits: 5 }], firstSeen: '', lastSeen: '' } as unknown as FileChurn],
      ['b.ts', { path: 'b.ts', commits: 2, bugfixCommits: 0, linesAdded: 3, linesDeleted: 1, authors: ['y'], authorCommits: [{ name: 'y', commits: 2 }], firstSeen: '', lastSeen: '' } as unknown as FileChurn],
    ]);
    const { byPath } = run(legacy, complexityMap({ 'a.ts': 50, 'b.ts': 10 }));
    expect(byPath.get('a.ts')!.signals.recency).toBe(0);
    expect(byPath.get('a.ts')!.trend).toBe('cooling'); // recentCommits ?? 0 → ratio 0
  });
});

describe('computeRisk — trend classification (S7-B1, display-only)', () => {
  const cxm = complexityMap({});

  function trendOf(commits: number, recentCommits: number): string {
    const churn = churnMap([{ path: 'f.ts', commits, added: 1, deleted: 0, authors: 1, recentCommits }]);
    return run(churn, cxm).byPath.get('f.ts')!.trend;
  }

  it('classifies a majority-recent, well-exercised file as rising', () => {
    expect(trendOf(4, 3)).toBe('rising'); // 3/4 = 0.75 ≥ 0.5, commits ≥ 3
    expect(trendOf(3, 3)).toBe('rising'); // 3/3 = 1.0
  });

  it('does NOT call a majority-recent file rising without ≥3 commits', () => {
    expect(trendOf(2, 2)).toBe('stable'); // ratio 1.0 but only 2 commits
  });

  it('classifies a near-dormant file as cooling', () => {
    expect(trendOf(20, 2)).toBe('cooling'); // 2/20 = 0.1 ≤ 0.1
    expect(trendOf(10, 0)).toBe('cooling'); // 0/10 = 0
  });

  it('classifies an in-between file as stable', () => {
    expect(trendOf(10, 3)).toBe('stable'); // 0.3 — between 0.1 and 0.5
  });

  it('is display-only: trend does not change the score', () => {
    // Two files identical in every SCORED signal but differing recentCommits.
    const churn = churnMap([
      { path: 'p.ts', commits: 10, added: 100, deleted: 50, authors: 3, recency: 5, recentCommits: 9 },
      { path: 'q.ts', commits: 10, added: 100, deleted: 50, authors: 3, recency: 5, recentCommits: 0 },
    ]);
    const cx = complexityMap({ 'p.ts': 100, 'q.ts': 100 });
    const { byPath } = run(churn, cx);
    expect(byPath.get('p.ts')!.score).toBe(byPath.get('q.ts')!.score);
    expect(byPath.get('p.ts')!.trend).toBe('rising');
    expect(byPath.get('q.ts')!.trend).toBe('cooling');
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
