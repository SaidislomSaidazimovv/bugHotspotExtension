import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { readChurnWithCoupling } from '../core/gitReader';
import { computeComplexity, type ComplexityResult } from '../core/complexity';
import {
  computeRisk,
  type RiskResult,
  type ScoreWeights,
  type ScoreThresholds,
} from '../core/scorer';
import { buildBugfixDensity } from '../core/bugfix';
import { buildOwnership } from '../core/ownership';
import { buildCoupling, type CoupledFile } from '../core/coupling';
import { isExcluded } from '../core/exclude';
import { splitCoChangeKey, type ChurnMap, type CoChangeCount } from '../core/types';
import { HotspotCache } from './cache';

/**
 * The Phase-3 spine: runs the pure analysis core against the workspace and
 * exposes the resulting risk ranking to the UI layers. This is the FROZEN
 * contract consumed by the decoration/status-bar providers (and later S3-B/C).
 */
export interface HotspotService {
  /** Run a full scan, update the cache, and fire `onDidUpdate`. */
  scan(token?: vscode.CancellationToken): Promise<RiskResult[]>;
  /** Last computed results (empty before the first scan). */
  getResults(): RiskResult[];
  /** Result for a repo-relative path (forward-slash or OS separators). */
  getResultForPath(repoRelPath: string): RiskResult | undefined;
  /**
   * Change-coupling partners for a repo-relative path (forward-slash or OS
   * separators), sorted desc by strength; `[]` when none meet min-support or the
   * file is unknown. FROZEN contract consumed by S4-B2's "Show Coupled Files".
   */
  getCoupledFiles(repoRelPath: string): CoupledFile[];
  /** Fires after every successful scan with the new results. */
  readonly onDidUpdate: vscode.Event<RiskResult[]>;
}

// Files larger than this are skipped (generated/minified/vendored bloat would
// dominate the indentation proxy without signalling real risk).
const MAX_FILE_BYTES = 1_500_000;
// Bytes sampled to sniff for binary content (a NUL byte ⇒ treat as binary).
const BINARY_SNIFF_BYTES = 8_000;

/**
 * Default `hotspot.exclude` globs (S7-A1) — generated / vendored / lockfile paths
 * that carry churn but no actionable risk. Kept in sync with the package.json
 * default; also used as the fallback when the setting is unreadable. Set the
 * config to `[]` to disable exclusion entirely.
 */
const DEFAULT_EXCLUDE: string[] = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/*.min.js',
  '**/*.bundle.js',
  '**/*.map',
  '**/vendor/**',
  '**/*.lock',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
];

/** Read the user's `hotspot.exclude` globs, falling back to the defaults. */
function getExcludePatterns(): string[] {
  const v = vscode.workspace
    .getConfiguration('hotspot')
    .get<string[]>('exclude', DEFAULT_EXCLUDE);
  return Array.isArray(v) ? v : DEFAULT_EXCLUDE;
}

/** The `hotspot.*` keys (S7-A2) whose change should trigger a debounced rescan. */
const RESCAN_CONFIG_KEYS = [
  'hotspot.exclude',
  'hotspot.weights',
  'hotspot.thresholds',
  'hotspot.sinceMonths',
] as const;

/** Debounce window for the config-change rescan (coalesces rapid settings edits). */
const CONFIG_RESCAN_DEBOUNCE_MS = 500;

const WEIGHT_KEYS: (keyof ScoreWeights)[] = [
  'freq',
  'churn',
  'recency',
  'authors',
  'ownership',
  'coupling',
];
const THRESHOLD_KEYS: (keyof ScoreThresholds)[] = ['medium', 'high', 'critical'];

