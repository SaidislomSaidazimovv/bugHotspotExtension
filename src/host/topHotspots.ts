import * as vscode from 'vscode';

import type { HotspotService } from './scanService';
import type { RiskResult } from '../core/scorer';

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

function toPick(result: RiskResult): HotspotPick {
  const s = result.signals;
  return {
    label: `$(flame) ${result.score} · ${result.tier} — ${result.path}`,
    description:
      `commits ${s.freq} · churn ${s.churn} · ` +
      `authors ${s.authors} · complexity ${s.complexity}`,
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

  const topN = vscode.workspace
    .getConfiguration('hotspot')
    .get<number>('topHotspotsCount', DEFAULT_TOP_N);
  const items = results.slice(0, Math.max(1, topN)).map(toPick);

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Top Hotspots',
    placeHolder: 'Select a hotspot to open it',
    matchOnDescription: true,
  });
  if (!picked) {
    return; // user dismissed
  }

  const uri = toUri(picked.result.path);
  if (uri) {
    await vscode.window.showTextDocument(uri);
  }
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
