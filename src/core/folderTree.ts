// Folder → file risk tree — PURE core (no 'vscode' import). (S9)
//
// Folds a flat `RiskResult[]` (forward-slash, repo-relative paths) into a nested
// folder tree for the Risk Treemap webview. Each node carries the two visual
// channels the treemap needs:
//   - `area`  → code-volume weight. A leaf's area is its churn (lines changed,
//               the only volume proxy on `RiskResult` — LOC is not available),
//               floored so a 0-churn file still draws. A folder's area is the sum
//               of its children's.
//   - `score`/`tier` → risk color. A leaf uses its own score/tier; a folder
//               propagates the WORST (highest-scoring) leaf beneath it, so a hot
//               file is visible even inside an otherwise-cool folder.
// DISPLAY-ONLY: this never re-scores; it only reshapes already-computed results.

import type { RiskResult, RiskTier } from './scorer';

/** Minimum leaf area so a 0-churn file still renders as a (tiny) rectangle. */
export const AREA_FLOOR = 1;

/** A node in the folder→file risk tree. Serializable (posted to the webview). */
export interface TreemapNode {
  /** Path segment (folder or file basename); '' for the synthetic root. */
  name: string;
  /** Full forward-slash repo-relative path ('' for the root). */
  path: string;
  /** True for a file (leaf), false for a folder (or the root). */
  isFile: boolean;
  /** Code-volume weight: leaf = max(churn, AREA_FLOOR); folder = Σ children. */
  area: number;
  /** Worst (highest) risk score in this subtree; a leaf uses its own score. */
  score: number;
  /** Tier of the worst-scoring leaf in this subtree (a leaf uses its own tier). */
  tier: RiskTier;
  /** Child nodes (folders before files is NOT guaranteed — see {@link sortTree}). */
  children: TreemapNode[];
}

function makeNode(name: string, path: string, isFile: boolean): TreemapNode {
  return { name, path, isFile, area: 0, score: 0, tier: 'low', children: [] };
}

/**
 * Aggregate a folder's `area` (Σ children) and `score`/`tier` (worst child) in a
 * single post-order pass. Files are already populated; folders roll up.
 */
function aggregate(node: TreemapNode): void {
  if (node.isFile) {
    return;
  }
  let area = 0;
  let worst = -1;
  let tier: RiskTier = 'low';
  for (const child of node.children) {
    aggregate(child);
    area += child.area;
    if (child.score > worst) {
      worst = child.score;
      tier = child.tier;
    }
  }
  node.area = area;
  node.score = Math.max(worst, 0);
  node.tier = tier;
}

/**
 * Sort the tree for a stable, readable layout: larger area first (so the treemap
 * is deterministic regardless of input order), ties broken by name. Recursive.
 */
function sortTree(node: TreemapNode): void {
  node.children.sort((a, b) => b.area - a.area || a.name.localeCompare(b.name));
  for (const child of node.children) {
    sortTree(child);
  }
}

/**
 * Build the nested folder→file tree from a flat result set. Paths are split on
 * `/` (the canonical ChurnMap key form). Returns a synthetic root whose children
 * are the top-level entries. An empty input yields an empty root.
 */
export function buildFolderTree(results: readonly RiskResult[], rootName = ''): TreemapNode {
  const root = makeNode(rootName, '', false);
  for (const r of results) {
    const segs = r.path.split('/').filter((s) => s.length > 0);
    if (segs.length === 0) {
      continue; // defensive: skip a malformed empty path
    }
    let node = root;
    let acc = '';
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      acc = acc ? `${acc}/${seg}` : seg;
      const isLast = i === segs.length - 1;
      let child = node.children.find((c) => c.name === seg && c.isFile === isLast);
      if (!child) {
        child = makeNode(seg, acc, isLast);
        node.children.push(child);
      }
      node = child;
    }
    // `node` is now the leaf: populate its visual channels from the result.
    node.area = Math.max(r.signals.churn, AREA_FLOOR);
    node.score = r.score;
    node.tier = r.tier;
  }
  aggregate(root);
  sortTree(root);
  return root;
}
