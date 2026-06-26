import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Hotspot extension', () => {
  test('activates and registers the hotspot.scan command', async () => {
    const ext = vscode.extensions.getExtension('hotspot-dev.hotspot');
    assert.ok(ext, 'extension should be discoverable by id');

    await ext!.activate();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('hotspot.scan'),
      'hotspot.scan should be registered after activation',
    );
  });
});
