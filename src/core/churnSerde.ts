// Serialize / deserialize helpers for ChurnMap — PURE core (no 'vscode').
//
// A `Map` is NOT JSON-serializable: `JSON.stringify(new Map())` yields `"{}"`,
// so persisting a ChurnMap straight into VS Code `workspaceState` (ADR-7 cache)
// would silently store nothing. These helpers convert to/from a plain,
// JSON-safe shape. Each FileChurn already carries its `path`, so the wire form
// is just the list of values; deserialize re-keys it back into a Map.

import type { ChurnMap, FileChurn } from './types';

/** JSON-safe representation of a {@link ChurnMap}, with a version for cache busting. */
export interface SerializedChurnMap {
  version: 1;
  files: FileChurn[];
}

export const CHURN_SERDE_VERSION = 1 as const;

/** Convert a ChurnMap into a JSON-serializable object. */
export function serializeChurn(map: ChurnMap): SerializedChurnMap {
  return { version: CHURN_SERDE_VERSION, files: [...map.values()] };
}

/**
 * Rebuild a ChurnMap from its serialized form. Tolerant of `undefined` /
 * malformed / version-mismatched input (returns an empty map) so a stale or
 * corrupt cache entry degrades to a cold scan instead of throwing.
 */
export function deserializeChurn(data: SerializedChurnMap | undefined | null): ChurnMap {
  const map: ChurnMap = new Map();
  if (!data || data.version !== CHURN_SERDE_VERSION || !Array.isArray(data.files)) {
    return map;
  }
  for (const file of data.files) {
    if (file && typeof file.path === 'string') {
      map.set(file.path, file);
    }
  }
  return map;
}
