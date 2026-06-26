import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Hotspot extension', () => {
  test('activates and registers the hotspot.scan command', async () => {
    // Resolve by manifest name, not a hardcoded `publisher.id`, so the test
    // survives publisher renames.
    const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'hotspot');
    assert.ok(ext, 'hotspot extension should be discoverable');

    await ext!.activate();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('hotspot.scan'),
      'hotspot.scan should be registered after activation',
    );
  });
});
