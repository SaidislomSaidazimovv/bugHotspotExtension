import * as vscode from 'vscode';

import { createHotspotService } from './scanService';
import { registerDecorations } from './decorationProvider';
import { registerStatusBar } from './statusBar';
import { registerRiskPanel } from './treeProvider';
import { registerTopHotspots } from './topHotspots';
import { registerCoupledFiles } from './coupledFiles';
import { registerCodeRiskDecorations } from './codeRiskDecorations';
import { registerCodeLens } from './codeLensProvider';
import { registerExportReport } from './exportReport';
import { registerWorkingSetLens } from './workingSetLens';

// Thin host layer (ADR-1): analysis lives in `core/` (zero `vscode` imports);
// this file only wires the service to VS Code commands and UI surfaces.
export function activate(context: vscode.ExtensionContext): void {
  const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const service = createHotspotService(context, repoRoot);
  context.subscriptions.push(service);

  registerDecorations(context, service);
  registerStatusBar(context, service);
  registerRiskPanel(context, service);
  registerTopHotspots(context, service);
  registerCoupledFiles(context, service);
  registerCodeRiskDecorations(context);
  registerCodeLens(context);
  registerExportReport(context, service);
  registerWorkingSetLens(context, service, repoRoot);

  context.subscriptions.push(
    // Return the promise so callers (and integration tests) can await results.
    vscode.commands.registerCommand('hotspot.scan', () => service.scan()),
  );

  // Pre-warm on activation: reuses the cache when HEAD is unchanged, otherwise
  // runs a full scan. Configurable; never blocks activation.
  const scanOnStartup = vscode.workspace
    .getConfiguration('hotspot')
    .get<boolean>('scanOnStartup', true);
  if (scanOnStartup && repoRoot) {
    void service.scan();
  }
}

export function deactivate(): void {
  // Disposables are managed via context.subscriptions.
}
