import * as vscode from 'vscode';
import { spawn } from 'node:child_process';

import type { ChurnMap, CoChangeCount } from '../core/types';
import {
  serializeChurn,
  deserializeChurn,
  type DeserializedChurn,
  type SerializedChurnMap,
} from '../core/churnSerde';

// Persisted churn cache, keyed by the repo's HEAD commit SHA. The expensive
// part of a scan is the `git log` walk; complexity is cheap and recomputed from
// current disk contents every scan, so only the git-derived data is cached. As
// of S4-B1 a single memento key holds { sha, data: { churn, coChange } } — a
// churn cache-hit would otherwise skip the git pass and lose the co-change
// counts. When HEAD moves we overwrite it, so the cache never grows unbounded.

const CACHE_KEY = 'hotspot.churnCache.v1';

interface CacheEntry {
  sha: string;
  data: SerializedChurnMap;
}

export class HotspotCache {
  constructor(private readonly memento: vscode.Memento) {}

  /** Current HEAD SHA via `git rev-parse HEAD`, or undefined if unavailable. */
  async getHeadSha(repoRoot: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c: string) => {
        out += c;
      });
      child.on('error', () => resolve(undefined));
      child.on('close', (code) => {
        const sha = out.trim();
        resolve(code === 0 && sha.length > 0 ? sha : undefined);
      });
    });
  }

  /**
   * Cached { churn, coChange } for `sha`, or undefined on miss / stale / corrupt
   * / version-mismatched entry (so the caller does a cold scan). An empty churn
   * map after deserialize means the entry was unusable (e.g. older serde version)
   * → treated as a miss rather than a valid empty result.
   */
  load(sha: string): DeserializedChurn | undefined {
    const entry = this.memento.get<CacheEntry>(CACHE_KEY);
    if (!entry || entry.sha !== sha) {
      return undefined;
    }
    // deserializeChurn is tolerant of malformed/version-mismatched data.
    const result = deserializeChurn(entry.data);
    return result.churn.size > 0 ? result : undefined;
  }

  /** Persist `churn` + `coChange` under `sha`, replacing any previous entry. */
  async save(sha: string, churn: ChurnMap, coChange: CoChangeCount): Promise<void> {
    const entry: CacheEntry = { sha, data: serializeChurn(churn, coChange) };
    await this.memento.update(CACHE_KEY, entry);
  }
}
