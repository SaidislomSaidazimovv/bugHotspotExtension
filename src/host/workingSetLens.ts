import * as vscode from 'vscode';

import type { HotspotService } from './scanService';
import type { RiskResult } from '../core/scorer';
import { getWorkingSetPaths } from './gitWorkingSet';

// Working-Set Risk Lens (S8-B) — diff-time / PR-review surface. Scopes the
// ALREADY-COMPUTED risk scores to the files in the current git working set
// (uncommitted diff vs HEAD) and passively flags a "you changed X but not its
// strong co-change partner Y" miss.
//
// No-regression BY CONSTRUCTION: this is a pure read-side filter over the FROZEN
// `HotspotService` contract (`getResults` / `getResultForPath` / `getCoupledFiles`).
// It NEVER calls `computeRisk` — the scores are exactly the same six-signal scores
// shown everywhere else; the lens only changes WHICH files you look at and WHEN.
// Value is timing/differentiation (review-time focus), not accuracy.
//
// Opt-in: gated behind `hotspot.workingSet.enabled` (DEFAULT OFF). When disabled
// the module is inert — no git spawn, no watcher, zero behavior change.

/** The slice of the frozen `HotspotService` contract the lens consumes. */
type LensProvider = Pick<
  HotspotService,
  'getResults' | 'getResultForPath' | 'getCoupledFiles'
>;

/**
 * Minimum coupling strength for a "missed partner" hint to fire. The coupling
 * core already enforces a 5-shared-commit min-support; this strength floor on top
 * keeps the hint to genuinely strong, actionable pairs (a weak ride-along partner
 * is noise at review time). New/young files have no partners above the floor →
 * they degrade to SILENCE, never a fabricated nudge.
 */
export const DEFAULT_HINT_STRENGTH_FLOOR = 0.3;

/** A working-set file that has scan history (a real, scoped risk score). */
export interface ScoredEntry {
  path: string;
  result: RiskResult;
}

/** A "you also usually touch this" hint for a missed strong-coupling partner. */
export interface CouplingMissHint {
  /** The changed file (in the working set). */
  changed: string;
  /** Its single strongest co-change partner that is NOT in the working set. */
  partner: string;
  /** Coupling strength in [0, 1]. */
  strength: number;
  /** Commits that historically touched both files. */
  sharedCommits: number;
}

/** The scoped lens view: scored changes, no-history changes, and miss hints. */
export interface WorkingSetView {
  /** Working-set files WITH history, sorted desc by score (highest risk first). */
  scored: ScoredEntry[];
  /**
   * Working-set files with NO scan history (new/untracked/never-committed). Shown
   * as "no history" — NEVER given a fabricated low score.
   */
  noHistory: string[];
  /** Passive missed-strong-partner hints (single strongest per changed file). */
  hints: CouplingMissHint[];
}

/** Options for {@link buildWorkingSetView}. */
export interface BuildViewOptions {
  /** Coupling strength floor for hints (default {@link DEFAULT_HINT_STRENGTH_FLOOR}). */
  hintStrengthFloor?: number;
}

/** Normalize to the forward-slash, repo-relative key form the service uses. */
function toRepoKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Build the scoped lens view from the working-set paths + the frozen service.
 * PURE over its inputs (no git, no vscode I/O) so it is unit-testable with a fake
 * service. Path matching is case-insensitive (Windows owner) — a partner already
 * in the working set never produces a hint.
 */
