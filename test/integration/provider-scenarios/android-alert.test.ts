import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assertCommandCall } from './assertions.ts';
import { createAndroidSettingsWorld } from './android-world.ts';
import {
  androidAppOwnedSheetXml,
  androidButtonlessAlertXml,
  androidNativeAlertXml,
  androidRuntimePermissionXml,
  androidSystemDialogXml,
  dismissibleDialog,
} from './android-dialog-fixtures.ts';
import { withProviderScenarioResource } from './harness.ts';

test('Provider-backed integration Android alert handles runtime permission dialog', async () => {
  const dialog = dismissibleDialog(androidRuntimePermissionXml);
  await withProviderScenarioResource(
    async () => await createAndroidSettingsWorld(dialog),
    async (world) => {
      const client = world.daemon.client();
      await client.apps.open({ app: 'com.example.demo', ...world.selection });

      const alertGet = await client.command.alert({ action: 'get', ...world.selection });
      assert.equal(alertGet.kind, 'alertStatus');
      assert.deepEqual(alertGet.alert, {
        title: 'Allow Demo to send you notifications?',
        buttons: ['Don’t allow', 'Allow'],
        platform: 'android',
        source: 'permission',
        packageName: 'com.google.android.permissioncontroller',
      });

      const alertAccept = await client.command.alert({ action: 'accept', ...world.selection });
      assert.equal(alertAccept.kind, 'alertHandled');
      assert.equal(alertAccept.button, 'Allow');
      assert.deepEqual(
        world.adbCalls.filter((call) => call.join(' ') === 'shell input tap 274 638'),
        [['shell', 'input', 'tap', '274', '638']],
      );

      dialog.show();
      const alertDismiss = await client.command.alert({ action: 'dismiss', ...world.selection });
      assert.equal(alertDismiss.kind, 'alertHandled');
      assert.equal(alertDismiss.button, 'Don’t allow');
      assert.deepEqual(
        world.adbCalls.filter((call) => call.join(' ') === 'shell input tap 116 638'),
        [['shell', 'input', 'tap', '116', '638']],
      );
    },
  );
});

test('Provider-backed integration Android alert handles native AlertDialog actions', async () => {
  const dialog = dismissibleDialog(androidNativeAlertXml);
  await withProviderScenarioResource(
    async () => await createAndroidSettingsWorld(dialog),
    async (world) => {
      const client = world.daemon.client();
      await client.apps.open({ app: 'com.example.demo', ...world.selection });

      const alertGet = await client.command.alert({ action: 'get', ...world.selection });
      assert.deepEqual(alertGet.alert, {
        title: 'Unsaved changes',
        message: 'Leave without saving?',
        buttons: ['Cancel', 'Discard'],
        platform: 'android',
        source: 'native-dialog',
        packageName: 'com.example.demo',
      });

      const alertAccept = await client.command.alert({ action: 'accept', ...world.selection });
      assert.equal(alertAccept.button, 'Discard');
      dialog.show();
      const alertDismiss = await client.command.alert({ action: 'dismiss', ...world.selection });
      assert.equal(alertDismiss.button, 'Cancel');
      assert.deepEqual(
        world.adbCalls.filter((call) =>
          ['shell input tap 274 638', 'shell input tap 116 638'].includes(call.join(' ')),
        ),
        [
          ['shell', 'input', 'tap', '274', '638'],
          ['shell', 'input', 'tap', '116', '638'],
        ],
      );
    },
  );
});

test('Provider-backed integration Android alert handles system dialogs', async () => {
  await withProviderScenarioResource(
    async () => await createAndroidSettingsWorld(dismissibleDialog(androidSystemDialogXml)),
    async (world) => {
      const client = world.daemon.client();
      await client.apps.open({ app: 'com.example.demo', ...world.selection });

      const alertGet = await client.command.alert({ action: 'get', ...world.selection });
      assert.deepEqual(alertGet.alert, {
        title: "Demo isn't responding",
        message: 'Do you want to close it?',
        buttons: ['Close app', 'Wait'],
        platform: 'android',
        source: 'system-dialog',
        packageName: 'com.android.systemui',
      });

      const alertDismiss = await client.command.alert({ action: 'dismiss', ...world.selection });
      assert.equal(alertDismiss.button, 'Close app');
      assertCommandCall(world.adbCalls, ['shell', 'input', 'tap', '116', '638']);
    },
  );
});

test('Provider-backed integration Android alert dismiss falls back to Back without a dismiss button', async () => {
  await withProviderScenarioResource(
    async () => await createAndroidSettingsWorld(dismissibleDialog(androidButtonlessAlertXml)),
    async (world) => {
      const client = world.daemon.client();
      await client.apps.open({ app: 'com.example.demo', ...world.selection });

      const alertDismiss = await client.command.alert({ action: 'dismiss', ...world.selection });
      assert.equal(alertDismiss.kind, 'alertHandled');
      assert.equal(alertDismiss.button, 'Back');
      assertCommandCall(world.adbCalls, ['shell', 'input', 'keyevent', '4']);
    },
  );
});

test('Provider-backed integration Android alert accept fails when the dialog stays visible', async () => {
  await withProviderScenarioResource(
    async () => await createAndroidSettingsWorld({ snapshotXml: androidNativeAlertXml }),
    async (world) => {
      const client = world.daemon.client();
      await client.apps.open({ app: 'com.example.demo', ...world.selection });

      await assert.rejects(
        client.command.alert({ action: 'accept', ...world.selection }),
        (error: unknown) =>
          error instanceof Error &&
          error.message === 'alert accept did not dismiss the visible alert',
      );
      assertCommandCall(world.adbCalls, ['shell', 'input', 'tap', '274', '638']);
    },
  );
});

test('Provider-backed integration Android alert wait polls until a dialog appears', async () => {
  let snapshotCount = 0;
  await withProviderScenarioResource(
    async () =>
      await createAndroidSettingsWorld({
        snapshotXml: () => {
          snapshotCount += 1;
          return snapshotCount === 1 ? androidAppOwnedSheetXml() : androidRuntimePermissionXml();
        },
      }),
    async (world) => {
      const client = world.daemon.client();
      await client.apps.open({ app: 'com.example.demo', ...world.selection });

      const alertWait = await client.command.alert({
        action: 'wait',
        timeoutMs: 1000,
        ...world.selection,
      });
      assert.equal(alertWait.kind, 'alertWait');
      // alert now returns the untyped CommandRequestResult bag (its iOS path is a
      // dynamic runner Record, so the public type is no longer a closed shape).
      const alertInfo = alertWait.alert as { source?: string } | null | undefined;
      assert.equal(alertInfo?.source, 'permission');
      assert.ok(snapshotCount >= 2);
    },
  );
});

test('Provider-backed integration Android alert ignores app-owned sheets', async () => {
  await withProviderScenarioResource(
    async () => await createAndroidSettingsWorld({ snapshotXml: androidAppOwnedSheetXml }),
    async (world) => {
      const client = world.daemon.client();
      await client.apps.open({ app: 'com.example.demo', ...world.selection });

      const alertGet = await client.command.alert({ action: 'get', ...world.selection });
      assert.equal(alertGet.kind, 'alertStatus');
      assert.equal(alertGet.alert, null);
    },
  );
});
