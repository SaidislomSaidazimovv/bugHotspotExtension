import * as vscode from 'vscode';
import * as path from 'node:path';

import type { HotspotService } from './scanService';
import type { CoupledFile } from '../core/coupling';

// "Show Coupled Files" Quick Pick (S4-B2): for the active file, list the files
// that historically co-change with it (RESEARCH §3.6 change coupling) so the
// user can remember the hidden dependency. Read-only consumer of the P-frozen
// `HotspotService.getCoupledFiles()` (implemented in S4-B1) — it never touches
// the scan service, cache, or analysis core.

/** The slice of the frozen `HotspotService` contract this command consumes. */
type CoupledFilesProvider = Pick<HotspotService, 'getCoupledFiles'>;

/** A Quick Pick item carrying its backing coupled-file partner. */
interface CoupledPick extends vscode.QuickPickItem {
  partner: CoupledFile;
}

function toPick(partner: CoupledFile): CoupledPick {
  return {
    label: `$(git-merge) ${Math.round(partner.strength * 100)}% · ${partner.path}`,
    description: `co-changed ${partner.sharedCommits}×`,
    partner,
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
 * Show the coupled-files Quick Pick for `uri` (or the active editor) and open
 * the selected partner. Exported for tests; the registered command wraps it.
 *
 * No resolvable file ⇒ a guidance message; no partners ⇒ an info message.
 */
export async function showCoupledFiles(
  service: CoupledFilesProvider,
  uri?: vscode.Uri,
): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target || target.scheme !== 'file') {
    await vscode.window.showInformationMessage(
      'Open a file to see the files that historically change with it.',
    );
    return;
  }

  const relPath = vscode.workspace.asRelativePath(target, false).replace(/\\/g, '/');

  const partners = service.getCoupledFiles(relPath);
  if (partners.length === 0) {
    await vscode.window.showInformationMessage(
      'No strong co-change partners for this file yet.',
    );
    return;
  }

  // Partners arrive sorted desc by strength (frozen contract) — preserve order.
  const picked = await vscode.window.showQuickPick(partners.map(toPick), {
    title: `Coupled with ${path.posix.basename(relPath)}`,
    placeHolder: 'Select a co-changed file to open it',
    matchOnDescription: true,
  });
  if (!picked) {
    return; // user dismissed
  }

  const openUri = toUri(picked.partner.path);
  if (openUri) {
    await vscode.window.showTextDocument(openUri);
  }
}

/**
 * Register the `hotspot.showCoupledFiles` command (palette + editor context
 * menu). The context-menu invocation passes the right-clicked file URI.
 */
export function registerCoupledFiles(
  context: vscode.ExtensionContext,
  service: HotspotService,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('hotspot.showCoupledFiles', (uri?: vscode.Uri) =>
      showCoupledFiles(service, uri),
    ),
  );
}
