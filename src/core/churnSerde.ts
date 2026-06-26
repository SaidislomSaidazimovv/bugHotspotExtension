// Serialize / deserialize helpers for the churn cache — PURE core (no 'vscode').
//
// A `Map` is NOT JSON-serializable: `JSON.stringify(new Map())` yields `"{}"`,
// so persisting a ChurnMap straight into VS Code `workspaceState` (ADR-7 cache)
// would silently store nothing. These helpers convert the cached scan inputs —
// the ChurnMap AND the change-coupling co-change counts (S4-B1) — to/from a
// plain, JSON-safe shape. Each FileChurn already carries its `path`, so the wire
// form is just the list of values plus the co-change entries; deserialize
// re-keys both back into Maps.

import { type ChurnMap, type CoChangeCount, type FileChurn } from './types';

/** JSON-safe representation of the churn cache, with a version for cache busting. */
export interface SerializedChurnMap {
  version: 4;
  files: FileChurn[];
  /** `[...CoChangeCount.entries()]` — pairwise co-change counts (S4-B1). */
  coChange: Array<[string, number]>;
}

// Version history:
//   1 → 2  (S4-A): FileChurn gained `authorCommits` (ownership signal).
//   2 → 3  (S4-B1): cache now also stores `coChange` (change-coupling). A churn
//          cache-hit must NOT skip the git pass and lose co-change, so the whole
//          { churn, coChange } pair is persisted together.
//   3 → 4  (S7-B1): FileChurn gained `recencyWeight` + `recentCommits` (time-decay
//          recency + trend). A v3 entry lacks these, so it busts to a cold scan.
// An older-version entry fails the version check below → deserialize returns
// empty maps and the host falls back to a cold scan (no throw).
export const CHURN_SERDE_VERSION = 4 as const;

/** The deserialized churn cache: the ChurnMap plus its co-change counts. */
export interface DeserializedChurn {
  churn: ChurnMap;
  coChange: CoChangeCount;
}

/** Convert a churn map + co-change counts into a JSON-serializable object. */
export function serializeChurn(
  churn: ChurnMap,
  coChange: CoChangeCount,
): SerializedChurnMap {
  return {
    version: CHURN_SERDE_VERSION,
    files: [...churn.values()],
    coChange: [...coChange.entries()],
  };
}

/**
 * Rebuild the churn map + co-change counts from their serialized form. Tolerant
 * of `undefined` / malformed / version-mismatched input (returns empty maps) so
 * a stale or corrupt cache entry degrades to a cold scan instead of throwing.
 */
export function deserializeChurn(
  data: SerializedChurnMap | undefined | null,
): DeserializedChurn {
  const churn: ChurnMap = new Map();
  const coChange: CoChangeCount = new Map();
  if (!data || data.version !== CHURN_SERDE_VERSION || !Array.isArray(data.files)) {
    return { churn, coChange }; // older version / malformed → cold scan
  }
  for (const file of data.files) {
    if (file && typeof file.path === 'string') {
      // Defensive defaults: a current-version entry should carry these, but guard
      // a partially-written / hand-edited cache so downstream code never sees
      // `undefined`. `authorCommits` → [] (ownershipStats reports zero
      // fragmentation); `recencyWeight`/`recentCommits` → 0 (recency term + trend
      // degrade to no-signal). Cache-version mismatch already cold-scans; this is
      // belt-and-braces for a same-version-but-malformed row.
      churn.set(file.path, {
        ...file,
        authorCommits: Array.isArray(file.authorCommits) ? file.authorCommits : [],
        recencyWeight: typeof file.recencyWeight === 'number' ? file.recencyWeight : 0,
        recentCommits: typeof file.recentCommits === 'number' ? file.recentCommits : 0,
      });
    }
  }
  if (Array.isArray(data.coChange)) {
    for (const entry of data.coChange) {
      if (
        Array.isArray(entry) &&
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'number'
      ) {
        coChange.set(entry[0], entry[1]);
      }
    }
  }
  return { churn, coChange };
}
