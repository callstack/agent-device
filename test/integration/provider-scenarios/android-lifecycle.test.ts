import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import type { AgentDeviceClient } from '../../../src/client/client-types.ts';
import {
  arrayEqual,
  assertCommandCall,
  assertPngFile,
  assertRpcError,
  assertRpcOk,
} from './assertions.ts';
import { createAndroidSettingsWorld, waitForFileContent } from './android-world.ts';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';
import { createProviderScenarioTempPath, withProviderScenarioResource } from './harness.ts';

type AndroidSettingsWorld = Awaited<ReturnType<typeof createAndroidSettingsWorld>>;

const ANDROID_SYSTEM_SURFACE_XML = `<hierarchy>
  <node class="android.widget.FrameLayout" package="com.android.systemui" window-type="3" window-active="true" window-focused="true" bounds="[0,0][390,844]">
    <node class="android.widget.FrameLayout" package="com.android.systemui" resource-id="com.android.systemui:id/status_bar_launch_animation_container" bounds="[0,0][390,80]">
      <node class="android.widget.TextView" package="com.android.systemui" text="7:03" bounds="[10,10][80,60]"/>
    </node>
    <node class="android.widget.SeekBar" package="com.android.systemui" text="Display brightness" clickable="true" bounds="[20,120][370,170]"/>
    <node class="android.widget.Button" package="com.android.systemui" text="Wi-Fi" clickable="true" bounds="[20,200][180,280]"/>
    <node class="android.widget.Button" package="com.android.systemui" text="Bluetooth" clickable="true" bounds="[200,200][370,280]"/>
  </node>
</hierarchy>`;

test('Provider-backed integration Android Settings flow uses scripted ADB provider', async () => {
  await withProviderScenarioResource(createAndroidSettingsWorld, async (world) => {
    const client = world.daemon.client();
    await runAndroidSetupAndInstallWorkflow(world, client);
    await runAndroidAppControlAndObservabilityWorkflow(world, client);
    await runAndroidCaptureInteractionAndReplayWorkflow(world, client);
    assertAndroidProviderContract(world);
  });
}, 15_000);

test('Provider-backed Android reads keep chrome provenance internal across public node payloads', async () => {
  await withProviderScenarioResource(
    async () => await createAndroidSettingsWorld({ snapshotXml: () => ANDROID_SYSTEM_SURFACE_XML }),
    async (world) => {
      const client = world.daemon.client();
      await client.apps.open({ app: 'settings', ...world.selection });

      const response = await world.daemon.callCommand('snapshot', [], world.selection);
      const snapshot = assertRpcOk<{ nodes: Array<{ ref: string; label?: string }> }>(response);

      assert.equal(
        snapshot.nodes.some((node) => node.label === 'Display brightness'),
        true,
      );

      const clock = snapshot.nodes.find((node) => node.label === '7:03');
      assert.ok(clock?.ref);
      assertRpcOk(
        await world.daemon.callCommand('get', ['attrs', `@${clock.ref}`], world.selection),
      );
      assertRpcOk(
        await world.daemon.callCommand('find', ['label', '7:03', 'get', 'attrs'], world.selection),
      );
    },
  );
});

test('Provider-backed integration Android text provider handles Unicode without shell input text', async () => {
  await withProviderScenarioResource(
    async () => await createAndroidSettingsWorld({ nativeTextInjection: true }),
    async (world) => {
      const client = world.daemon.client();
      await client.apps.open({ app: 'settings', ...world.selection });
      const snapshot = await client.capture.snapshot({
        interactiveOnly: true,
        ...world.selection,
      });
      const search = snapshot.nodes.find((node) => node.label === 'Search');
      assert.ok(search, JSON.stringify(snapshot.nodes));

      const fill = await client.interactions.fill({
        ref: `@${search.ref}`,
        text: 'Łódź café',
        delayMs: 2,
        ...world.selection,
      });
      assert.equal(fill.text, 'Łódź café');

      const typed = await client.interactions.type({
        text: 'naïve résumé',
        delayMs: 3,
        ...world.selection,
      });
      assert.equal(typed.text, 'naïve résumé');

      assert.deepEqual(world.textInjectionCalls, [
        {
          action: 'fill',
          target: { x: 195, y: 52 },
          text: 'Łódź café',
          delayMs: 2,
        },
        {
          action: 'type',
          text: 'naïve résumé',
          delayMs: 3,
        },
      ]);
      assert.equal(
        world.adbCalls.some(
          (call) => call[0] === 'shell' && call[1] === 'input' && call[2] === 'text',
        ),
        false,
        JSON.stringify(world.adbCalls),
      );
    },
  );
});

test('Provider-backed integration Android touch provider handles multi-touch gestures', async () => {
  await withProviderScenarioResource(
    async () => await createAndroidSettingsWorld(),
    async (world) => {
      const client = world.daemon.client();
      await client.apps.open({ app: 'settings', ...world.selection });

      await client.interactions.longPress({
        x: 195,
        y: 320,
        durationMs: 750,
        ...world.selection,
      });

      await client.interactions.scroll({
        direction: 'down',
        pixels: 120,
        durationMs: 350,
        ...world.selection,
      });

      await client.interactions.pan({
        x: 340,
        y: 400,
        dx: -280,
        dy: 0,
        durationMs: 300,
        ...world.selection,
      });

      const oneFingerPan = await client.interactions.pan({
        x: 195,
        y: 320,
        dx: 20,
        dy: 0,
        durationMs: 500,
        ...world.selection,
      });
      assert.equal(oneFingerPan.pointerCount, 1);
      assert.equal(world.daemon.session()?.actions.at(-1)?.flags.pointerCount, undefined);

      const twoFingerPan = await client.interactions.pan({
        x: 195,
        y: 320,
        dx: 40,
        dy: -20,
        pointerCount: 2,
        durationMs: 500,
        ...world.selection,
      });
      assert.equal(twoFingerPan.pointerCount, 2);
      assert.equal(twoFingerPan.backend, 'provider-native-touch');
      assert.equal(world.daemon.session()?.actions.at(-1)?.flags.pointerCount, 2);

      const pinch = await client.interactions.pinch({
        scale: 2,
        x: 195,
        y: 320,
        ...world.selection,
      });
      assert.equal(pinch.kind, 'pinch');
      assert.equal(pinch.pointerCount, 2);
      assert.equal(pinch.backend, 'provider-native-touch');

      const rotate = await client.interactions.rotateGesture({
        degrees: 145,
        x: 195,
        y: 320,
        ...world.selection,
      });
      assert.equal(rotate.kind, 'rotate');
      assert.equal(rotate.pointerCount, 2);
      assert.equal(rotate.backend, 'provider-native-touch');

      const transform = await client.interactions.transformGesture({
        x: 195,
        y: 320,
        dx: 40,
        dy: -20,
        scale: 1.5,
        degrees: 35,
        durationMs: 700,
        ...world.selection,
      });
      assert.equal(transform.kind, 'transform');
      assert.equal(transform.pointerCount, 2);
      assert.equal(transform.backend, 'provider-native-touch');

      const touchCalls = world.touchInjectionCalls.map((plan) => ({
        topology: plan.topology,
        intent: plan.intent,
        pointerCount: plan.pointers.length,
        durationMs: plan.durationMs,
      }));
      assert.deepEqual(touchCalls, [
        { topology: 'single', intent: 'longPress', pointerCount: 1, durationMs: 750 },
        { topology: 'single', intent: 'pan', pointerCount: 1, durationMs: 350 },
        { topology: 'single', intent: 'pan', pointerCount: 1, durationMs: 300 },
        { topology: 'single', intent: 'pan', pointerCount: 1, durationMs: 500 },
        { topology: 'two', intent: 'pan', pointerCount: 2, durationMs: 500 },
        { topology: 'two', intent: 'pinch', pointerCount: 2, durationMs: 300 },
        { topology: 'two', intent: 'rotate', pointerCount: 2, durationMs: 784 },
        { topology: 'two', intent: 'transform', pointerCount: 2, durationMs: 700 },
      ]);
      assert.equal(world.gestureViewportCalls, 8);
    },
  );
});

