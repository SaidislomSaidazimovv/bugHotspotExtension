import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { readChurnWithCoupling } from '../core/gitReader';
import { computeComplexity, type ComplexityResult } from '../core/complexity';
import { computeRisk, type RiskResult } from '../core/scorer';
import { buildBugfixDensity } from '../core/bugfix';
import { buildOwnership } from '../core/ownership';
import { buildCoupling, type CoupledFile } from '../core/coupling';
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

/** Normalize to the forward-slash, repo-relative form used as ChurnMap keys. */
function toRepoKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

class HotspotServiceImpl implements HotspotService {
  private results: RiskResult[] = [];
  private byPath = new Map<string, RiskResult>();
  private coupledPartners = new Map<string, CoupledFile[]>();
  private scanning: Promise<RiskResult[]> | undefined;

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
    // Coalesce concurrent scans (e.g. activation pre-warm + manual command).
    if (this.scanning) {
      return this.scanning;
    }
    this.scanning = this.runScan(token).finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
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
        const sha = await this.cache.getHeadSha(repoRoot);
        const cached = sha ? this.cache.load(sha) : undefined;
        let churn = cached?.churn;
        let coChange = cached?.coChange;
        if (!churn || !coChange) {
          ({ churn, coChange } = await readChurnWithCoupling({ repoRoot }));
          if (sha) {
            await this.cache.save(sha, churn, coChange);
          }
        }
        if (token?.isCancellationRequested) {
          return this.results;
        }

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
        return this.publish(
          computeRisk(churn, complexity, { bugfixDensity, ownership, coupling: signal }),
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
  return service;
}
