/**
 * Glob-based path exclusion — PURE core (no 'vscode' import, ADR-1).
 *
 * Generated / vendored / lockfile paths (node_modules, dist, *.min.js, …) carry
 * heavy git churn but signal no real, actionable risk — left in, they dominate
 * the ranking and bury the files a human can actually fix. This module decides,
 * from a list of user-configurable glob patterns (`hotspot.exclude`), whether a
 * repo-relative path should be dropped BEFORE complexity/scoring (S7-A1).
 *
 * Patterns are a deliberately MINIMAL glob subset (no parser, no dependency):
 *   - `**`  matches any number of path segments, including zero, across `/`.
 *   - `*`   matches any run of characters except `/` (one path segment).
 *   - `?`   matches a single character except `/`.
 *   - `/`   is a literal path separator.
 * All other characters match literally (regex metacharacters are escaped). Paths
 * are matched in forward-slash form, so OS-separator inputs are normalized first.
 */

/** Regex metacharacters to escape verbatim (the glob operators are handled separately). */
const REGEX_SPECIAL = new Set('\\^$.|+()[]{}'.split(''));

// Compiling a pattern to a RegExp is the only non-trivial cost; cache it so a
// scan over thousands of churn keys doesn't recompile the same dozen globs.
const compileCache = new Map<string, RegExp>();

/**
 * Translate one minimal-glob pattern into an anchored RegExp. Exported for tests.
 * Supports `**`, `*`, `?`, `/`; every other character is matched literally.
 */
export function globToRegExp(pattern: string): RegExp {
  const cached = compileCache.get(pattern);
  if (cached) {
    return cached;
  }

  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          // `**/` → zero or more leading path segments.
          re += '(?:.*/)?';
          i += 2;
        } else {
          // trailing/bare `**` → anything, including `/`.
          re += '.*';
          i += 1;
        }
      } else {
        // single `*` → anything within one path segment.
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (REGEX_SPECIAL.has(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }

  const compiled = new RegExp('^' + re + '$');
  compileCache.set(pattern, compiled);
  return compiled;
}

/** Normalize to the forward-slash form patterns are written against. */
function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * True when `path` matches ANY of the exclude `patterns`. An empty / missing
 * pattern list excludes nothing (the documented "disable" state). Pure and
 * deterministic; safe to call per churn key (compilation is cached).
 */
export function isExcluded(path: string, patterns: readonly string[]): boolean {
  if (!patterns || patterns.length === 0) {
    return false;
  }
  const normalized = normalize(path);
  for (const pattern of patterns) {
    if (!pattern) {
      continue; // skip empty entries defensively
    }
    if (globToRegExp(pattern).test(normalized)) {
      return true;
    }
  }
  return false;
}
