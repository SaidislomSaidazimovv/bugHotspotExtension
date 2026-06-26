// Unit tests for the pure change-coupling signal (S4-B1). Synthetic ChurnMap +
// CoChangeCount only — no git, no vscode. Runner: Vitest (`npm run unit`).
//
// Metric (RESEARCH §3.6): coupling(A,B) = sharedCommits / max(revs(A), revs(B)),
// filtered by a min-support threshold; per file we expose the strongest strength
// (the scorer signal) and the top-K ranked partners (the UI list).

import { describe, it, expect } from 'vitest';

import {
  buildCoupling,
  DEFAULT_MIN_SUPPORT,
  DEFAULT_TOP_K,
} from '../../core/coupling';
import { coChangeKey } from '../../core/types';
import type { ChurnMap, CoChangeCount, FileChurn } from '../../core/types';

/** Minimal FileChurn carrying just the `commits` (revs) the metric needs. */
function fc(path: string, commits: number): FileChurn {
  return {
    path,
    commits,
    bugfixCommits: 0,
    linesAdded: 0,
    linesDeleted: 0,
    authors: [],
    authorCommits: [],
    firstSeen: '2026-01-01T00:00:00+00:00',
    lastSeen: '2026-01-02T00:00:00+00:00',
  };
}

function churnOf(specs: Array<[string, number]>): ChurnMap {
  return new Map(specs.map(([p, c]) => [p, fc(p, c)]));
}

function coChangeOf(specs: Array<[string, string, number]>): CoChangeCount {
  return new Map(specs.map(([a, b, n]) => [coChangeKey(a, b), n]));
}

describe('buildCoupling', () => {
  it('computes strength = sharedCommits / max(revs) for a supported pair', () => {
    const churn = churnOf([['a.ts', 10], ['b.ts', 8]]);
    const coChange = coChangeOf([['a.ts', 'b.ts', 6]]);
    const { partners, signal } = buildCoupling(churn, coChange);

    expect(partners.get('a.ts')).toEqual([{ path: 'b.ts', strength: 0.6, sharedCommits: 6 }]);
    expect(partners.get('b.ts')).toEqual([{ path: 'a.ts', strength: 0.6, sharedCommits: 6 }]);
    expect(signal.get('a.ts')).toBe(0.6);
    expect(signal.get('b.ts')).toBe(0.6);
  });

  it('drops pairs below the min-support threshold (default 5)', () => {
    expect(DEFAULT_MIN_SUPPORT).toBe(5);
    const churn = churnOf([['a.ts', 10], ['b.ts', 10]]);
    const { partners, signal } = buildCoupling(churn, coChangeOf([['a.ts', 'b.ts', 4]]));
    expect(partners.size).toBe(0);
    expect(signal.size).toBe(0);
  });

  it('divides by max(revs), so riding along a big file yields LOW coupling', () => {
    // b is touched 100×; sharing 5 of a's commits is weak for b (5/100), even
    // though it is everything a ever did (5/5). max() reflects b, not a.
    const churn = churnOf([['a.ts', 5], ['big.ts', 100]]);
    const { signal } = buildCoupling(churn, coChangeOf([['a.ts', 'big.ts', 5]]));
    expect(signal.get('a.ts')).toBe(0.05);
    expect(signal.get('big.ts')).toBe(0.05);
  });

  it('keeps strength in [0, 1]', () => {
    const churn = churnOf([['a.ts', 7], ['b.ts', 7]]);
    const { signal } = buildCoupling(churn, coChangeOf([['a.ts', 'b.ts', 7]]));
    expect(signal.get('a.ts')).toBe(1); // 7/7, the maximum
  });

  it('reports the STRONGEST partner as the per-file signal and ranks partners desc', () => {
    const churn = churnOf([['hub.ts', 20], ['p1.ts', 10], ['p2.ts', 10], ['p3.ts', 10]]);
    const coChange = coChangeOf([
      ['hub.ts', 'p1.ts', 6], // 6/20 = 0.30
      ['hub.ts', 'p2.ts', 16], // 16/20 = 0.80  ← strongest
      ['hub.ts', 'p3.ts', 10], // 10/20 = 0.50
    ]);
    const { partners, signal } = buildCoupling(churn, coChange);
    expect(signal.get('hub.ts')).toBe(0.8);
    expect(partners.get('hub.ts')!.map((p) => p.path)).toEqual(['p2.ts', 'p3.ts', 'p1.ts']);
  });

  it('truncates each file to top-K partners but keeps the max as the signal', () => {
    expect(DEFAULT_TOP_K).toBe(5);
    const specs: Array<[string, number]> = [['hub.ts', 100]];
    const pairs: Array<[string, string, number]> = [];
    for (let i = 0; i < 8; i++) {
      specs.push([`p${i}.ts`, 100]);
      pairs.push(['hub.ts', `p${i}.ts`, 10 + i]); // strengths 0.10 … 0.17
    }
    const { partners, signal } = buildCoupling(churnOf(specs), coChangeOf(pairs));
    const hub = partners.get('hub.ts')!;
    expect(hub).toHaveLength(5); // top-K
    expect(hub[0]).toEqual({ path: 'p7.ts', strength: 0.17, sharedCommits: 17 });
    expect(signal.get('hub.ts')).toBe(0.17); // strongest survives truncation
  });

  it('honors configurable minSupport and topK', () => {
    const churn = churnOf([['a.ts', 10], ['b.ts', 10], ['c.ts', 10]]);
    const coChange = coChangeOf([['a.ts', 'b.ts', 3], ['a.ts', 'c.ts', 3]]);
    // default support 5 → nothing; lower to 3 → both count.
    expect(buildCoupling(churn, coChange).partners.size).toBe(0);
    const { partners } = buildCoupling(churn, coChange, { minSupport: 3, topK: 1 });
    expect(partners.get('a.ts')).toHaveLength(1); // topK = 1
  });

  it('returns empty maps for empty co-change input', () => {
    const { partners, signal } = buildCoupling(churnOf([['a.ts', 3]]), new Map());
    expect(partners.size).toBe(0);
    expect(signal.size).toBe(0);
  });

  it('skips a pair whose files are missing from the churn map (denom 0)', () => {
    const churn = churnOf([['a.ts', 10]]); // b.ts absent
    const { partners } = buildCoupling(churn, coChangeOf([['a.ts', 'b.ts', 9]]));
    // b has 0 revs but a has 10 → denom = max(10,0) = 10, so the pair DOES count.
    expect(partners.get('a.ts')).toEqual([{ path: 'b.ts', strength: 0.9, sharedCommits: 9 }]);
    // but a pair where BOTH are unknown is skipped (denom 0).
    const none = buildCoupling(new Map(), coChangeOf([['x.ts', 'y.ts', 9]]));
    expect(none.partners.size).toBe(0);
  });
});
