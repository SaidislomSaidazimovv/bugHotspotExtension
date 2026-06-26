import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { readChurn } from '../core/gitReader';
import { computeComplexity, type ComplexityResult } from '../core/complexity';
import { computeRisk, type RiskResult } from '../core/scorer';
import { buildBugfixDensity } from '../core/bugfix';
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
      return this.publish([]); // no folder / not a repo → nothing to score
    }

    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Hotspot: scanning…' },
      async () => {
        // Churn: reuse the cache when HEAD is unchanged, else walk git log.
        const sha = await this.cache.getHeadSha(repoRoot);
        let churn = sha ? this.cache.load(sha) : undefined;
        if (!churn) {
          churn = await readChurn({ repoRoot });
          if (sha) {
            await this.cache.save(sha, churn);
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
        return this.publish(computeRisk(churn, complexity, { bugfixDensity }));
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
