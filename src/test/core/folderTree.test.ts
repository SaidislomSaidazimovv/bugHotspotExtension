// Unit tests for the pure folder→file risk tree (S9). Synthetic RiskResult[]
// only — no git, no vscode. Runner: Vitest (`npm run unit`).

import { describe, it, expect } from 'vitest';

import { buildFolderTree, AREA_FLOOR, type TreemapNode } from '../../core/folderTree';
import type { RiskResult, RiskTier } from '../../core/scorer';

function makeResult(
  path: string,
  score: number,
  tier: RiskTier,
  churn: number,
): RiskResult {
  return {
    path,
    score,
    tier,
    trend: 'stable',
    signals: { freq: 0, churn, recency: 0, authors: 0, ownership: 0, coupling: 0, complexity: 0 },
  };
}

function child(node: TreemapNode, name: string): TreemapNode {
  const c = node.children.find((k) => k.name === name);
  if (!c) throw new Error(`no child "${name}" under "${node.path || '<root>'}"`);
  return c;
}

describe('buildFolderTree', () => {
  it('folds paths into a nested folder→file tree', () => {
    const root = buildFolderTree([
      makeResult('src/a.ts', 10, 'low', 5),
      makeResult('src/b.ts', 20, 'medium', 5),
      makeResult('README.md', 3, 'low', 2),
    ]);
    expect(root.isFile).toBe(false);
    const src = child(root, 'src');
    expect(src.isFile).toBe(false);
    expect(src.children.map((c) => c.name).sort()).toEqual(['a.ts', 'b.ts']);
    expect(child(src, 'a.ts').isFile).toBe(true);
    expect(child(src, 'a.ts').path).toBe('src/a.ts');
    expect(child(root, 'README.md').isFile).toBe(true);
  });

  it('a folder area is the sum of its children', () => {
    const root = buildFolderTree([
      makeResult('src/a.ts', 10, 'low', 5),
      makeResult('src/b.ts', 20, 'medium', 15),
    ]);
    expect(child(root, 'src').area).toBe(20); // 5 + 15
  });

  it('a folder propagates the WORST (highest-scoring) leaf score + tier', () => {
    const root = buildFolderTree([
      makeResult('src/cool.ts', 10, 'low', 5),
      makeResult('src/hot.ts', 80, 'critical', 5),
    ]);
    const src = child(root, 'src');
    expect(src.score).toBe(80);
    expect(src.tier).toBe('critical');
  });

  it('floors a 0-churn leaf so it still has a renderable area', () => {
    const root = buildFolderTree([makeResult('a.ts', 5, 'low', 0)]);
    expect(child(root, 'a.ts').area).toBe(AREA_FLOOR);
  });

  it('sorts children by area descending (deterministic layout)', () => {
    const root = buildFolderTree([
      makeResult('small.ts', 5, 'low', 2),
      makeResult('big.ts', 5, 'low', 100),
      makeResult('mid.ts', 5, 'low', 20),
    ]);
    expect(root.children.map((c) => c.name)).toEqual(['big.ts', 'mid.ts', 'small.ts']);
  });

  it('handles deep nesting and aggregates through every level', () => {
    const root = buildFolderTree([
      makeResult('src/host/x.ts', 40, 'high', 8),
      makeResult('src/core/y.ts', 10, 'low', 2),
    ]);
    const src = child(root, 'src');
    expect(src.area).toBe(10); // 8 + 2
    expect(src.score).toBe(40); // worst leaf
    expect(child(child(src, 'host'), 'x.ts').path).toBe('src/host/x.ts');
  });

  it('breaks an equal-area tie by name (stable layout regardless of input order)', () => {
    const a = buildFolderTree([
      makeResult('zebra.ts', 5, 'low', 10),
      makeResult('alpha.ts', 5, 'low', 10),
    ]);
    expect(a.children.map((c) => c.name)).toEqual(['alpha.ts', 'zebra.ts']);
    // Reversed input → identical order (deterministic, name tiebreak).
    const b = buildFolderTree([
      makeResult('alpha.ts', 5, 'low', 10),
      makeResult('zebra.ts', 5, 'low', 10),
    ]);
    expect(b.children.map((c) => c.name)).toEqual(['alpha.ts', 'zebra.ts']);
  });

  it('a duplicate path reuses one leaf (last-wins area, never double-counts)', () => {
    const root = buildFolderTree([
      makeResult('src/a.ts', 10, 'low', 100),
      makeResult('src/a.ts', 10, 'low', 7),
    ]);
    const src = child(root, 'src');
    expect(src.children.length).toBe(1); // one leaf, not two
    expect(child(src, 'a.ts').area).toBe(7); // last-wins (max(7,floor)), not 107
  });

  it('an empty result set yields an empty root', () => {
    const root = buildFolderTree([]);
    expect(root.children).toEqual([]);
    expect(root.area).toBe(0);
  });
});
