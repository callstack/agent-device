import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { createAndroidSettingsWorld } from './android-world.ts';
import { withProviderScenarioResource } from './harness.ts';

test('Provider-backed integration Android replay test suite covers retries and fail-fast flags', async () => {
  await withProviderScenarioResource(createAndroidSettingsWorld, async (world) => {
    const client = world.daemon.client();
    const suiteRoot = path.join(world.tempRoot, 'suite-flags');
    fs.mkdirSync(suiteRoot, { recursive: true });

    const passingScript = path.join(suiteRoot, '01-pass.ad');
    fs.writeFileSync(
      passingScript,
      [
        'context platform=android',
        'open settings',
        'snapshot -i',
        'is visible label=Apps',
        '',
      ].join('\n'),
    );
    const passingSuite = await client.replay.test({
      paths: [passingScript],
      retries: 1,
      artifactsDir: path.join(suiteRoot, 'passing-artifacts'),
      ...world.selection,
    });
    assert.equal(passingSuite.total, 1, JSON.stringify(passingSuite));
    assert.equal(passingSuite.passed, 1, JSON.stringify(passingSuite));
    assert.equal(passingSuite.failed, 0, JSON.stringify(passingSuite));
    const passingTests = passingSuite.tests as Array<Record<string, unknown>>;
    assert.equal(passingTests[0]?.attempts, 1, JSON.stringify(passingSuite));

    const failFastRoot = path.join(suiteRoot, 'fail-fast');
    fs.mkdirSync(failFastRoot, { recursive: true });
    fs.writeFileSync(
      path.join(failFastRoot, '01-fail.ad'),
      [
        'context platform=android',
        'open settings',
        'snapshot -i',
        'is visible label=Missing',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(failFastRoot, '02-not-run.ad'),
      [
        'context platform=android',
        'open settings',
        'snapshot -i',
        'is visible label=Apps',
        '',
      ].join('\n'),
    );
    const failFastSuite = await client.replay.test({
      paths: [failFastRoot],
      failFast: true,
      artifactsDir: path.join(suiteRoot, 'fail-fast-artifacts'),
      ...world.selection,
    });
    assert.equal(failFastSuite.total, 2, JSON.stringify(failFastSuite));
    assert.equal(failFastSuite.executed, 1, JSON.stringify(failFastSuite));
    assert.equal(failFastSuite.failed, 1, JSON.stringify(failFastSuite));
    assert.equal(failFastSuite.notRun, 1, JSON.stringify(failFastSuite));
  });
});

test('Provider-backed integration Android Maestro replay uses fresh snapshots and authored swipe points', async () => {
  let snapshots = 0;
  await withProviderScenarioResource(
    async () =>
      await createAndroidSettingsWorld({
        snapshotXml: () => {
          snapshots += 1;
          return androidMaestroReplayXml(
            snapshots === 1 ? '[16,24][374,80]' : '[100,300][260,360]',
          );
        },
      }),
    async (world) => {
      const client = world.daemon.client();
      const suiteRoot = path.join(world.tempRoot, 'suite-maestro');
      fs.mkdirSync(suiteRoot, { recursive: true });
      const flowPath = path.join(suiteRoot, 'maestro-flow.yaml');
      fs.writeFileSync(
        flowPath,
        [
          'appId: com.android.settings',
          '---',
          '- launchApp',
          '- assertVisible:',
          '    id: android:id/title',
          '- tapOn: Search',
          '- swipe:',
          '    start: 90%, 50%',
          '    end: 10%, 50%',
          '    duration: 300',
          '',
        ].join('\n'),
      );

      const suite = await client.replay.test({
        paths: [flowPath],
        backend: 'maestro',
        artifactsDir: path.join(suiteRoot, 'artifacts'),
        timeoutMs: 30000,
        ...world.selection,
      });

      assert.equal(suite.total, 1, JSON.stringify(suite));
      assert.equal(suite.passed, 1, JSON.stringify(suite));
      assert.equal(suite.failed, 0, JSON.stringify(suite));
      assert.deepEqual(
        world.adbCalls.find((call) => call.slice(0, 3).join(' ') === 'shell input tap'),
        ['shell', 'input', 'tap', '180', '330'],
      );
      assert.deepEqual(
        world.adbCalls.find((call) => call.slice(0, 3).join(' ') === 'shell input swipe'),
        ['shell', 'input', 'swipe', '351', '300', '39', '300', '300'],
      );
      assertSnapshotCountInRange(snapshots, 2, 3);
    },
  );
});

test('Provider-backed integration Android Maestro replay test suite discovers YAML flows in directories', async () => {
  let snapshots = 0;
  await withProviderScenarioResource(
    async () =>
      await createAndroidSettingsWorld({
        snapshotXml: () => {
          snapshots += 1;
          return androidMaestroReplayXml('[100,300][260,360]');
        },
      }),
    async (world) => {
      const client = world.daemon.client();
      const suiteRoot = path.join(world.tempRoot, 'suite-maestro-directory');
      fs.mkdirSync(suiteRoot, { recursive: true });
      fs.writeFileSync(
        path.join(suiteRoot, '01-visible.yaml'),
        ['appId: com.android.settings', '---', '- launchApp', '- assertVisible: Apps', ''].join(
          '\n',
        ),
      );
      fs.writeFileSync(
        path.join(suiteRoot, '02-tap.yml'),
        ['appId: com.android.settings', '---', '- launchApp', '- tapOn: Search', ''].join('\n'),
      );

      const suite = await client.replay.test({
        paths: [suiteRoot],
        backend: 'maestro',
        artifactsDir: path.join(suiteRoot, 'artifacts'),
        timeoutMs: 30000,
        ...world.selection,
      });

      assert.equal(suite.total, 2, JSON.stringify(suite));
      assert.equal(suite.executed, 2, JSON.stringify(suite));
      assert.equal(suite.passed, 2, JSON.stringify(suite));
      assert.equal(suite.failed, 0, JSON.stringify(suite));
      assert.deepEqual(
        world.adbCalls.find((call) => call.slice(0, 3).join(' ') === 'shell input tap'),
        ['shell', 'input', 'tap', '180', '330'],
      );
      assert.equal(
        world.adbCalls.filter((call) => call.slice(0, 3).join(' ') === 'shell am force-stop')
          .length,
        2,
      );
      assertSnapshotCountInRange(snapshots, 2, 3);
    },
  );
});

test('Provider-backed integration Android Maestro types after tapOn inputText without trailing Enter', async () => {
  await withProviderScenarioResource(
    async () => await createAndroidSettingsWorld({ nativeTextInjection: true }),
    async (world) => {
      const client = world.daemon.client();
      const suiteRoot = path.join(world.tempRoot, 'suite-maestro-input');
      fs.mkdirSync(suiteRoot, { recursive: true });
      const flowPath = path.join(suiteRoot, 'input-only.yaml');
      fs.writeFileSync(
        flowPath,
        [
          'appId: com.android.settings',
          '---',
          '- launchApp',
          '- tapOn: Search',
          '- inputText: "Łódź café"',
          '',
        ].join('\n'),
      );

      const suite = await client.replay.test({
        paths: [flowPath],
        backend: 'maestro',
        artifactsDir: path.join(suiteRoot, 'artifacts'),
        timeoutMs: 30000,
        ...world.selection,
      });

      assert.equal(suite.total, 1, JSON.stringify(suite));
      assert.equal(suite.passed, 1, JSON.stringify(suite));
      assert.equal(suite.failed, 0, JSON.stringify(suite));
      assert.deepEqual(world.textInjectionCalls, [
        {
          action: 'type',
          text: 'Łódź café',
          delayMs: 0,
        },
      ]);
      assert.deepEqual(
        world.adbCalls.find((call) => call.slice(0, 3).join(' ') === 'shell input tap'),
        ['shell', 'input', 'tap', '195', '52'],
      );
      assert.equal(
        world.adbCalls.some(
          (call) => call[0] === 'shell' && call[1] === 'input' && call[2] === 'text',
        ),
        false,
        JSON.stringify(world.adbCalls),
      );
      assert.equal(
        world.adbCalls.some((call) => call.slice(0, 4).join(' ') === 'shell input keyevent ENTER'),
        false,
        JSON.stringify(world.adbCalls),
      );
      world.assertNoHostAdbCalls();
    },
  );
});

test('Provider-backed integration Android Maestro preserves pressKey Enter after native fill', async () => {
  await withProviderScenarioResource(
    async () => await createAndroidSettingsWorld({ nativeTextInjection: true }),
    async (world) => {
      const client = world.daemon.client();
      const suiteRoot = path.join(world.tempRoot, 'suite-maestro-input-submit');
      fs.mkdirSync(suiteRoot, { recursive: true });
      const flowPath = path.join(suiteRoot, 'input-submit.yaml');
      fs.writeFileSync(
        flowPath,
        [
          'appId: com.android.settings',
          '---',
          '- launchApp',
          '- tapOn: Search',
          '- inputText: "Łódź café"',
          '- pressKey: Enter',
          '',
        ].join('\n'),
      );

      const suite = await client.replay.test({
        paths: [flowPath],
        backend: 'maestro',
        artifactsDir: path.join(suiteRoot, 'artifacts'),
        timeoutMs: 30000,
        ...world.selection,
      });

      assert.equal(suite.total, 1, JSON.stringify(suite));
      assert.equal(suite.passed, 1, JSON.stringify(suite));
      assert.equal(suite.failed, 0, JSON.stringify(suite));
      assert.deepEqual(world.textInjectionCalls, [
        {
          action: 'fill',
          target: { x: 195, y: 52 },
          text: 'Łódź café',
          delayMs: 0,
        },
      ]);
      assert.equal(
        world.adbCalls.some(
          (call) => call[0] === 'shell' && call[1] === 'input' && call[2] === 'text',
        ),
        false,
        JSON.stringify(world.adbCalls),
      );
      assert.deepEqual(
        world.adbCalls.find((call) => call.slice(0, 4).join(' ') === 'shell input keyevent ENTER'),
        ['shell', 'input', 'keyevent', 'ENTER'],
      );
      world.assertNoHostAdbCalls();
    },
  );
});

test('Provider-backed integration Android Maestro executes runFlow conditions and retry batches at runtime', async () => {
  let snapshots = 0;
  await withProviderScenarioResource(
    async () =>
      await createAndroidSettingsWorld({
        snapshotXml: () => {
          snapshots += 1;
          return androidMaestroReplayXml('[100,300][260,360]');
        },
      }),
    async (world) => {
      const client = world.daemon.client();
      const suiteRoot = path.join(world.tempRoot, 'suite-maestro-runtime-flow');
      fs.mkdirSync(suiteRoot, { recursive: true });
      const flowPath = path.join(suiteRoot, 'runtime-flow.yaml');
      fs.writeFileSync(
        flowPath,
        [
          'appId: com.android.settings',
          '---',
          '- launchApp',
          '- runFlow:',
          '    when:',
          '      visible: Apps',
          '    commands:',
          '      - tapOn: Search',
          '- retry:',
          '    maxRetries: 1',
          '    commands:',
          '      - assertVisible: Apps',
          '',
        ].join('\n'),
      );

      const suite = await client.replay.test({
        paths: [flowPath],
        backend: 'maestro',
        artifactsDir: path.join(suiteRoot, 'artifacts'),
        timeoutMs: 30000,
        ...world.selection,
      });

      assert.equal(suite.total, 1, JSON.stringify(suite));
      assert.equal(suite.passed, 1, JSON.stringify(suite));
      assert.equal(suite.failed, 0, JSON.stringify(suite));
      assert.deepEqual(
        world.adbCalls.filter((call) => call.slice(0, 3).join(' ') === 'shell input tap'),
        [['shell', 'input', 'tap', '180', '330']],
      );
      assertSnapshotCountInRange(snapshots, 4, 5);
    },
  );
});

test('Provider-backed integration Android Maestro optional tap misses without touching the device', async () => {
  await withProviderScenarioResource(createAndroidSettingsWorld, async (world) => {
    const client = world.daemon.client();
    const suiteRoot = path.join(world.tempRoot, 'suite-maestro-optional');
    fs.mkdirSync(suiteRoot, { recursive: true });
    const flowPath = path.join(suiteRoot, 'optional-miss.yaml');
    fs.writeFileSync(
      flowPath,
      [
        'appId: com.android.settings',
        '---',
        '- launchApp',
        '- tapOn:',
        '    text: Missing target',
        '    optional: true',
        '- assertVisible: Apps',
        '',
      ].join('\n'),
    );

    const suite = await client.replay.test({
      paths: [flowPath],
      backend: 'maestro',
      artifactsDir: path.join(suiteRoot, 'artifacts'),
      timeoutMs: 30000,
      ...world.selection,
    });

    assert.equal(suite.total, 1, JSON.stringify(suite));
    assert.equal(suite.passed, 1, JSON.stringify(suite));
    assert.equal(suite.failed, 0, JSON.stringify(suite));
    assert.equal(
      world.adbCalls.some((call) => call.slice(0, 3).join(' ') === 'shell input tap'),
      false,
      JSON.stringify(world.adbCalls),
    );
  });
});

function androidMaestroReplayXml(searchBounds: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<hierarchy rotation="0">',
    '  <node index="0" text="" resource-id="com.android.settings:id/main_content_scrollable_container" class="android.widget.ScrollView" package="com.android.settings" content-desc="" bounds="[0,0][390,600]" clickable="false" enabled="true">',
    '    <node index="0" text="Apps" resource-id="android:id/title" class="android.widget.TextView" package="com.android.settings" content-desc="" bounds="[24,124][152,178]" clickable="true" enabled="true" focusable="true" focused="false" />',
    `    <node index="1" text="" resource-id="com.android.settings:id/search" class="android.widget.EditText" package="com.android.settings" content-desc="Search" bounds="${searchBounds}" clickable="true" enabled="true" focusable="true" focused="false" password="false" />`,
    '  </node>',
    '</hierarchy>',
  ].join('\n');
}

function assertSnapshotCountInRange(actual: number, min: number, max: number): void {
  assert.ok(actual >= min && actual <= max, `expected ${min}-${max} snapshots, got ${actual}`);
}
