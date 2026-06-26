import * as assert from 'assert';
import * as vscode from 'vscode';

import { showCoupledFiles } from '../../host/coupledFiles';
import type { CoupledFile } from '../../core/coupling';
import type { HotspotService } from '../../host/scanService';

// @vscode/test-cli (Electron) integration test for "Show Coupled Files" (S4-B2).
// S4-B1 (the real `getCoupledFiles`) may not have merged, so the service is
// stubbed (the empty-service stub pattern from `topHotspots.test.ts`).

/** Resolve the extension by manifest name (survives publisher renames). */
function hotspotExtension(): vscode.Extension<unknown> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'hotspot');
  assert.ok(ext, 'hotspot extension should be discoverable');
  return ext;
}

/** A workspace-relative file that exists in the test repo. */
function workspaceUri(...segments: string[]): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders![0];
  return vscode.Uri.joinPath(folder.uri, ...segments);
}

function stubService(partners: CoupledFile[]): Pick<HotspotService, 'getCoupledFiles'> {
  return { getCoupledFiles: () => partners };
}

suite('Show Coupled Files command (integration)', () => {
  let originalQuickPick: typeof vscode.window.showQuickPick;
  let originalInfo: typeof vscode.window.showInformationMessage;

  suiteSetup(async () => {
    await hotspotExtension().activate();
  });

  setup(() => {
    originalQuickPick = vscode.window.showQuickPick;
    originalInfo = vscode.window.showInformationMessage;
  });

  teardown(() => {
    (vscode.window as { showQuickPick: unknown }).showQuickPick = originalQuickPick;
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage =
      originalInfo;
  });

  test('registers the hotspot.showCoupledFiles command', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('hotspot.showCoupledFiles'),
      'hotspot.showCoupledFiles should be registered after activation',
    );
  });

  test('lists partners sorted by strength and opens the picked file', async function () {
    this.timeout(30_000);

    // Real repo files so showTextDocument can actually open the selection.
    const partners: CoupledFile[] = [
      { path: 'package.json', strength: 0.8, sharedCommits: 12 },
      { path: 'README.md', strength: 0.4, sharedCommits: 6 },
    ];

    let offered: Array<{ partner: CoupledFile }> = [];
    (vscode.window as { showQuickPick: unknown }).showQuickPick = async (
      items: Array<{ partner: CoupledFile }>,
    ) => {
      offered = await Promise.resolve(items);
      return offered[0];
    };

    await showCoupledFiles(stubService(partners), workspaceUri('src', 'host', 'extension.ts'));

    assert.strictEqual(offered.length, 2, 'both partners should be offered');
    for (let i = 1; i < offered.length; i++) {
      assert.ok(
        offered[i - 1].partner.strength >= offered[i].partner.strength,
        'partners should be listed in descending strength order',
      );
    }

    const active = vscode.window.activeTextEditor;
    assert.ok(active, 'a document should open after selecting a partner');
    const openedRel = vscode.workspace
      .asRelativePath(active!.document.uri, false)
      .replace(/\\/g, '/');
    assert.strictEqual(openedRel, 'package.json', 'the strongest partner should open');
  });

  test('no partners shows an informational message', async () => {
    const messages: string[] = [];
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = async (
      message: string,
    ) => {
      messages.push(message);
      return undefined;
    };

    await showCoupledFiles(stubService([]), workspaceUri('src', 'host', 'extension.ts'));

    assert.strictEqual(messages.length, 1, 'one info message when there are no partners');
    assert.match(messages[0], /no strong co-change partners/i);
  });

  test('no active file shows guidance', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const messages: string[] = [];
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = async (
      message: string,
    ) => {
      messages.push(message);
      return undefined;
    };

    // No uri + no active editor → guidance path (getCoupledFiles never called).
    await showCoupledFiles(stubService([{ path: 'x', strength: 1, sharedCommits: 9 }]));

    assert.strictEqual(messages.length, 1, 'one guidance message when no file is open');
    assert.match(messages[0], /open a file/i);
  });
});
