import * as assert from 'assert';
import * as vscode from 'vscode';

import type { RiskResult } from '../../core/scorer';
import type { HotspotService } from '../../host/scanService';
import { showTopHotspots } from '../../host/topHotspots';

// @vscode/test-cli (Electron) integration test for the "Top Hotspots" command
// (S4-C). The test workspace is this repo, so a real scan yields a ranking.

/**
 * Resolve the extension by manifest name rather than a hardcoded `publisher.id`,
 * so the test survives publisher renames.
 */
function hotspotExtension(): vscode.Extension<unknown> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'hotspot');
  assert.ok(ext, 'hotspot extension should be discoverable');
  return ext;
}

suite('Top Hotspots command (integration)', () => {
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

  test('registers the hotspot.showTopHotspots command', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('hotspot.showTopHotspots'),
      'hotspot.showTopHotspots should be registered after activation',
    );
  });

  test('lists hotspots ordered by score and opens the picked file', async function () {
    this.timeout(60_000);

    const results = (await vscode.commands.executeCommand('hotspot.scan')) as RiskResult[];
    assert.ok(results.length > 0, 'workspace scan should yield ranked files');

    // Capture the offered items and auto-select the first (top-ranked) one.
    let offered: Array<{ result: RiskResult }> = [];
    (vscode.window as { showQuickPick: unknown }).showQuickPick = async (
      items: Array<{ result: RiskResult }>,
    ) => {
      offered = await Promise.resolve(items);
      return offered[0];
    };

    await vscode.commands.executeCommand('hotspot.showTopHotspots');

    assert.ok(offered.length > 0, 'Quick Pick should offer items');
    // Items mirror the descending-by-score ranking.
    for (let i = 1; i < offered.length; i++) {
      assert.ok(
        offered[i - 1].result.score >= offered[i].result.score,
        'Quick Pick items should be ordered by score (descending)',
      );
    }
    assert.strictEqual(
      offered[0].result.path,
      results[0].path,
      'first item should be the top-ranked file',
    );

    // Selecting the first item opens the corresponding file.
    const active = vscode.window.activeTextEditor;
    assert.ok(active, 'a document should open after selecting a hotspot');
    const openedRel = vscode.workspace
      .asRelativePath(active!.document.uri, false)
      .replace(/\\/g, '/');
    assert.strictEqual(openedRel, results[0].path, 'the top-ranked file should open');
  });

  test('empty results show guidance and offer to run a scan', async () => {
    const messages: string[] = [];
    let offeredActions: string[] = [];
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = async (
      message: string,
      ...actions: string[]
    ) => {
      messages.push(message);
      offeredActions = actions;
      return undefined; // user dismisses the prompt
    };

    // A minimal stub service with no results exercises the empty path
    // deterministically (the live service auto-scans on activation).
    const emptyService = {
      getResults: () => [],
      getResultForPath: () => undefined,
      scan: async () => [],
      onDidUpdate: () => ({ dispose() {} }),
    } as unknown as HotspotService;

    await showTopHotspots(emptyService);

    assert.strictEqual(messages.length, 1, 'one info message for empty results');
    assert.match(messages[0], /run Hotspot: Scan/i, 'message should guide the user to scan');
    assert.ok(offeredActions.includes('Run Scan'), 'should offer a Run Scan action');
  });
});
