import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assertRpcError } from './assertions.ts';
import { createAndroidSettingsWorld } from './android-world.ts';
import { withProviderScenarioResource } from './harness.ts';

test('Provider-backed Android test-IME type returns the typed helper failure on the RPC response', async () => {
  let typeAck: string | undefined;
  await withProviderScenarioResource(
    async () =>
      await createAndroidSettingsWorld({
        onAdbExec: (args) =>
          typeAck !== undefined &&
          args.includes('com.callstack.agentdevice.imehelper.ACTION_INPUT_TEXT_B64')
            ? { stdout: typeAck, stderr: '', exitCode: 0 }
            : undefined,
      }),
    async (world) => {
      const client = world.daemon.client();
      await client.apps.open({ app: 'settings', ...world.selection });
      const snapshot = await client.capture.snapshot({ interactiveOnly: true, ...world.selection });
      const search = snapshot.nodes.find((node) => node.label === 'Search');
      assert.ok(search, JSON.stringify(snapshot.nodes));
      const fill = await client.interactions.fill({
        ref: `@${search.ref}`,
        text: 'Łódź',
        ...world.selection,
      });
      assert.equal(fill.text, 'Łódź');

      typeAck = 'Broadcast completed: result=3, data="no-input-connection"\n';
      const noEditor = assertRpcError(
        await world.daemon.callCommand('type', ['café'], world.selection),
        500,
        'COMMAND_FAILED',
        /not acknowledged as committed/,
      );
      const noEditorDetails = noEditor.details as Record<string, unknown>;
      assert.equal(noEditorDetails.reason, 'android_ime_helper_dispatch_rejected');
      assert.equal(noEditorDetails.dispatchKind, 'no-input-connection');

      typeAck = 'Broadcast completed: result=0\n';
      const noAck = assertRpcError(
        await world.daemon.callCommand('type', ['café'], world.selection),
        500,
        'COMMAND_FAILED',
        /not acknowledged as committed/,
      );
      const noAckDetails = noAck.details as Record<string, unknown>;
      assert.equal(noAckDetails.reason, 'android_ime_helper_no_ack');
      assert.match(String(noAckDetails.hint ?? noAck.hint), /Reinstall/);
    },
  );
});
