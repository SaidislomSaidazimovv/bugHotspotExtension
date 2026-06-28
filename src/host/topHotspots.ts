import * as vscode from 'vscode';

import type { HotspotService } from './scanService';
import type { RiskResult } from '../core/scorer';
import {
  buildExplanations,
  effectiveWeights,
  type ExplanationView,
} from '../core/explain';

// "Top Hotspots" Quick Pick (S4-C): a fast jump-list to the riskiest files.
// Read-only consumer of the FROZEN HotspotService contract — it only calls
// `getResults()` (already sorted desc by score) and never touches the scan
// service or the analysis core.

/** Default number of files offered in the Quick Pick (configurable). */
const DEFAULT_TOP_N = 20;

/** A Quick Pick item that carries its backing risk result. */
interface HotspotPick extends vscode.QuickPickItem {
  result: RiskResult;
}

/**
 * Plain-language summary of *why* a file is risky, built from its dominant
 * signals — so the Quick Pick explains the risk instead of just listing numbers.
 * Ownership/coupling are fractions in [0, 1); the rest are raw counts.
 */
function explain(result: RiskResult): string {
  const s = result.signals;
  const parts: string[] = [
    `Changed ${s.freq}× by ${s.authors} author${s.authors === 1 ? '' : 's'}`,
  ];
  if (s.ownership >= 0.6) {
    parts.push('fragmented ownership');
  } else if (s.ownership >= 0.3) {
    parts.push('shared ownership');
  }
  if (s.coupling >= 0.6) {
    parts.push('strongly coupled to other files');
  } else if (s.coupling >= 0.3) {
    parts.push('coupled to other files');
  }
  if (s.churn > 0) {
    parts.push(`${s.churn} lines churned`);
  }
  return parts.join(' · ');
}

function toPick(result: RiskResult, explanation?: ExplanationView): HotspotPick {
  const s = result.signals;
  // Signal line mirrors the Risk Report panel tooltip (treeProvider.ts) so the
  // two surfaces agree — all five signals plus complexity.
  // The activity summary (explain) is followed by the Risk Explainability "why"
  // sentence (S8-A) — the weighted % shares — when explainability is enabled.
  const detail = explanation
    ? `${explain(result)} — ${explanation.sentence}`
    : explain(result);
  return {
    label: `$(flame) ${result.score} · ${result.tier} — ${result.path}`,
    description:
      `commits ${s.freq} · churn ${s.churn} · ` +
      `authors ${s.authors} · ` +
      `ownership ${Math.round(s.ownership * 100)}% fragmented · ` +
      `coupling ${Math.round(s.coupling * 100)}% · ` +
      `complexity ${s.complexity}`,
    detail,
    result,
  };
}

/** Resolve a repo-relative path to an absolute workspace URI. */
function toUri(repoRelPath: string): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }
  return vscode.Uri.joinPath(folder.uri, ...repoRelPath.split('/'));
}

/**
 * Open a hotspot's file. Tries the workspace-root-relative URI first (the common
 * case: the workspace folder IS the git root); if that path doesn't exist (e.g.
 * the git root is a parent of the open folder), falls back to a workspace search,
 * and only then surfaces a clear message — never silently does nothing.
 */
async function openHotspot(repoRelPath: string): Promise<void> {
  const uri = toUri(repoRelPath);
  if (uri) {
    try {
      await vscode.workspace.fs.stat(uri);
      await vscode.window.showTextDocument(uri);
      return;
    } catch {
      // Not at the root-relative location — fall through to a search.
    }
  }

  const matches = await vscode.workspace.findFiles(repoRelPath, undefined, 1);
  if (matches.length > 0) {
    await vscode.window.showTextDocument(matches[0]);
    return;
  }

  await vscode.window.showWarningMessage(
    `Hotspot: couldn't open "${repoRelPath}" — it may have moved or been deleted.`,
  );
}

/**
 * Show the Top Hotspots Quick Pick and open the selected file. Exported for
 * tests; the registered command is a thin wrapper around it.
 *
 * Empty results ⇒ an informational message that offers to run a scan.
 */
export async function showTopHotspots(service: HotspotService): Promise<void> {
  const results = service.getResults();

  if (results.length === 0) {
    const RUN = 'Run Scan';
    const choice = await vscode.window.showInformationMessage(
      'No scan results yet — run Hotspot: Scan to rank your files.',
      RUN,
    );
    if (choice === RUN) {
      await vscode.commands.executeCommand('hotspot.scan');
    }
    return;
  }

  const cfg = vscode.workspace.getConfiguration('hotspot');
  const topN = cfg.get<number>('topHotspotsCount', DEFAULT_TOP_N);
  // Risk Explainability (S8-A): decompose over the FULL result set (the whole-set
  // normalize needs every file), then attach each shown file's breakdown. Gated by
  // `hotspot.explainEnabled`.
  const explanations = cfg.get<boolean>('explainEnabled', true)
    ? buildExplanations(results, effectiveWeights(cfg.get('weights')), (p) =>
        service.getCoupledFiles(p)[0]?.path,
      )
    : undefined;
  const items = results
    .slice(0, Math.max(1, topN))
    .map((r) => toPick(r, explanations?.get(r.path)));

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Top Hotspots',
    placeHolder: 'Select a hotspot to open it',
    matchOnDescription: true,
  });
  if (!picked) {
    return; // user dismissed
  }

  await openHotspot(picked.result.path);
}

/**
 * Register the `hotspot.showTopHotspots` command (jump list of the riskiest
 * files). Wired from `activate()`; also repointed from the status-bar click.
 */
export function registerTopHotspots(
  context: vscode.ExtensionContext,
  service: HotspotService,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('hotspot.showTopHotspots', () =>
      showTopHotspots(service),
    ),
  );
}
