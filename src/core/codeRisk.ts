/**
 * Per-region code-risk core (S6-B1) — PURE core (no 'vscode' import, ADR-1).
 *
 * File-level scoring (scorer.ts) tells you a file is risky; it does not say
 * WHERE. This module localizes risk to intra-file *regions*: contiguous runs of
 * deeply-indented lines (the indentation-as-complexity proxy from
 * complexity.ts, RESEARCH §1) are the v1 signal we can pin to specific lines —
 * git churn / bug-fix density are per-file and not localizable without
 * `git blame`/`git log -L` (a future enhancement; see the limitation note below).
 *
 * Each region carries a 0–100 score (relative WITHIN the file — do NOT compare
 * across files), a severity, and plain-language reasons the host (S6-B2) paints
 * into the editor as gutter marks + hovers. Because regions are scored within
 * the file, even a "low"-tier file can surface one genuinely risky function.
 *
 * v1 limitation: like complexity.ts this is indentation-blind — it cannot tell
 * a deeply-indented string literal / block comment / heredoc from real nested
 * control flow. Kept deliberately language-agnostic & parser-free for speed and
 * polyglot coverage; a syntax-aware pass is a later refinement.
 */

import { lineIndent, DEFAULT_SPACES_PER_INDENT } from './complexity';

export type CodeRiskSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface CodeRiskRegion {
  /** First line of the region (0-based, inclusive). */
  startLine: number;
  /** Last line of the region (0-based, inclusive). */
  endLine: number;
  /** Deepest logical indent reached inside the region. */
  maxDepth: number;
  /** Number of lines spanned: `endLine - startLine + 1`. */
  lineCount: number;
  /** Risk in [0, 100], relative WITHIN this file (not comparable across files). */
  score: number;
  /** Tier derived from `score`. */
  severity: CodeRiskSeverity;
  /** Plain-language risk reasons, e.g. "deeply nested (depth 6)", "long block (80 lines)". */
  reasons: string[];
}

export interface CodeRiskOptions {
  /** Spaces that make up one indent level (forwarded to {@link lineIndent}). Default 4. */
  spacesPerIndent?: number;
  /** Minimum indent depth for a line to be part of a risky region. Default 3. */
  minDepth?: number;
  /** Regions spanning fewer than this many lines are dropped as trivial. Default 3. */
  minLines?: number;
}

const DEFAULT_MIN_DEPTH = 3;
const DEFAULT_MIN_LINES = 3;

// Score = weighted blend of normalized depth + length, depth weighted heavier
// (nesting is a stronger danger signal than mere length). Each factor saturates
// at its cap, so the score is absolute per-region (a single deep region still
// scores high — no cross-region min/max that would zero out a lone function).
const DEPTH_CAP = 10; // logical indent at/above which the depth factor maxes out
const LEN_CAP = 60; // line count at/above which the length factor maxes out
const W_DEPTH = 0.7;
const W_LEN = 0.3;

// Severity cutoffs on the 0–100 score (mirrors the file scorer's tiers).
const T_MEDIUM = 25;
const T_HIGH = 50;
const T_CRITICAL = 75;

// Phrasing thresholds for `reasons`.
const DEEPLY_NESTED_DEPTH = 5; // depth ≥ this reads "deeply nested", else "nested"
const LONG_BLOCK_LINES = 20; // add a "long block" reason at/above this many lines

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function toSeverity(score: number): CodeRiskSeverity {
  if (score < T_MEDIUM) return 'low';
  if (score < T_HIGH) return 'medium';
  if (score < T_CRITICAL) return 'high';
  return 'critical';
}

interface RawRegion {
  startLine: number;
  endLine: number;
  maxDepth: number;
  lineCount: number;
}

function finalizeRegion(raw: RawRegion): CodeRiskRegion {
  const depthFactor = clamp01(raw.maxDepth / DEPTH_CAP);
  const lenFactor = clamp01(raw.lineCount / LEN_CAP);
  const score = Math.round(100 * (W_DEPTH * depthFactor + W_LEN * lenFactor));

  const reasons: string[] = [
    `${raw.maxDepth >= DEEPLY_NESTED_DEPTH ? 'deeply nested' : 'nested'} (depth ${raw.maxDepth})`,
  ];
  if (raw.lineCount >= LONG_BLOCK_LINES) {
    reasons.push(`long block (${raw.lineCount} lines)`);
  }

  return {
    startLine: raw.startLine,
    endLine: raw.endLine,
    maxDepth: raw.maxDepth,
    lineCount: raw.lineCount,
    score,
    severity: toSeverity(score),
    reasons,
  };
}

/**
 * Find a file's risky code regions (deeply-nested / long blocks). Pure function
 * of its inputs; output is deterministic, sorted by `score` desc then
 * `startLine` asc. A flat / shallow file returns `[]`.
 */
export function computeCodeRisk(content: string, opts: CodeRiskOptions = {}): CodeRiskRegion[] {
  const spacesPerIndent =
    opts.spacesPerIndent && opts.spacesPerIndent > 0
      ? opts.spacesPerIndent
      : DEFAULT_SPACES_PER_INDENT;
  const minDepth = opts.minDepth ?? DEFAULT_MIN_DEPTH;
  const minLines = opts.minLines ?? DEFAULT_MIN_LINES;

  const raws: RawRegion[] = [];
  let start = -1;
  let lastDeep = -1;
  let maxDepth = 0;

  const flush = () => {
    if (start >= 0 && lastDeep >= start) {
      const lineCount = lastDeep - start + 1;
      if (lineCount >= minLines) {
        raws.push({ startLine: start, endLine: lastDeep, maxDepth, lineCount });
      }
    }
    start = -1;
    lastDeep = -1;
    maxDepth = 0;
  };

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const depth = lineIndent(line, spacesPerIndent);

    if (depth >= minDepth) {
      if (start < 0) {
        start = i;
      }
      if (depth > maxDepth) {
        maxDepth = depth;
      }
      lastDeep = i;
    } else if (depth < 0) {
      // Blank / whitespace-only line: absorbed into an open region (trailing
      // blanks are trimmed because `endLine` tracks the last DEEP line). It does
      // not start or end a region.
    } else {
      // Shallow code line (0 ≤ depth < minDepth): closes the current region.
      flush();
    }
  }
  flush(); // close a region that runs to EOF

  return raws
    .map(finalizeRegion)
    .sort((a, b) => b.score - a.score || a.startLine - b.startLine);
}