/** A finite, non-negative number — the only values we accept from user config. */
function finiteNonNeg(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Read `hotspot.weights` as a sanitized partial: only the six known
 * `ScoreWeights` keys with finite, non-negative values are kept; everything else
 * (missing / wrong-typed / negative / extra keys) is dropped so the scorer falls
 * back to its default for that term. Returns `undefined` when nothing is usable.
 */
function getWeights(): Partial<ScoreWeights> | undefined {
  const raw = vscode.workspace.getConfiguration('hotspot').get<Record<string, unknown>>('weights');
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const out: Partial<ScoreWeights> = {};
  for (const key of WEIGHT_KEYS) {
    if (finiteNonNeg(raw[key])) {
      out[key] = raw[key] as number;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Read `hotspot.thresholds` as a sanitized partial (same rules as {@link getWeights}). */
function getThresholds(): Partial<ScoreThresholds> | undefined {
  const raw = vscode.workspace
    .getConfiguration('hotspot')
    .get<Record<string, unknown>>('thresholds');
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const out: Partial<ScoreThresholds> = {};
  for (const key of THRESHOLD_KEYS) {
    if (finiteNonNeg(raw[key])) {
      out[key] = raw[key] as number;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Read `hotspot.sinceMonths` — how many months of history to walk (0 / invalid =
 * all history). Returns a non-negative integer count of months.
 */
function getSinceMonths(): number {
  const v = vscode.workspace.getConfiguration('hotspot').get<number>('sinceMonths', 0);
  return finiteNonNeg(v) ? Math.floor(v) : 0;
}

/** Normalize to the forward-slash, repo-relative form used as ChurnMap keys. */
function toRepoKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Drop excluded paths from the churn map and from the co-change pairs (a pair is
 * dropped if EITHER endpoint is excluded). Filtering the co-change source removes
 * excluded files from both the coupling signal and the partner lists. Returns new
 * maps; the inputs are untouched. An empty pattern list is a no-op (passthrough).
 */
function applyExcludes(
  churn: ChurnMap,
  coChange: CoChangeCount,
  patterns: readonly string[],
): { churn: ChurnMap; coChange: CoChangeCount } {
  if (!patterns || patterns.length === 0) {
    return { churn, coChange };
  }
  const filteredChurn: ChurnMap = new Map();
  for (const [key, value] of churn) {
    if (!isExcluded(key, patterns)) {
      filteredChurn.set(key, value);
    }
  }
  const filteredCoChange: CoChangeCount = new Map();
  for (const [key, count] of coChange) {
    const [a, b] = splitCoChangeKey(key);
    if (!isExcluded(a, patterns) && !isExcluded(b, patterns)) {
      filteredCoChange.set(key, count);
    }
  }
  return { churn: filteredChurn, coChange: filteredCoChange };
}

class HotspotServiceImpl implements HotspotService {
  private results: RiskResult[] = [];
  private byPath = new Map<string, RiskResult>();
  private coupledPartners = new Map<string, CoupledFile[]>();
  private scanning: Promise<RiskResult[]> | undefined;
  /** Set when a scan is requested while one is already in flight (see {@link scan}). */
  private rerunRequested = false;

  private readonly _onDidUpdate = new vscode.EventEmitter<RiskResult[]>();
  readonly onDidUpdate = this._onDidUpdate.event;

  constructor(
    private readonly repoRoot: string | undefined,
    private readonly cache: HotspotCache,
  ) {}

  getResults(): RiskResult[] {
    return this.results;
  }

  getResultForPath(repoRelPath: string): RiskResult | undefined {
    return this.byPath.get(toRepoKey(repoRelPath));
  }

  getCoupledFiles(repoRelPath: string): CoupledFile[] {
    return this.coupledPartners.get(toRepoKey(repoRelPath)) ?? [];
  }

  scan(token?: vscode.CancellationToken): Promise<RiskResult[]> {
    // Coalesce concurrent scans (e.g. activation pre-warm + manual command). But
    // the in-flight scan already sampled the config (weights/thresholds/exclude/
    // sinceMonths) before this call, so a settings change that arrives mid-scan
    // would otherwise be silently lost. Remember it and run exactly one trailing
    // rescan when the current scan settles, so live config edits always take
    // effect even when the git walk outruns the 500 ms config-change debounce.
    if (this.scanning) {
      this.rerunRequested = true;
      return this.scanning;
    }
    const run = this.runScan(token).finally(() => {
      this.scanning = undefined;
    });
    this.scanning = run;
    const drainRerun = () => {
      if (this.rerunRequested) {
        this.rerunRequested = false;
        void this.scan();
      }
    };
    // Drain on settle (success OR failure); rerunRequested is only set by a fresh
    // scan() during flight, so this fires at most one trailing rescan per request.
    run.then(drainRerun, drainRerun);
    return run;
  }

  private async runScan(token?: vscode.CancellationToken): Promise<RiskResult[]> {
    const repoRoot = this.repoRoot;
    if (!repoRoot) {
      this.coupledPartners = new Map();
      return this.publish([]); // no folder / not a repo → nothing to score
    }

    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Hotspot: scanning…' },
      async () => {
        // Churn + co-change: reuse the cache when HEAD is unchanged, else walk
        // git log ONCE (readChurnWithCoupling yields both in a single pass).
        // `sinceMonths` narrows the git history window (S7-A2), so it changes the
        // walk result — fold it into the cache key so a different window can't hit
        // a stale entry. (weights/thresholds are applied at scoring time, not in
        // the walk, so they need no cache-busting.)
        const sinceMonths = getSinceMonths();
        const since = sinceMonths > 0 ? `${sinceMonths} months ago` : undefined;
        const sha = await this.cache.getHeadSha(repoRoot);
        const cacheKey = sha ? `${sha}|since=${sinceMonths}` : undefined;
        const cached = cacheKey ? this.cache.load(cacheKey) : undefined;
        let churn = cached?.churn;
        let coChange = cached?.coChange;
        if (!churn || !coChange) {
          ({ churn, coChange } = await readChurnWithCoupling({ repoRoot, since }));
          if (cacheKey) {
            await this.cache.save(cacheKey, churn, coChange);
          }
        }
        if (token?.isCancellationRequested) {
          return this.results;
        }

        // Exclude generated / vendored / lockfile paths (S7-A1) BEFORE scoring,
        // so they neither pollute the ranking nor appear as coupling partners.
        // Applied to the in-memory churn only — the SHA-keyed cache stays raw, so
        // toggling `hotspot.exclude` takes effect on the next scan without a cold
        // git walk.
        const excludePatterns = getExcludePatterns();
        ({ churn, coChange } = applyExcludes(churn, coChange, excludePatterns));

        // Complexity: recompute from current disk contents per churned file.
        const complexity = new Map<string, ComplexityResult>();
        for (const relPath of churn.keys()) {
          if (token?.isCancellationRequested) {
            break;
          }
          const content = await this.readTextFile(path.join(repoRoot, relPath));
          if (content !== undefined) {
            complexity.set(relPath, computeComplexity(content));
          }
        }

        // Feed S2-D's bug-fix density into the score (RESEARCH §3.6): files
        // whose history is dominated by bug-fix commits rank higher.
        const bugfixDensity = buildBugfixDensity(churn);
        // S4-A ownership fragmentation (1 − topAuthorShare) — its own weighted
        // term (RESEARCH §1; Bird et al. 2011).
        const ownership = buildOwnership(churn);
        // S4-B1 change coupling (RESEARCH §3.6): per-file strongest co-change
        // strength feeds the score; the ranked partner lists back getCoupledFiles.
        const { partners, signal } = buildCoupling(churn, coChange);
        this.coupledPartners = partners;
        // S7-A2: honor user-configured weights/thresholds (sanitized — invalid
        // entries fall back to the scorer defaults, see getWeights/getThresholds).
        return this.publish(
          computeRisk(churn, complexity, {
            bugfixDensity,
            ownership,
            coupling: signal,
            weights: getWeights(),
            thresholds: getThresholds(),
          }),
        );
      },
    );
  }

  /** Read a file as UTF-8, skipping missing / oversized / binary files. */
  private async readTextFile(absPath: string): Promise<string | undefined> {
    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
        return undefined;
      }
      const buf = await fs.readFile(absPath);
      const sniff = buf.subarray(0, BINARY_SNIFF_BYTES);
      if (sniff.includes(0)) {
        return undefined; // NUL byte ⇒ binary
      }
      return buf.toString('utf8');
    } catch {
      return undefined; // unreadable (permissions, deleted mid-scan, etc.)
    }
  }

  private publish(results: RiskResult[]): RiskResult[] {
    this.results = results;
    this.byPath = new Map(results.map((r) => [toRepoKey(r.path), r]));
    this._onDidUpdate.fire(results);
    return results;
  }

  dispose(): void {
    this._onDidUpdate.dispose();
  }
}

/** Create the service. `repoRoot` is undefined when no folder/repo is open. */
export function createHotspotService(
  context: vscode.ExtensionContext,
  repoRoot: string | undefined,
): HotspotService & vscode.Disposable {
  const service = new HotspotServiceImpl(repoRoot, new HotspotCache(context.workspaceState));

  // S7-A2: re-scan (debounced) when a scoring-affecting setting changes, so
  // tweaking weights / thresholds / sinceMonths / exclude updates the ranking
  // live without a manual command. No-op when no repo is open.
  if (repoRoot) {
    let debounce: ReturnType<typeof setTimeout> | undefined;
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!RESCAN_CONFIG_KEYS.some((key) => e.affectsConfiguration(key))) {
          return;
        }
        if (debounce) {
          clearTimeout(debounce);
        }
        debounce = setTimeout(() => void service.scan(), CONFIG_RESCAN_DEBOUNCE_MS);
      }),
      { dispose: () => debounce && clearTimeout(debounce) },
    );
  }

  return service;
}
