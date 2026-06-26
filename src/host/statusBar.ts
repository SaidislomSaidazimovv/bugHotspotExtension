import * as vscode from 'vscode';

import type { HotspotService } from './scanService';

// Status-bar item showing the active file's hotspot risk — the cheapest
// always-on signal. Hidden when the active file has no score (or no editor).
// Clicking it opens the Top Hotspots jump list (rescan stays in the palette).

/** Register the status-bar item; updates on editor switch and after each scan. */
export function registerStatusBar(
  context: vscode.ExtensionContext,
  service: HotspotService,
): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'hotspot.showTopHotspots';

  const update = (): void => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      item.hide();
      return;
    }
    const relPath = vscode.workspace
      .asRelativePath(editor.document.uri, false)
      .replace(/\\/g, '/');
    const result = service.getResultForPath(relPath);
    if (!result) {
      item.hide();
      return;
    }
    item.text = `$(flame) Hotspot: ${result.score} (${result.tier})`;
    item.tooltip =
      `Risk rank for this file (relative to the repo). ` +
      `Click to jump to the top hotspots. ` +
      `Rescan via “Hotspot: Scan Workspace” in the Command Palette.`;
    item.show();
  };

  context.subscriptions.push(
    item,
    vscode.window.onDidChangeActiveTextEditor(update),
    service.onDidUpdate(update),
  );
  update();
}
