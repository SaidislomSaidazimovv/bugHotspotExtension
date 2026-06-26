import * as vscode from 'vscode';
import { spawn } from 'node:child_process';

import type { ChurnMap } from '../core/types';
import {
  serializeChurn,
  deserializeChurn,
  type SerializedChurnMap,
} from '../core/churnSerde';

// Persisted churn cache, keyed by the repo's HEAD commit SHA. The expensive
// part of a scan is the `git log` walk; complexity is cheap and recomputed from
// current disk contents every scan, so only the churn is cached. A single
// memento key holds { sha, churn } — when HEAD moves we overwrite it, so the
// cache never grows unbounded.

const CACHE_KEY = 'hotspot.churnCache.v1';

interface CacheEntry {
  sha: string;
  churn: SerializedChurnMap;
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

  /** Cached churn for `sha`, or undefined on miss / stale / corrupt entry. */
  load(sha: string): ChurnMap | undefined {
    const entry = this.memento.get<CacheEntry>(CACHE_KEY);
    if (!entry || entry.sha !== sha) {
      return undefined;
    }
    // deserializeChurn is tolerant of malformed/version-mismatched data.
    return deserializeChurn(entry.churn);
  }

  /** Persist `churn` under `sha`, replacing any previous entry. */
  async save(sha: string, churn: ChurnMap): Promise<void> {
    const entry: CacheEntry = { sha, churn: serializeChurn(churn) };
    await this.memento.update(CACHE_KEY, entry);
  }
}