export function buildWorkingSetView(
  service: LensProvider,
  workingSetPaths: readonly string[],
  opts: BuildViewOptions = {},
): WorkingSetView {
  const floor = opts.hintStrengthFloor ?? DEFAULT_HINT_STRENGTH_FLOOR;

  // De-duped, normalized working set + a case-insensitive membership set.
  const keys: string[] = [];
  const seen = new Set<string>();
  const inSetCI = new Set<string>();
  for (const raw of workingSetPaths) {
    const key = toRepoKey(raw);
    const ci = key.toLowerCase();
    if (seen.has(ci)) {
      continue;
    }
    seen.add(ci);
    keys.push(key);
    inSetCI.add(ci);
  }

  const scored: ScoredEntry[] = [];
  const noHistory: string[] = [];
  const hints: CouplingMissHint[] = [];

  for (const key of keys) {
    const result = service.getResultForPath(key);
    if (result) {
      scored.push({ path: key, result });
    } else {
      // No scan history → "no history". A new/untracked file is NOT low-risk,
      // it is unknown-risk, and we say so rather than inventing a score.
      noHistory.push(key);
    }

    // Coupling-miss hint: the single strongest partner of this changed file that
    // is (a) above the strength floor and (b) NOT also in the working set. Young
    // files with no qualifying partner contribute nothing → silence.
    const partners = service.getCoupledFiles(key);
    const top = partners[0];
    if (top && top.strength >= floor && !inSetCI.has(top.path.toLowerCase())) {
      hints.push({
        changed: key,
        partner: top.path,
        strength: top.strength,
        sharedCommits: top.sharedCommits,
      });
    }
  }

  scored.sort((a, b) => b.result.score - a.result.score);
  return { scored, noHistory, hints };
}

/** Read `hotspot.workingSet.enabled` (default false). */
export function isWorkingSetEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('hotspot')
    .get<boolean>('workingSet.enabled', false);
}

/** Quick Pick row. Separators carry no `openPath`; every file/hint row opens one. */
interface LensPick extends vscode.QuickPickItem {
  /** Repo-relative target to open when picked. Scored, no-history AND hint rows
   *  set it (a hint row opens the missed partner); only separators omit it. */
  openPath?: string;
}

/** Resolve a repo-relative path to an absolute workspace URI. */
function toUri(repoRelPath: string): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }
  return vscode.Uri.joinPath(folder.uri, ...repoRelPath.split('/'));
}

/** Build the Quick Pick rows for a view (exported for tests). */
export function viewToPicks(view: WorkingSetView): LensPick[] {
  const picks: LensPick[] = [];

  if (view.scored.length > 0) {
    picks.push({ label: 'Changed files by risk', kind: vscode.QuickPickItemKind.Separator });
    for (const { path: p, result } of view.scored) {
      picks.push({
        label: `$(flame) ${result.score} · ${p}`,
        // "relative to THIS repo" — scores are a within-repo ranking, not a probability.
        description: `${result.tier} risk (relative to this repo)`,
        openPath: p,
      });
    }
  }

  if (view.noHistory.length > 0) {
    picks.push({ label: 'New / untracked', kind: vscode.QuickPickItemKind.Separator });
    for (const p of view.noHistory) {
      picks.push({
        label: `$(file-add) ${p}`,
        description: 'no history — risk unknown',
        openPath: p,
      });
    }
  }

  if (view.hints.length > 0) {
    picks.push({ label: 'Maybe also edit', kind: vscode.QuickPickItemKind.Separator });
    for (const h of view.hints) {
      picks.push({
        label: `$(git-merge) ${h.partner}`,
        description: `usually changes with ${h.changed} (${Math.round(
          h.strength * 100,
        )}%, ${h.sharedCommits}×) — not in your working set`,
        openPath: h.partner,
      });
    }
  }

  return picks;
}

/**
 * Show the working-set lens Quick Pick. Lazy: only spawns git here, only when the
 * feature is enabled. Exported for tests; the registered command wraps it.
 */
