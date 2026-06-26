// Unit tests for the pure ownership-fragmentation signal (S4-A). Synthetic
// FileChurn objects only — no git, no vscode. Runner: Vitest (`npm run unit`).
//
// Metric (RESEARCH §1 "Ownership concentration"; Bird et al. 2011): from
// per-author commit counts, topShare = maxAuthorCommits / commits and
// fragmentation = 1 − topShare; minorContributors = authors below a share cutoff.

import { describe, it, expect } from 'vitest';

import {
  ownershipStats,
  buildOwnership,
  DEFAULT_MINOR_THRESHOLD,
} from '../../core/ownership';
import type { ChurnMap, FileChurn } from '../../core/types';

/** Build a FileChurn from a name→commits map; commits total derives from it. */
function fc(path: string, authorCommits: Array<[string, number]>): FileChurn {
  const commits = authorCommits.reduce((s, [, c]) => s + c, 0);
  return {
    path,
    commits,
    bugfixCommits: 0,
    linesAdded: 0,
    linesDeleted: 0,
    authors: authorCommits.map(([name]) => name),
    authorCommits: authorCommits.map(([name, c]) => ({ name, commits: c })),
    firstSeen: '2026-01-01T00:00:00+00:00',
    lastSeen: '2026-01-02T00:00:00+00:00',
  };
}

describe('ownershipStats', () => {
  it('reports zero fragmentation for a single-owner file', () => {
    const stats = ownershipStats(fc('solo.ts', [['Alice', 10]]));
    expect(stats.topShare).toBe(1);
    expect(stats.fragmentation).toBe(0);
    expect(stats.minorContributors).toBe(0);
  });

  it('computes 1 − topShare for an evenly split file', () => {
    const stats = ownershipStats(fc('even.ts', [['Alice', 5], ['Bob', 5]]));
    expect(stats.topShare).toBe(0.5);
    expect(stats.fragmentation).toBe(0.5);
    // each author holds 50% ≥ 5% → no minor contributors
    expect(stats.minorContributors).toBe(0);
  });

  it('counts authors below the default 5% share as minor contributors', () => {
    // 1 dominant (80) + 5 tiny (4 each) = 100 commits; each tiny = 4% < 5%.
    const tiny: Array<[string, number]> = Array.from({ length: 5 }, (_, i) => [`m${i}`, 4]);
    const stats = ownershipStats(fc('frag.ts', [['Owner', 80], ...tiny]));
    expect(stats.topShare).toBeCloseTo(0.8, 10);
    expect(stats.fragmentation).toBeCloseTo(0.2, 10);
    expect(stats.minorContributors).toBe(5);
    expect(DEFAULT_MINOR_THRESHOLD).toBe(0.05);
  });

  it('honors a configurable minor-contributor threshold', () => {
    const tiny: Array<[string, number]> = Array.from({ length: 5 }, (_, i) => [`m${i}`, 4]);
    const churn = fc('frag.ts', [['Owner', 80], ...tiny]); // tiny share = 4%
    // 4% is below 5% (default) but not below 3%.
    expect(ownershipStats(churn, 0.03).minorContributors).toBe(0);
    expect(ownershipStats(churn, 0.05).minorContributors).toBe(5);
  });

  it('keeps fragmentation in [0, 1)', () => {
    const many: Array<[string, number]> = Array.from({ length: 50 }, (_, i) => [`d${i}`, 1]);
    const stats = ownershipStats(fc('spread.ts', many));
    expect(stats.fragmentation).toBeGreaterThan(0);
    expect(stats.fragmentation).toBeLessThan(1);
    expect(stats.topShare).toBe(1 / 50);
  });

  it('guards the no-data case (no authorCommits / zero commits) → all zero', () => {
    const empty: FileChurn = { ...fc('x.ts', [['A', 1]]), commits: 0, authors: [], authorCommits: [] };
    const stats = ownershipStats(empty);
    expect(stats).toEqual({ topShare: 0, fragmentation: 0, minorContributors: 0 });
  });

  it('falls back to summing authorCommits when commits is stale/0', () => {
    // commits left at 0 (degraded cache) but per-author data present → use the sum.
    const degraded: FileChurn = {
      ...fc('y.ts', [['Alice', 3], ['Bob', 1]]),
      commits: 0,
    };
    const stats = ownershipStats(degraded);
    expect(stats.topShare).toBe(0.75); // 3 / (3+1)
    expect(stats.fragmentation).toBe(0.25);
  });
});

describe('buildOwnership', () => {
  it('maps each path to its fragmentation value', () => {
    const churn: ChurnMap = new Map([
      ['concentrated.ts', fc('concentrated.ts', [['Alice', 9], ['Bob', 1]])],
      ['fragmented.ts', fc('fragmented.ts', [['A', 1], ['B', 1], ['C', 1], ['D', 1]])],
    ]);
    const ownership = buildOwnership(churn);
    expect(ownership.get('concentrated.ts')).toBeCloseTo(0.1, 10); // 1 − 9/10
    expect(ownership.get('fragmented.ts')).toBeCloseTo(0.75, 10); // 1 − 1/4
    expect([...ownership.keys()].sort()).toEqual(['concentrated.ts', 'fragmented.ts']);
  });

  it('returns an empty map for an empty churn map', () => {
    expect(buildOwnership(new Map())).toEqual(new Map());
  });

  it('threads the minor-contributor threshold through (no effect on fragmentation value)', () => {
    const churn: ChurnMap = new Map([['f.ts', fc('f.ts', [['Owner', 80], ['m', 20]])]]);
    // fragmentation is independent of the minor threshold; only stats.minorContributors uses it.
    expect(buildOwnership(churn, 0.01).get('f.ts')).toBeCloseTo(0.2, 10);
    expect(buildOwnership(churn, 0.5).get('f.ts')).toBeCloseTo(0.2, 10);
  });
});
