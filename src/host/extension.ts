import * as vscode from 'vscode';

// Thin host layer. Keep analysis logic out of here — it belongs in `core/`
// (zero `vscode` imports) per ADR-1.
export function activate(context: vscode.ExtensionContext): void {
  const scan = vscode.commands.registerCommand('hotspot.scan', () => {
    void vscode.window.showInformationMessage(
      'Hotspot: Scan Workspace — analysis not implemented yet (Phase 2).',
    );
  });

  context.subscriptions.push(scan);
}

export function deactivate(): void {
  // Nothing to clean up; disposables are managed via context.subscriptions.
}