export async function showWorkingSet(
  service: LensProvider,
  repoRoot: string | undefined,
): Promise<void> {
  if (!isWorkingSetEnabled()) {
    await vscode.window.showInformationMessage(
      'The Working-Set Risk Lens is off. Enable “hotspot.workingSet.enabled” to scope risk to your current changes.',
    );
    return;
  }
  if (!repoRoot) {
    await vscode.window.showInformationMessage('Open a git repository to use the Working-Set Risk Lens.');
    return;
  }

  const paths = await getWorkingSetPaths(repoRoot);
  if (paths.length === 0) {
    await vscode.window.showInformationMessage('No uncommitted changes in the working set.');
    return;
  }

  // No scan has produced any scores yet: every changed file would otherwise fall
  // into "no history" and render as "new / untracked", which is misleading for
  // long-lived TRACKED files. Distinguish "no scan yet" from "genuinely new file".
  if (service.getResults().length === 0) {
    await vscode.window.showInformationMessage(
      'No risk data yet — run a Hotspot scan first, then the lens can rank your changed files.',
    );
    return;
  }

  const view = buildWorkingSetView(service, paths);
  const picks = viewToPicks(view);
  if (picks.length === 0) {
    await vscode.window.showInformationMessage('No risk data for the current working set yet — run a scan.');
    return;
  }

  const picked = (await vscode.window.showQuickPick(picks, {
    title: 'Working-Set Risk Lens',
    placeHolder: 'Highest-risk changed files first · select one to open',
    matchOnDescription: true,
  })) as LensPick | undefined;
  if (!picked?.openPath) {
    return; // dismissed or an informational/separator row
  }
  const uri = toUri(picked.openPath);
  if (uri) {
    await vscode.window.showTextDocument(uri);
  }
}

/**
 * Register the Working-Set Risk Lens: the `hotspot.showWorkingSet` command plus a
 * status-bar affordance + a debounced git/index watcher that refreshes the
 * affordance. The watcher is wired only while `hotspot.workingSet.enabled` is true
 * (lazy — no git spawn when disabled) and is torn down/rebuilt on config change.
 */
export function registerWorkingSetLens(
  context: vscode.ExtensionContext,
  service: HotspotService,
  repoRoot: string | undefined,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('hotspot.showWorkingSet', () =>
      showWorkingSet(service, repoRoot),
    ),
  );

  if (!repoRoot) {
    return; // nothing to watch without a repo
  }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  status.command = 'hotspot.showWorkingSet';
  context.subscriptions.push(status);

  let debounce: ReturnType<typeof setTimeout> | undefined;
  let watcher: vscode.FileSystemWatcher | undefined;

  const refresh = async (): Promise<void> => {
    if (!isWorkingSetEnabled()) {
      status.hide();
      return;
    }
    const paths = await getWorkingSetPaths(repoRoot);
    if (paths.length === 0) {
      status.hide();
      return;
    }
    const view = buildWorkingSetView(service, paths);
    const top = view.scored[0];
    status.text = top
      ? `$(git-compare) Working set: ${view.scored.length} · top ${top.result.score}`
      : `$(git-compare) Working set: ${paths.length} changed`;
    status.tooltip = 'Working-Set Risk Lens — changed files ranked by risk (relative to this repo)';
    status.show();
  };

  const scheduleRefresh = (): void => {
    if (debounce) {
      clearTimeout(debounce);
    }
    // Debounce off HEAD/index CHANGES (commits, staging) — never keystrokes.
    debounce = setTimeout(() => void refresh(), 600);
  };

  const teardownWatcher = (): void => {
    watcher?.dispose();
    watcher = undefined;
  };

  const setupWatcher = (): void => {
    teardownWatcher();
    if (!isWorkingSetEnabled()) {
      return;
    }
    // Watch the index + HEAD (and ref updates) — these move on stage/unstage,
    // commit, checkout. A coarse `.git/**` glob keeps it simple and offline.
    watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(repoRoot, '.git/{index,HEAD,refs/**}'),
    );
    watcher.onDidChange(scheduleRefresh);
    watcher.onDidCreate(scheduleRefresh);
    watcher.onDidDelete(scheduleRefresh);
  };

  context.subscriptions.push(
    service.onDidUpdate(() => void refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('hotspot.workingSet.enabled')) {
        setupWatcher();
        void refresh();
      }
    }),
    { dispose: () => debounce && clearTimeout(debounce) },
    { dispose: teardownWatcher },
  );

  setupWatcher();
  void refresh();
}