test('Provider-backed integration Android alert handles runtime permission dialog', async () => {
  await withProviderScenarioResource(
    async () => await createAndroidSettingsWorld({ snapshotXml: androidRuntimePermissionXml }),
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
  await withProviderScenarioResource(
    async () => await createAndroidSettingsWorld({ snapshotXml: androidNativeAlertXml }),
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
    async () => await createAndroidSettingsWorld({ snapshotXml: androidSystemDialogXml }),
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

test('Provider-backed integration Android app-owned ANR recovers before action commands', async () => {
  let anrFocused = true;
  await withProviderScenarioResource(
    async () =>
      await createAndroidSettingsWorld({
        snapshotXml: () => (anrFocused ? androidSystemDialogXml() : androidAppOwnedSheetXml()),
        dumpsysWindow: () =>
          anrFocused
            ? 'mCurrentFocus=Window{7f8 u0 Application Not Responding: com.example.demo}\n'
            : 'mCurrentFocus=Window{42 u0 com.example.demo/.MainActivity}\n',
        onAdbExec: (args) => {
          if (args[0] === 'shell' && args[1] === 'input' && args[2] === 'tap' && anrFocused) {
            anrFocused = false;
          }
        },
      }),
    async (world) => {
      const client = world.daemon.client();
      await client.apps.open({ app: 'com.example.demo', ...world.selection });

      const press = await world.daemon.callCommand('press', ['50', '60'], world.selection);
      if (press.json?.error) {
        assert.fail(JSON.stringify({ response: press.json, adbCalls: world.adbCalls }, null, 2));
      }
      const pressData = assertRpcOk(press);

      assert.equal(pressData.x, 50);
      assert.equal(pressData.y, 60);
      assert.match(String(pressData.warning ?? ''), /Recovered Android app ANR before press/);
      assertCommandCall(world.adbCalls, ['shell', 'input', 'tap', '116', '638']);
      assertCommandCall(world.adbCalls, ['shell', 'input', 'tap', '50', '60']);
      assert.ok(
        world.adbCalls.filter((call) => call.slice(0, 4).join(' ') === 'shell am start -W')
          .length >= 2,
        JSON.stringify(world.adbCalls),
      );
    },
  );
});

test('Provider-backed integration Android external ANR fails with actionable context', async () => {
  await withProviderScenarioResource(
    async () =>
      await createAndroidSettingsWorld({
        snapshotXml: androidSystemDialogXml,
        dumpsysWindow: () =>
          'mCurrentFocus=Window{7f8 u0 Application Not Responding: com.android.systemui}\n',
      }),
    async (world) => {
      const client = world.daemon.client();
      await client.apps.open({ app: 'com.example.demo', ...world.selection });

      const openCalls = world.adbCalls.filter(
        (call) => call.slice(0, 4).join(' ') === 'shell am start -W',
      ).length;
      const press = await world.daemon.callCommand('press', ['50', '60'], world.selection);
      const error = assertRpcError(press, 'COMMAND_FAILED', /com\.android\.systemui/);
      const details = error.details as Record<string, unknown>;

      assert.equal(details.focusedPackage, 'com.android.systemui');
      assert.equal(details.expectedPackage, 'com.example.demo');
      assert.equal(
        world.adbCalls.some((call) => call.join(' ') === 'shell input tap 116 638'),
        false,
        JSON.stringify(world.adbCalls),
      );
      assert.equal(
        world.adbCalls.filter((call) => call.slice(0, 4).join(' ') === 'shell am start -W').length,
        openCalls,
      );
    },
  );
});

test('Provider-backed integration Android alert dismiss falls back to Back without a dismiss button', async () => {
  await withProviderScenarioResource(
    async () => await createAndroidSettingsWorld({ snapshotXml: androidButtonlessAlertXml }),
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

async function runAndroidSetupAndInstallWorkflow(
  world: AndroidSettingsWorld,
  client: AgentDeviceClient,
): Promise<void> {
  const { daemon, apkPath, aabPath, manifestApkPath, selection, tempRoot } = world;

  const devices = await client.devices.list({ platform: 'android' });
  assert.equal(devices.length, 1);
  assert.equal(devices[0]?.platform, 'android');
  assert.equal(devices[0]?.id, PROVIDER_SCENARIO_ANDROID.id);
  assert.equal(devices[0]?.name, PROVIDER_SCENARIO_ANDROID.name);
  assert.equal(devices[0]?.target, PROVIDER_SCENARIO_ANDROID.target);
  assert.equal(devices[0]?.booted, true);

  const allowlistedDevices = await client.devices.list({
    platform: 'android',
    androidDeviceAllowlist: PROVIDER_SCENARIO_ANDROID.id,
  });
  assert.equal(allowlistedDevices.length, 1);
  assert.equal(allowlistedDevices[0]?.id, PROVIDER_SCENARIO_ANDROID.id);

  const boot = await client.devices.boot(selection);
  assert.equal(boot.platform, 'android');
  assert.equal(boot.id, PROVIDER_SCENARIO_ANDROID.id);
  assert.equal(boot.booted, true);

  const shutdown = await client.devices.shutdown(selection);
  assert.equal(shutdown.platform, 'android');
  assert.equal(shutdown.id, PROVIDER_SCENARIO_ANDROID.id);
  assert.equal((shutdown.shutdown as { success?: unknown } | undefined)?.success, true);

  const selectorTriggeredEvent = await client.apps.triggerEvent({
    event: 'pre_open_ping',
    payload: { stage: 'explicit-selector' },
    ...selection,
  });
  assert.equal(selectorTriggeredEvent.event, 'pre_open_ping');
  assert.equal(selectorTriggeredEvent.transport, 'deep-link');
  assert.equal(
    selectorTriggeredEvent.eventUrl,
    'demo://agent-device/event?name=pre_open_ping&payload=%7B%22stage%22%3A%22explicit-selector%22%7D&platform=android',
  );
  assert.equal(daemon.session(), undefined);

  const keyboardDismiss = await client.command.keyboard({ action: 'dismiss', ...selection });
  assert.equal(keyboardDismiss.platform, 'android');
  assert.equal(keyboardDismiss.action, 'dismiss');
  assert.equal(keyboardDismiss.visible, false);
  assert.equal(keyboardDismiss.dismissed, false);

  const open = await client.apps.open({ app: 'settings', ...selection });
  assert.equal(open.device?.id, PROVIDER_SCENARIO_ANDROID.id);

  const sessionBoot = await client.devices.boot();
  assert.equal(sessionBoot.platform, 'android');
  assert.equal(sessionBoot.id, PROVIDER_SCENARIO_ANDROID.id);
  assert.equal(sessionBoot.booted, true);

  const listedApps = await client.apps.list(selection);
  assert.deepEqual(listedApps, ['Demo (com.example.demo)']);

  const rawListedApps = await world.daemon.callCommand('apps', [], selection);
  assert.deepEqual(rawListedApps.json.result.data.apps, ['Demo (com.example.demo)']);

  const allApps = await client.apps.list({ ...selection, appsFilter: 'all' });
  assert.deepEqual(allApps, ['Settings (com.android.settings)', 'Demo (com.example.demo)']);

  const appstate = await client.command.appState(selection);
  assert.equal(appstate.platform, 'android');
  assert.equal(appstate.package, 'com.android.settings');
  assert.equal(appstate.activity, '.Settings');

  const reinstall = await client.apps.reinstall({
    app: 'com.example.demo',
    appPath: apkPath,
    ...selection,
  });
  assert.equal(reinstall.platform, 'android');
  assert.equal(reinstall.appId, 'com.example.demo');
  assert.equal(path.basename(reinstall.appPath), 'Demo.apk');

  const reinstallBundle = await client.apps.reinstall({
    app: 'com.example.demo',
    appPath: aabPath,
    ...selection,
  });
  assert.equal(reinstallBundle.platform, 'android');
  assert.equal(reinstallBundle.appId, 'com.example.demo');
  assert.equal(path.basename(reinstallBundle.appPath), 'Demo.aab');

  const installFromManifest = await client.apps.installFromSource({
    source: { kind: 'path', path: manifestApkPath },
    retainPaths: true,
    retentionMs: 60_000,
    ...selection,
  });
  assert.equal(installFromManifest.packageName, 'io.example.demo_manifest');
  assert.equal(installFromManifest.appName, 'Manifest');
  assert.equal(installFromManifest.launchTarget, 'io.example.demo_manifest');
  assert.ok(installFromManifest.installablePath?.endsWith('ManifestDemo.apk'));
  assert.equal(typeof installFromManifest.materializationId, 'string');
  const releaseManifestInstall = await client.materializations.release({
    materializationId: String(installFromManifest.materializationId),
    ...selection,
  });
  assert.equal(releaseManifestInstall.released, true);

  const push = await client.apps.push({
    app: 'com.example.demo',
    payload: {
      action: 'com.example.demo.PUSH',
      extras: { message: 'hello', unread: 2, foreground: true },
    },
    ...selection,
  });
  assert.equal(push.platform, 'android');
  assert.equal(push.package, 'com.example.demo');
  assert.equal(push.action, 'com.example.demo.PUSH');
  assert.equal(push.extrasCount, 3);

  const pushPayloadPath = path.join(tempRoot, 'payload.json');
  fs.writeFileSync(
    pushPayloadPath,
    JSON.stringify({
      action: 'com.example.demo.FILE_PUSH',
      extras: { source: 'relative-file' },
    }),
    'utf8',
  );
  const filePush = await daemon.callCommand(
    'push',
    ['com.example.demo', './payload.json'],
    selection,
    {
      meta: { cwd: tempRoot },
    },
  );
  assert.equal(filePush.json.result.data.package, 'com.example.demo');
  assert.equal(filePush.json.result.data.action, 'com.example.demo.FILE_PUSH');
  assert.equal(filePush.json.result.data.extrasCount, 1);

  const bracePayloadPath = path.join(tempRoot, '{payload}.json');
  fs.writeFileSync(
    bracePayloadPath,
    JSON.stringify({
      action: 'com.example.demo.BRACE_PUSH',
      extras: { source: 'brace-file' },
    }),
    'utf8',
  );
  const braceFilePush = await daemon.callCommand(
    'push',
    ['com.example.demo', './{payload}.json'],
    selection,
    { meta: { cwd: tempRoot } },
  );
  assert.equal(braceFilePush.json.result.data.package, 'com.example.demo');
  assert.equal(braceFilePush.json.result.data.action, 'com.example.demo.BRACE_PUSH');
  assert.equal(braceFilePush.json.result.data.extrasCount, 1);

  const clipboard = await client.command.clipboard({ action: 'read', ...selection });
  if (clipboard.action !== 'read') throw new Error('expected clipboard read result');
  assert.equal(clipboard.text, 'hello');

  const clipboardWrite = await client.command.clipboard({
    action: 'write',
    text: 'android otp',
    ...selection,
  });
  if (clipboardWrite.action !== 'write') throw new Error('expected clipboard write result');
  assert.equal(clipboardWrite.textLength, 11);

  const clipboardAfterWrite = await client.command.clipboard({
    action: 'read',
    ...selection,
  });
  if (clipboardAfterWrite.action !== 'read') throw new Error('expected clipboard read result');
  assert.equal(clipboardAfterWrite.text, 'android otp');

  const keyboard = await client.command.keyboard({ action: 'status', ...selection });
  assert.equal(keyboard.visible, false);
}

function androidRuntimePermissionXml(): string {
  const packageName = 'com.google.android.permissioncontroller';
  return androidXml([
    rootNode(packageName),
    textNode(
      1,
      'Allow Demo to send you notifications?',
      'com.android.permissioncontroller:id/permission_message',
      packageName,
      '[24,300][366,352]',
    ),
    buttonNode(
      2,
      'Don’t allow',
      'com.android.permissioncontroller:id/permission_deny_button',
      '[52,612][180,664]',
      packageName,
    ),
    buttonNode(
      3,
      'Allow',
      'com.android.permissioncontroller:id/permission_allow_button',
      '[210,612][338,664]',
      packageName,
    ),
    '  </node>',
  ]);
}

function androidNativeAlertXml(): string {
  return androidDialogXml([
    textNode(2, 'Unsaved changes', 'android:id/alertTitle'),
    textNode(3, 'Leave without saving?', 'android:id/message'),
    buttonNode(4, 'Cancel', 'android:id/button2', '[52,612][180,664]'),
    buttonNode(5, 'Discard', 'android:id/button1', '[210,612][338,664]'),
  ]);
}

function androidSystemDialogXml(): string {
  const packageName = 'com.android.systemui';
  return androidXml([
    rootNode(packageName),
    textNode(1, 'Demo isn&apos;t responding', 'android:id/alertTitle', packageName),
    textNode(2, 'Do you want to close it?', 'android:id/message', packageName),
    buttonNode(3, 'Close app', 'android:id/button2', '[52,612][180,664]', packageName),
    buttonNode(4, 'Wait', 'android:id/button1', '[210,612][338,664]', packageName),
    '  </node>',
  ]);
}

function androidButtonlessAlertXml(): string {
  return androidDialogXml([
    textNode(2, 'Unsaved changes', 'android:id/alertTitle'),
    textNode(3, 'Leave without saving?', 'android:id/message'),
  ]);
}

function androidAppOwnedSheetXml(): string {
  return androidXml([
    rootNode('com.example.demo', 'com.example.demo:id/root'),
    textNode(1, 'Choose an option', 'com.example.demo:id/title'),
    buttonNode(2, 'Allow', 'com.example.demo:id/allow_button', '[210,612][338,664]'),
    '  </node>',
  ]);
}

function androidDialogXml(children: string[]): string {
  return androidXml([
    rootNode(),
    androidNode({
      index: 1,
      id: 'android:id/parentPanel',
      type: 'android.app.AlertDialog',
      bounds: '[24,240][366,680]',
      selfClosing: false,
    }),
    ...children,
    '    </node>',
    '  </node>',
  ]);
}

function androidXml(body: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<hierarchy rotation="0">',
    ...body,
    '</hierarchy>',
  ].join('\n');
}

function rootNode(packageName = 'com.example.demo', id = 'android:id/content'): string {
  return androidNode({ index: 0, id, type: 'FrameLayout', packageName, selfClosing: false });
}

function textNode(
  index: number,
  text: string,
  id: string,
  packageName = 'com.example.demo',
  bounds?: string,
): string {
  return androidNode({ index, text, id, packageName, ...(bounds ? { bounds } : {}) });
}

function buttonNode(
  index: number,
  text: string,
  id: string,
  bounds: string,
  packageName = 'com.example.demo',
): string {
  return androidNode({ index, text, id, type: 'Button', packageName, bounds, clickable: true });
}

function androidNode(options: {
  index: number;
  id: string;
  text?: string;
  type?: string;
  packageName?: string;
  bounds?: string;
  clickable?: boolean;
  selfClosing?: boolean;
}): string {
  const type = options.type ?? 'TextView';
  const className = type.includes('.') ? type : `android.widget.${type}`;
  const tagEnd = options.selfClosing === false ? '>' : ' />';
  return [
    `  <node index="${options.index}"`,
    `text="${options.text ?? ''}"`,
    `resource-id="${options.id}"`,
    `class="${className}"`,
    `package="${options.packageName ?? 'com.example.demo'}"`,
    'content-desc=""',
    `bounds="${options.bounds ?? '[48,340][342,392]'}"`,
    `clickable="${options.clickable ? 'true' : 'false'}"`,
    'enabled="true"',
    options.clickable ? 'focusable="true"' : '',
  ]
    .filter(Boolean)
    .join(' ')
    .concat(tagEnd);
}

async function runAndroidAppControlAndObservabilityWorkflow(
  world: AndroidSettingsWorld,
  client: AgentDeviceClient,
): Promise<void> {
  const { daemon, selection, spawnedLogcat } = world;

  await client.settings.update({ setting: 'appearance', state: 'dark', ...selection });
  await client.settings.update({
    setting: 'location',
    state: 'set',
    latitude: 37.3349,
    longitude: -122.009,
    ...selection,
  });
  await client.settings.update({ setting: 'fingerprint', state: 'match', ...selection });
  const demoOpen = await client.apps.open({
    app: 'com.example.demo',
    activity: 'com.example.demo/.MainActivity',
    relaunch: true,
    ...selection,
  });
  assert.equal(demoOpen.appBundleId, 'com.example.demo');
  const triggeredEvent = await client.apps.triggerEvent({
    event: 'screenshot_taken',
    payload: { source: 'provider-scenario', foreground: true },
    ...selection,
  });
  assert.equal(triggeredEvent.event, 'screenshot_taken');
  assert.equal(triggeredEvent.transport, 'deep-link');
  assert.equal(
    triggeredEvent.eventUrl,
    'demo://agent-device/event?name=screenshot_taken&payload=%7B%22source%22%3A%22provider-scenario%22%2C%22foreground%22%3Atrue%7D&platform=android',
  );
  const sessionAfterTriggeredEvent = daemon.session();
  assert.equal(sessionAfterTriggeredEvent?.appBundleId, 'com.example.demo');
  assert.ok(
    sessionAfterTriggeredEvent?.actions.some(
      (action) =>
        action.command === 'trigger-app-event' && action.positionals[0] === 'screenshot_taken',
    ),
    JSON.stringify(sessionAfterTriggeredEvent?.actions),
  );
  await client.settings.update({
    setting: 'permission',
    state: 'grant',
    permission: 'camera',
    ...selection,
  });

  const logsStart = await client.observability.logs({ action: 'start', ...selection });
  assert.equal(logsStart.started, true);

  const logsPath = await client.observability.logs({ action: 'path', ...selection });
  assert.equal(logsPath.active, true);
  assert.equal(logsPath.backend, 'android');
  assert.equal(typeof logsPath.path, 'string');
  const appLogPath = logsPath.path as string;
  await waitForFileContent(appLogPath, 'https://api.example.com/v1/login');

  fs.writeFileSync(appLogPath, 'before-restart', 'utf8');
  fs.writeFileSync(`${appLogPath}.1`, 'older', 'utf8');
  const logsRestart = await client.observability.logs({
    action: 'clear',
    restart: true,
    ...selection,
  });
  assert.equal(logsRestart.path, appLogPath);
  assert.equal(logsRestart.cleared, true);
  assert.equal(logsRestart.restarted, true);
  assert.equal(fs.existsSync(`${appLogPath}.1`), false);
  assert.ok(
    spawnedLogcat.some((child) => child.killed),
    'Expected logs clear --restart to stop the first scripted logcat stream',
  );
  await waitForFileContent(appLogPath, 'https://api.example.com/v1/login');

  const network = await client.observability.network({
    action: 'dump',
    limit: 5,
    include: 'all',
    ...selection,
  });
  assert.equal(network.active, true);
  assert.equal(network.backend, 'android');
  assert.equal(network.include, 'all');
  const networkEntries = Array.isArray(network.entries) ? network.entries : [];
  assert.equal(networkEntries.length, 1, JSON.stringify(network));
  const latestNetworkEntry = networkEntries[0] as Record<string, unknown>;
  assert.equal(latestNetworkEntry.method, 'POST');
  assert.equal(latestNetworkEntry.url, 'https://api.example.com/v1/login');
  assert.equal(latestNetworkEntry.status, 401);
  assert.equal(latestNetworkEntry.headers, '{"x-id":"abc"}');
  assert.equal(latestNetworkEntry.requestBody, '{"email":"test@example.com"}');
  assert.equal(latestNetworkEntry.responseBody, '{"error":"bad_credentials"}');

  const perf = await client.observability.perf(selection);
  assert.equal(perf.platform, 'android');
  assert.equal(perf.deviceId, PROVIDER_SCENARIO_ANDROID.id);
  const metrics = perf.metrics as Record<string, any>;
  assert.equal(metrics.startup?.available, true, JSON.stringify(perf));
  assert.equal(metrics.startup?.method, 'open-command-roundtrip');
  assert.ok(metrics.startup?.sampleCount >= 2, JSON.stringify(metrics.startup));
  const startupSamples = Array.isArray(metrics.startup?.samples) ? metrics.startup.samples : [];
  assert.equal(startupSamples.at(-1)?.appTarget, 'com.example.demo');
  assert.equal(startupSamples.at(-1)?.appBundleId, 'com.example.demo');
  assert.equal(metrics.memory?.available, true, JSON.stringify(perf));
  assert.equal(metrics.memory?.totalPssKb, 216524);
  assert.equal(metrics.memory?.totalRssKb, 340112);
  assert.equal(metrics.cpu?.available, true, JSON.stringify(perf));
  assert.equal(metrics.cpu?.usagePercent, 9);
  assert.deepEqual(metrics.cpu?.matchedProcesses, ['com.example.demo', 'com.example.demo:sync']);
  assert.equal(metrics.fps?.available, true, JSON.stringify(perf));
  assert.equal(metrics.fps?.droppedFramePercent, 25);
  const relatedActions = Array.isArray(metrics.fps?.relatedActions)
    ? metrics.fps.relatedActions
    : [];
  assert.ok(
    relatedActions.some(
      (action: Record<string, unknown>) =>
        action.command === 'open' && action.target === 'com.example.demo',
    ),
    JSON.stringify(metrics.fps),
  );

  const explicitMetrics = await client.observability.perf({ area: 'metrics', ...selection });
  assert.deepEqual(Object.keys(explicitMetrics.metrics as Record<string, unknown>).sort(), [
    'cpu',
    'fps',
    'memory',
    'startup',
  ]);

  const memorySample = await client.observability.perf({
    area: 'memory',
    action: 'sample',
    ...selection,
  });
  const memoryMetrics = memorySample.metrics as Record<string, any>;
  assert.deepEqual(Object.keys(memoryMetrics), ['memory']);
  assert.equal(memoryMetrics.memory?.available, true, JSON.stringify(memorySample));
  assert.equal(memoryMetrics.memory?.totalPssKb, 216524);
  assert.deepEqual(Object.keys(memorySample.sampling as Record<string, unknown>).sort(), [
    'memory',
    'snapshot',
  ]);

  const heapPath = path.join(world.tempRoot, 'demo.hprof');
  const memorySnapshot = await client.observability.perf({
    area: 'memory',
    action: 'snapshot',
    kind: 'android-hprof',
    out: heapPath,
    ...selection,
  });
  const heapArtifact = memorySnapshot.artifact as Record<string, any>;
  assert.equal(heapArtifact.available, true, JSON.stringify(memorySnapshot));
  assert.equal(heapArtifact.kind, 'android-hprof');
  assert.equal(heapArtifact.path, heapPath);
  assert.equal(heapArtifact.sizeBytes, 'provider-hprof-bytes'.length);
  assert.equal(fs.existsSync(heapPath), true);
  assertCommandCall(world.adbCalls, ['shell', 'pidof', 'com.example.demo']);
  assert.ok(
    world.adbCalls.some(
      (call) => call.slice(0, 4).join(' ') === 'shell am dumpheap com.example.demo',
    ),
    JSON.stringify(world.adbCalls),
  );
  assert.ok(
    world.adbCalls.some((call) => call[0] === 'pull' && call[2] === heapPath),
    JSON.stringify(world.adbCalls),
  );
  assert.ok(
    world.adbCalls.some((call) => call.slice(0, 3).join(' ') === 'shell rm -f'),
    JSON.stringify(world.adbCalls),
  );

  const frameCallStart = world.adbCalls.length;
  const frames = await client.observability.perf({
    area: 'frames',
    action: 'sample',
    ...selection,
  });
  const frameMetrics = frames.metrics as Record<string, any>;
  assert.deepEqual(Object.keys(frameMetrics), ['fps']);
  assert.equal(frameMetrics.fps?.available, true, JSON.stringify(frames));
  assert.equal(frameMetrics.fps?.droppedFramePercent, 25);
  assert.deepEqual(Object.keys(frames.sampling as Record<string, unknown>), ['fps']);
  assert.deepEqual(world.adbCalls.slice(frameCallStart), [
    ['shell', 'dumpsys', 'gfxinfo', 'com.example.demo', 'framestats'],
    ['shell', 'dumpsys', 'gfxinfo', 'com.example.demo', 'reset'],
  ]);

  const invalidPerfAction = await world.daemon.callCommand('perf', ['metrics', 'poll'], {
    platform: 'android',
    serial: PROVIDER_SCENARIO_ANDROID.id,
  });
  assertRpcError(invalidPerfAction, 'INVALID_ARGS', /perf action must be sample/i);

  const logsStop = await client.observability.logs({ action: 'stop', ...selection });
  assert.equal(logsStop.stopped, true);

  fs.writeFileSync(appLogPath, 'before-clear', 'utf8');
  fs.writeFileSync(`${appLogPath}.1`, 'older', 'utf8');
  const logsClear = await client.observability.logs({ action: 'clear', ...selection });
  assert.equal(logsClear.path, appLogPath);
  assert.equal(logsClear.cleared, true);
  assert.equal(fs.readFileSync(appLogPath, 'utf8'), '');
  assert.equal(fs.existsSync(`${appLogPath}.1`), false);

  const animations = await client.settings.update({
    setting: 'animations',
    state: 'off',
    ...selection,
  });
  assert.equal(animations.scale, '0');
  assert.deepEqual(animations.keys, [
    'window_animation_scale',
    'transition_animation_scale',
    'animator_duration_scale',
  ]);
  await client.apps.open({ app: 'settings', ...selection });

  const logsDoctor = await client.observability.logs({ action: 'doctor', ...selection });
  assert.equal((logsDoctor.checks as { adbAvailable?: boolean }).adbAvailable, true);
}

async function runAndroidCaptureInteractionAndReplayWorkflow(
  world: AndroidSettingsWorld,
  client: AgentDeviceClient,
): Promise<void> {
  const { daemon, selection, tempRoot } = world;
  const screenshotPath = createProviderScenarioTempPath(
    'agent-device-provider-scenario-android',
    'png',
  );
  const fastScreenshotPath = createProviderScenarioTempPath(
    'agent-device-provider-scenario-android-fast',
    'png',
  );

  const baselineDiff = await client.capture.diff({
    kind: 'snapshot',
    interactiveOnly: true,
    ...selection,
  });
  assert.equal(baselineDiff.mode, 'snapshot');
  assert.equal(baselineDiff.baselineInitialized, true);
  assert.deepEqual(baselineDiff.summary, { additions: 0, removals: 0, unchanged: 3 });
  assert.deepEqual(baselineDiff.lines, []);

  const snapshot = await client.capture.snapshot({
    interactiveOnly: true,
    ...selection,
  });
  const apps = snapshot.nodes.find((node) => node.label === 'Apps');
  const search = snapshot.nodes.find((node) => node.label === 'Search');
  assert.ok(apps, JSON.stringify(snapshot.nodes));
  assert.ok(search, JSON.stringify(snapshot.nodes));
  assert.equal(apps.ref, 'e2', JSON.stringify(snapshot.nodes));
  assert.equal(search.ref, 'e3', JSON.stringify(snapshot.nodes));

  const reactNativeDismiss = await daemon.callCommand('react-native', ['dismiss-overlay'], {
    ...selection,
  });
  assert.equal(reactNativeDismiss.statusCode, 200, JSON.stringify(reactNativeDismiss.json));
  assert.equal(reactNativeDismiss.json?.result?.data?.detected, false);
  assert.equal(reactNativeDismiss.json?.result?.data?.dismissed, false);

  const rawSnapshot = await daemon.callCommand('snapshot', [], {
    snapshotRaw: true,
    ...selection,
  });
  assert.equal(rawSnapshot.statusCode, 200, JSON.stringify(rawSnapshot.json));
  assert.equal(rawSnapshot.json?.result?.data?.nodes?.[0]?.type, 'android.widget.ScrollView');

  const diff = await client.capture.diff({
    kind: 'snapshot',
    interactiveOnly: true,
    ...selection,
  });
  assert.equal(diff.mode, 'snapshot');
  assert.equal(diff.baselineInitialized, false);
  assert.deepEqual(diff.summary, { additions: 0, removals: 0, unchanged: 3 });

  const rotate = await client.command.orientation({
    orientation: 'landscape-left',
    ...selection,
  });
  assert.equal(rotate.action, 'orientation');
  assert.equal(rotate.orientation, 'landscape-left');

  const appSwitcher = await client.command.appSwitcher(selection);
  assert.equal(appSwitcher.action, 'app-switcher');

  // ADR 0014: rotate + app-switcher expired the frame, so re-observe before
  // acting through a ref again (the mock re-captures the same tree).
  await client.capture.snapshot({ interactiveOnly: true, ...selection });
  const press = await client.interactions.press({ ref: `@${apps.ref}`, ...selection });
  assert.equal(press.x, 88);
  assert.equal(press.y, 151);

  const heldPress = await client.interactions.press({
    x: 30,
    y: 40,
    count: 2,
    holdMs: 5,
    jitterPx: 1,
    ...selection,
  });
  assert.equal(heldPress.count, 2);
  assert.equal(heldPress.holdMs, 5);
  assert.equal(heldPress.jitterPx, 1);

  // ADR 0014: the press + held coordinate press expired the frame — re-observe.
  await client.capture.snapshot({ interactiveOnly: true, ...selection });
  const click = await client.interactions.click({ ref: `@${apps.ref}`, ...selection });
  assert.equal(click.x, 88);
  assert.equal(click.y, 151);

  const unrecordedPress = await daemon.callCommand('press', ['50', '60'], {
    ...selection,
    noRecord: true,
  });
  assert.equal(unrecordedPress.json?.result?.data?.x, 50);
  assert.equal(
    daemon
      .session()
      ?.actions.some(
        (action) =>
          action.command === 'press' &&
          action.positionals[0] === '50' &&
          action.positionals[1] === '60',
      ),
    false,
  );

  // ADR 0014: the ref click expired the frame — re-observe before filling.
  await client.capture.snapshot({ interactiveOnly: true, ...selection });
  const fill = await client.interactions.fill({
    ref: `@${search.ref}`,
    text: 'Display',
    ...selection,
  });
  assert.equal(fill.text, 'Display');

  const getText = await client.interactions.get({
    format: 'text',
    selector: 'id=com.android.settings:id/search',
    ...selection,
  });
  assert.equal(getText.text, 'Display');

  const isVisible = await client.interactions.is({
    predicate: 'visible',
    selector: 'label=Apps',
    ...selection,
  });
  assert.equal(isVisible.pass, true);

  const waitText = await client.command.wait({ text: 'Apps', timeoutMs: 100, ...selection });
  assert.equal(waitText.text, 'Apps');

  const swipe = await client.interactions.swipe({
    from: { x: 20, y: 200 },
    to: { x: 20, y: 100 },
    count: 2,
    pauseMs: 1,
    pattern: 'ping-pong',
    ...selection,
  });
  assert.deepEqual(swipe.from, { x: 20, y: 200 });
  assert.deepEqual(swipe.to, { x: 20, y: 100 });
  assert.equal(swipe.x1, 20);
  assert.equal(swipe.y1, 200);
  assert.equal(swipe.x2, 20);
  assert.equal(swipe.y2, 100);
  assert.equal(swipe.durationMs, 100);
  assert.equal(swipe.effectiveDurationMs, 100);
  assert.equal(swipe.timingMode, 'direct');
  assert.equal(swipe.count, 2);
  assert.equal(swipe.pauseMs, 1);
  assert.equal(swipe.pattern, 'ping-pong');

  const pan = await client.interactions.pan({
    x: 100,
    y: 200,
    dx: 50,
    dy: -20,
    durationMs: 400,
    ...selection,
  });
  assert.equal(pan.kind, 'pan');
  assert.equal(pan.pointerCount, 1);
  assert.deepEqual(pan.from, { x: 100, y: 200 });
  assert.deepEqual(pan.to, { x: 150, y: 180 });
  assert.equal(pan.durationMs, 400);

  const fling = await client.interactions.fling({
    direction: 'right',
    x: 100,
    y: 200,
    distance: 180,
    ...selection,
  });
  assert.equal(fling.kind, 'fling');
  assert.equal(fling.pointerCount, 1);
  assert.deepEqual(fling.from, { x: 100, y: 200 });
  assert.deepEqual(fling.to, { x: 280, y: 200 });
  assert.equal(fling.durationMs, 100);

  const batch = await client.batch.run({
    steps: [
      {
        command: 'press',
        input: { target: { kind: 'point', x: 10, y: 20 }, count: 2, intervalMs: 1 },
      },
    ],
    onError: 'stop',
    maxSteps: 1,
    ...selection,
  });
  assert.equal(batch.executed, 1);
  assert.equal(batch.results[0]?.data.count, 2);

  const replayPath = path.join(tempRoot, 'settings-search.ad');
  fs.writeFileSync(
    replayPath,
    [
      'snapshot -i',
      'press @e2 Apps --count 2 --interval-ms 1',
      // ADR 0014: the ref press expired the frame, so the script re-observes
      // before mutating through another ref (a legacy multi-ref-from-one-snapshot
      // script would now fail closed).
      'snapshot -i',
      'fill @e3 Search "Network"',
      'get text @e3 Search',
      '',
    ].join('\n'),
  );
  const updateReplay = await client.replay.run({
    path: replayPath,
    update: true,
    ...selection,
  });
  assert.equal(updateReplay.replayed, 5);
  assert.equal(updateReplay.healed, 0);

  const replayEnvPath = path.join(tempRoot, 'settings-env.ad');
  fs.writeFileSync(
    replayEnvPath,
    ['snapshot -i', 'press @e2 "${APP_LABEL}"', 'get text @e3 Search', ''].join('\n'),
  );
  const replayEnv = await client.replay.run({
    path: replayEnvPath,
    env: ['APP_LABEL=Apps'],
    ...selection,
  });
  assert.equal(replayEnv.replayed, 3);

  // ADR 0012 step 5: replay resume. A full run diverges at step 2 (a
  // selector matching nothing); the report's resume object carries the plan
  // digest. Resuming at the next index after the failed step (the documented
  // "completed the failed action manually" loop) skips steps 1-2 without
  // executing them and replays only the tail.
  const resumePath = path.join(tempRoot, 'settings-resume.ad');
  fs.writeFileSync(
    resumePath,
    ['snapshot -i', 'press label="NoSuchControl"', 'get text @e3 Search', ''].join('\n'),
  );
  const divergenceError = await client.replay.run({ path: resumePath, ...selection }).then(
    () => null,
    (error: unknown) => error as { code?: string; details?: Record<string, unknown> },
  );
  assert.ok(divergenceError, 'expected the replay to diverge on the missing selector');
  assert.equal(divergenceError.code, 'REPLAY_DIVERGENCE');
  const divergenceReport = divergenceError.details?.divergence as {
    resume: { allowed: boolean; from: number; planDigest: string };
  };
  assert.equal(divergenceReport.resume.allowed, true);
  assert.equal(divergenceReport.resume.from, 2);
  assert.match(divergenceReport.resume.planDigest, /^[0-9a-f]{64}$/);
  const resumedReplay = await client.replay.run({
    path: resumePath,
    resumeFrom: divergenceReport.resume.from + 1,
    resumePlanDigest: divergenceReport.resume.planDigest,
    ...selection,
  });
  assert.equal(resumedReplay.replayed, 1);

  const screenshot = await client.capture.screenshot({
    path: screenshotPath,
    ...selection,
  });
  assert.equal(screenshot.path, screenshotPath);
  assertPngFile(screenshotPath);

  const fastScreenshot = await client.capture.screenshot({
    path: fastScreenshotPath,
    overlayRefs: true,
    stabilize: false,
    ...selection,
  });
  assert.equal(fastScreenshot.path, fastScreenshotPath);
  assert.ok(
    fastScreenshot.overlayRefs && fastScreenshot.overlayRefs.length > 0,
    JSON.stringify(fastScreenshot),
  );
  assertPngFile(fastScreenshotPath);

  const screenshotOutPath = path.join(tempRoot, 'screenshot-out-flag.png');
  const screenshotWithOut = await daemon.callCommand('screenshot', [], {
    out: screenshotOutPath,
    ...selection,
  });
  assert.equal(screenshotWithOut.statusCode, 200, JSON.stringify(screenshotWithOut.json));
  assert.equal(screenshotWithOut.json?.result?.data?.path, screenshotOutPath);
  assertPngFile(screenshotOutPath);

  const beforeCloseOpen = await client.apps.open({ app: 'com.example.demo', ...selection });
  assert.equal(beforeCloseOpen.appBundleId, 'com.example.demo');
  const logsBeforeClose = await client.observability.logs({ action: 'start', ...selection });
  assert.equal(logsBeforeClose.started, true);
  const savedReplayPath = path.join(tempRoot, 'saved-session.ad');
  const close = await daemon.callCommand('close', [], {
    saveScript: savedReplayPath,
    shutdown: true,
  });
  assert.equal(close.json?.result?.data?.shutdown?.success, true);
  assert.equal(fs.existsSync(savedReplayPath), true);
  assert.equal(daemon.session(), undefined);

  const testReplayPath = path.join(tempRoot, 'settings-smoke.ad');
  fs.writeFileSync(
    testReplayPath,
    ['context platform=android', 'open settings', 'snapshot -i', 'is visible label=Apps', ''].join(
      '\n',
    ),
  );
  const testSuite = await client.replay.test({
    paths: [testReplayPath],
    artifactsDir: path.join(tempRoot, 'artifacts'),
    ...selection,
  });
  assert.equal(testSuite.total, 1);
  assert.equal(testSuite.passed, 1, JSON.stringify(testSuite));
  assert.equal(testSuite.failed, 0, JSON.stringify(testSuite));
}

function assertAndroidProviderContract(world: AndroidSettingsWorld): void {
  assertAndroidInventoryContract(world);
  assertAndroidInstallAndLaunchContract(world);
  assertAndroidPushAndEventContract(world);
  assertAndroidObservabilityContract(world);
  assertAndroidSettingsContract(world);
  assertAndroidInteractionContract(world);
  assertAndroidShutdownContract(world);
}

function assertAndroidInventoryContract(world: AndroidSettingsWorld): void {
  assert.ok(
    world.inventoryRequests.some((request) =>
      request.androidSerialAllowlist?.includes(PROVIDER_SCENARIO_ANDROID.id),
    ),
    JSON.stringify(world.inventoryRequests),
  );
}

function assertAndroidInstallAndLaunchContract(world: AndroidSettingsWorld): void {
  const { adbCalls, apkInstallCalls, bundleInstallCalls } = world;
  const appApkInstallCalls = apkInstallCalls.filter((call) =>
    ['Demo.apk', 'ManifestDemo.apk'].includes(path.basename(call.apkPath)),
  );
  assertCommandCall(adbCalls, ['shell', 'am', 'start', '-W', '-a', 'android.settings.SETTINGS']);
  assertCommandCall(adbCalls, ['shell', 'am', 'force-stop', 'com.example.demo']);
  assertCommandCall(adbCalls, [
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.MAIN',
    '-c',
    'android.intent.category.DEFAULT',
    '-c',
    'android.intent.category.LAUNCHER',
    '-n',
    'com.example.demo/.MainActivity',
  ]);
  assertCommandCall(adbCalls, ['uninstall', 'com.example.demo']);
  assert.equal(appApkInstallCalls.length, 2);
  assert.equal(path.basename(appApkInstallCalls[0]?.apkPath ?? ''), 'Demo.apk');
  assert.equal(appApkInstallCalls[0]?.replace, true);
  assert.equal(path.basename(appApkInstallCalls[1]?.apkPath ?? ''), 'ManifestDemo.apk');
  assert.equal(appApkInstallCalls[1]?.replace, true);
  assert.deepEqual(bundleInstallCalls, [{ bundlePath: world.aabPath, mode: 'universal' }]);
}

function assertAndroidPushAndEventContract(world: AndroidSettingsWorld): void {
  const { adbCalls } = world;
  assertCommandCall(adbCalls, [
    'shell',
    'am',
    'broadcast',
    '-a',
    'com.example.demo.PUSH',
    '-p',
    'com.example.demo',
    '--es',
    'message',
    'hello',
    '--ei',
    'unread',
    '2',
    '--ez',
    'foreground',
    'true',
  ]);
  assertCommandCall(adbCalls, [
    'shell',
    'am',
    'broadcast',
    '-a',
    'com.example.demo.FILE_PUSH',
    '-p',
    'com.example.demo',
    '--es',
    'source',
    'relative-file',
  ]);
  assertCommandCall(adbCalls, [
    'shell',
    'am',
    'broadcast',
    '-a',
    'com.example.demo.BRACE_PUSH',
    '-p',
    'com.example.demo',
    '--es',
    'source',
    'brace-file',
  ]);
  assertCommandCall(adbCalls, [
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    'demo://agent-device/event?name=pre_open_ping&payload=%7B%22stage%22%3A%22explicit-selector%22%7D&platform=android',
  ]);
  assertCommandCall(adbCalls, [
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    'demo://agent-device/event?name=screenshot_taken&payload=%7B%22source%22%3A%22provider-scenario%22%2C%22foreground%22%3Atrue%7D&platform=android',
    '-p',
    'com.example.demo',
  ]);
  assertCommandCall(adbCalls, ['shell', 'cmd', 'clipboard', 'get', 'text']);
  assertCommandCall(adbCalls, ['shell', 'cmd', 'clipboard', 'set', 'text', 'android otp']);
  assertCommandCall(adbCalls, ['shell', 'dumpsys', 'input_method']);
}

function assertAndroidObservabilityContract(world: AndroidSettingsWorld): void {
  const { adbCalls, spawnedLogcat } = world;
  assertCommandCall(adbCalls, ['shell', 'pidof', 'com.example.demo']);
  assertCommandCall(adbCalls, ['shell', 'dumpsys', 'meminfo', 'com.example.demo']);
  assertCommandCall(adbCalls, ['shell', 'dumpsys', 'cpuinfo']);
  assertCommandCall(adbCalls, ['shell', 'dumpsys', 'gfxinfo', 'com.example.demo', 'framestats']);
  assertCommandCall(adbCalls, ['shell', 'dumpsys', 'gfxinfo', 'com.example.demo', 'reset']);
  assert.ok(
    spawnedLogcat.some((child) => child.killed),
    'Expected logs stop to terminate the scripted logcat stream',
  );
  assert.ok(
    spawnedLogcat.filter((child) => child.killed).length >= 2,
    'Expected close to auto-stop the active scripted logcat stream',
  );
}

function assertAndroidSettingsContract(world: AndroidSettingsWorld): void {
  const { adbCalls } = world;
  assertCommandCall(adbCalls, ['shell', 'cmd', 'uimode', 'night', 'yes']);
  assertCommandCall(adbCalls, ['emu', 'geo', 'fix', '-122.009', '37.3349']);
  assertCommandCall(adbCalls, ['shell', 'cmd', 'fingerprint', 'touch', '1']);
  assertCommandCall(adbCalls, [
    'shell',
    'pm',
    'grant',
    'com.example.demo',
    'android.permission.CAMERA',
  ]);
  assertCommandCall(adbCalls, [
    'shell',
    'settings',
    'put',
    'global',
    'window_animation_scale',
    '0',
  ]);
  assertCommandCall(adbCalls, [
    'shell',
    'settings',
    'put',
    'global',
    'transition_animation_scale',
    '0',
  ]);
  assertCommandCall(adbCalls, [
    'shell',
    'settings',
    'put',
    'global',
    'animator_duration_scale',
    '0',
  ]);
  assertCommandCall(adbCalls, ['shell', 'echo', 'ok']);
}

function assertAndroidInteractionContract(world: AndroidSettingsWorld): void {
  const { adbCalls } = world;
  assert.ok(
    adbCalls.some(
      (call) =>
        call[0] === 'shell' &&
        call[1] === 'am' &&
        call[2] === 'instrument' &&
        call.includes('com.callstack.agentdevice.snapshothelper/.SnapshotInstrumentation'),
    ),
    JSON.stringify(adbCalls),
  );
  assert.deepEqual(
    world.touchInjectionCalls.map((plan) => ({
      intent: plan.intent,
      durationMs: plan.durationMs,
    })),
    [
      { intent: 'longPress', durationMs: 5 },
      { intent: 'longPress', durationMs: 5 },
      { intent: 'fling', durationMs: 100 },
      { intent: 'fling', durationMs: 100 },
      { intent: 'pan', durationMs: 400 },
      { intent: 'fling', durationMs: 100 },
    ],
  );
  assertCommandCall(adbCalls, ['shell', 'input', 'tap', '88', '151']);
  assertCommandCall(adbCalls, [
    'shell',
    'settings',
    'put',
    'system',
    'accelerometer_rotation',
    '0',
  ]);
  assertCommandCall(adbCalls, ['shell', 'settings', 'put', 'system', 'user_rotation', '1']);
  assertCommandCall(adbCalls, ['shell', 'input', 'keyevent', '187']);
  assert.equal(
    adbCalls.filter((call) => arrayEqual(call, ['shell', 'input', 'tap', '10', '20'])).length,
    2,
  );
  assertCommandCall(adbCalls, ['shell', 'input', 'tap', '50', '60']);
  assert.equal(
    adbCalls.filter((call) => arrayEqual(call, ['shell', 'input', 'tap', '88', '151'])).length,
    5,
  );
  assertCommandCall(adbCalls, ['shell', 'input', 'text', 'Display']);
  assertCommandCall(adbCalls, ['shell', 'input', 'text', 'Network']);
  assert.equal(
    adbCalls.filter((call) => arrayEqual(call, ['exec-out', 'screencap', '-p'])).length,
    3,
  );
  assert.equal(
    adbCalls.filter((call) =>
      arrayEqual(call, ['shell', 'settings put global sysui_demo_allowed 1']),
    ).length,
    2,
  );
}

function assertAndroidShutdownContract(world: AndroidSettingsWorld): void {
  const { adbCalls } = world;
  assertCommandCall(adbCalls, ['emu', 'kill']);
  world.assertNoHostAdbCalls();
}
