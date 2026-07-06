import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import type { AppleRunnerProvider } from '../../../src/platforms/apple/core/runner/runner-provider.ts';
import type { RecordingProvider } from '../../../src/daemon/recording-provider.ts';
import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import { PROVIDER_SCENARIO_IOS_SIMULATOR, PROVIDER_SCENARIO_MACOS } from './fixtures.ts';
import {
  createProviderScenarioHarness,
  likelyPlayableMp4Container,
  type ProviderScenarioHarness,
  type ProviderScenarioRpcResult,
} from './harness.ts';
import { createRecordingAppleToolProvider, simctlListDevicesResult } from './providers.ts';

// ---------------------------------------------------------------------------
// Surface-wide guard: NO public command response may emit the internal `apple`
// platform token on the wire.
//
// The Platform collapse (#979/#1002) merged the Apple OS leaves into a single
// internal `platform: 'apple'`; approach (b) keeps the MACHINE OUTPUT emitting the
// public leaf strings (`ios`/`macos`), never `apple`. Three leaks were found
// one-at-a-time before this guard (open/perf response, perf-memory support, doctor
// byPlatform), proving per-site guards are insufficient.
//
// This guard stands up a fake-provider daemon for BOTH a macOS Apple session and an
// iOS-simulator Apple session (internal `platform:'apple'`, `appleOs:'macos'`/absent
// = iOS family), drives EVERY public command off the catalog, and deep-scans each
// serialized response. It flags a leak when any string VALUE, or any object KEY,
// exactly equals the internal `'apple'` token. Exact matching (case-sensitive) is
// deliberate: it catches every device-platform projection miss (the leak shapes of
// all three known leaks) with zero false positives on legitimate substrings such as
// `com.apple.Preferences` bundle ids or the `Apple TV` device name.
// ---------------------------------------------------------------------------

const INTERNAL_APPLE = 'apple';

type World = 'ios' | 'macos';
type PublicLeaf = 'ios' | 'macos';

const WORLDS: Record<World, { leaf: PublicLeaf; open: DriveStep }> = {
  ios: {
    leaf: 'ios',
    open: { positionals: ['com.apple.Preferences'], flags: { platform: 'ios', udid: 'sim-1' } },
  },
  macos: { leaf: 'macos', open: { positionals: ['settings'], flags: { platform: 'macos' } } },
};

type DriveStep = { positionals?: string[]; flags?: Record<string, unknown> };
type DriveContext = { world: World; leaf: PublicLeaf; tmpDir: string; appPath: string };
type DriveSpec = (ctx: DriveContext) => DriveStep[];

const one = (positionals: string[] = [], flags: Record<string, unknown> = {}): DriveStep[] => [
  { positionals, flags },
];

// ---------------------------------------------------------------------------
// DRIVEN_COMMANDS — every catalog command we actively drive, keyed by the public
// command string. New commands MUST be added here (or to SKIPPED_COMMANDS); the
// partition test below fails otherwise, so a new command can't silently escape the
// guard. Args are minimal-valid; a driven command that only reaches an error
// response (e.g. UNSUPPORTED on the wrong Apple OS, or a missing file) is still
// scanned — error responses must not leak `apple` either.
// ---------------------------------------------------------------------------
const DRIVEN_COMMANDS: Record<string, DriveSpec> = {
  // -- platform-bearing priority commands (success responses emit the leaf) --
  [PUBLIC_COMMANDS.open]: ({ world }) => [WORLDS[world].open],
  [PUBLIC_COMMANDS.appState]: () => one(),
  [PUBLIC_COMMANDS.capabilities]: () => one(),
  [PUBLIC_COMMANDS.devices]: () => one(),
  [PUBLIC_COMMANDS.doctor]: () => one(),
  [PUBLIC_COMMANDS.boot]: () => one(),
  [PUBLIC_COMMANDS.prepare]: () => one(['ios-runner']),
  [PUBLIC_COMMANDS.snapshot]: () => one([], { snapshotInteractiveOnly: true }),
  [PUBLIC_COMMANDS.perf]: () => [{ positionals: [] }, { positionals: ['frames'] }],
  [PUBLIC_COMMANDS.record]: ({ world, tmpDir }) =>
    world === 'ios'
      ? [{ positionals: ['start', path.join(tmpDir, 'recording.mp4')] }, { positionals: ['stop'] }]
      : one(['stop']),
  [PUBLIC_COMMANDS.trace]: ({ tmpDir }) => one(['stop', path.join(tmpDir, 'trace.adtrace')]),

  // -- app lifecycle --
  [PUBLIC_COMMANDS.apps]: () => one(),
  [PUBLIC_COMMANDS.install]: ({ appPath }) => one(['com.example.demo', appPath]),
  [PUBLIC_COMMANDS.reinstall]: ({ appPath }) => one(['com.example.demo', appPath]),
  [PUBLIC_COMMANDS.installFromSource]: ({ appPath }) => one([appPath]),
  [PUBLIC_COMMANDS.push]: ({ tmpDir }) => one([path.join(tmpDir, 'push-src.txt'), '/tmp/dest']),
  [PUBLIC_COMMANDS.triggerAppEvent]: () => one(['url', 'https://example.com']),
  [PUBLIC_COMMANDS.reactNative]: () => one(['reload']),

  // -- observability --
  [PUBLIC_COMMANDS.logs]: () => one(),
  [PUBLIC_COMMANDS.network]: () => one(),
  [PUBLIC_COMMANDS.audio]: () => one(),
  [PUBLIC_COMMANDS.screenshot]: ({ tmpDir }) => one([], { out: path.join(tmpDir, 'shot.png') }),
  [PUBLIC_COMMANDS.viewport]: () => one(),

  // -- snapshot-scoped reads --
  [PUBLIC_COMMANDS.diff]: () => one(),
  [PUBLIC_COMMANDS.wait]: () => one(['text', 'General', '50']),
  [PUBLIC_COMMANDS.find]: () => one(['label', 'General', 'get', 'attrs']),
  [PUBLIC_COMMANDS.get]: () => one(['attrs', 'label=General']),
  [PUBLIC_COMMANDS.is]: () => one(['visible', 'label=General']),
  [PUBLIC_COMMANDS.alert]: () => one(['get']),
  [PUBLIC_COMMANDS.settings]: () => one(['appearance', 'dark']),
  [PUBLIC_COMMANDS.clipboard]: () => one(['read']),
  [PUBLIC_COMMANDS.keyboard]: () => one(['dismiss']),

  // -- interactions / gestures --
  [PUBLIC_COMMANDS.click]: () => one(['10', '10']),
  [PUBLIC_COMMANDS.fill]: () => one(['label=General', 'hello']),
  [PUBLIC_COMMANDS.longPress]: () => one(['10', '10']),
  [PUBLIC_COMMANDS.press]: () => one(['10', '10']),
  [PUBLIC_COMMANDS.type]: () => one(['hello']),
  [PUBLIC_COMMANDS.back]: () => one(),
  [PUBLIC_COMMANDS.home]: () => one(),
  [PUBLIC_COMMANDS.focus]: () => one(['next']),
  [PUBLIC_COMMANDS.gesture]: () => one(['pinch', '0.8', '10', '10']),
  [PUBLIC_COMMANDS.rotate]: () => one(['left']),
  [PUBLIC_COMMANDS.scroll]: () => one(['down']),
  [PUBLIC_COMMANDS.swipe]: () => one(['up']),
  [PUBLIC_COMMANDS.appSwitcher]: () => one(),

  // -- orchestration (drive to an error response; still scanned) --
  [PUBLIC_COMMANDS.artifacts]: () => one(),
  [PUBLIC_COMMANDS.batch]: () => one(),
  [PUBLIC_COMMANDS.replay]: ({ tmpDir }) => one([path.join(tmpDir, 'missing.ad')]),
  [PUBLIC_COMMANDS.test]: () => one(),

  // -- session teardown (driven last; re-opened before the next command) --
  [PUBLIC_COMMANDS.shutdown]: () => one(),
  [PUBLIC_COMMANDS.close]: () => one(),
};

// ---------------------------------------------------------------------------
// SKIPPED_COMMANDS — catalog commands that genuinely cannot be driven against the
// fake-provider harness, each with a reason. Intentionally EMPTY: every public
// command is driveable here (an orchestrator with no real workload simply returns a
// fast, still-scanned error response). Kept as an explicit, enforced set so a future
// undriveable command has a home and the partition test keeps a new command from
// escaping the guard silently.
// ---------------------------------------------------------------------------
const SKIPPED_COMMANDS: Record<string, string> = {};

// Commands driven last so the priority commands run against a live session.
const DRIVE_LAST = new Set<string>([PUBLIC_COMMANDS.shutdown, PUBLIC_COMMANDS.close]);

// ---------------------------------------------------------------------------
// Known, tracked leaks tolerated so this guard is green on `origin/main` without
// duplicating an in-flight fix. Narrowly scoped by command + exact wire path.
// ---------------------------------------------------------------------------
type LeakHit = { command: string; world: World; kind: 'value' | 'key'; path: string };

const KNOWN_TRACKED_LEAKS: Array<{ reason: string; allows: (hit: LeakHit) => boolean }> = [
  // Empty by design: every known leak is now fixed on main — open/perf response
  // and perf-memory support (#1002), doctor byPlatform + command suggestions
  // (#1004), and doctor data.platform (this PR). The guard enforces a clean
  // surface with zero tolerated exceptions; a new leak must be fixed, not listed.
];

function isTrackedLeak(hit: LeakHit): boolean {
  return KNOWN_TRACKED_LEAKS.some((entry) => entry.allows(hit));
}

// ---------------------------------------------------------------------------
// Deep scanner: flags every string VALUE and every object KEY that EXACTLY equals
// the internal `apple` token. Also collects public-leaf VALUES so we can prove the
// projection path is actually exercised (a regression that replaced the leaf with
// `apple` would trip the leak scan AND drop the leaf presence assertion).
// ---------------------------------------------------------------------------
type ScanSink = { leaks: Array<{ kind: 'value' | 'key'; path: string }>; leaves: Set<string> };

function recordScalar(value: string, jsonPath: string, out: ScanSink): void {
  if (value === INTERNAL_APPLE) out.leaks.push({ kind: 'value', path: jsonPath });
  else if (value === 'ios' || value === 'macos') out.leaves.add(value);
}

function scan(node: unknown, jsonPath: string, out: ScanSink): void {
  if (typeof node === 'string') return recordScalar(node, jsonPath, out);
  if (Array.isArray(node)) {
    node.forEach((entry, index) => scan(entry, `${jsonPath}[${index}]`, out));
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === INTERNAL_APPLE) out.leaks.push({ kind: 'key', path: `${jsonPath}.${key}` });
    scan(value, `${jsonPath}.${key}`, out);
  }
}

// ---------------------------------------------------------------------------
// Fake-provider Apple world (permissive: any runner/tool call returns a generic OK
// so every command reaches a scannable response instead of a transcript mismatch).
// ---------------------------------------------------------------------------
function richNodes() {
  return [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Demo',
      rect: { x: 0, y: 0, width: 400, height: 800 },
      enabled: true,
      hittable: true,
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Window',
      label: 'Demo',
      rect: { x: 0, y: 0, width: 400, height: 800 },
      enabled: true,
      hittable: true,
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'General',
      identifier: 'general',
      rect: { x: 16, y: 100, width: 360, height: 44 },
      enabled: true,
      hittable: true,
    },
  ];
}

function permissiveRunner(): AppleRunnerProvider {
  return {
    runCommand: async (_device, command) => {
      switch (command.command) {
        case 'uptime':
          return { uptimeMs: 1 };
        case 'snapshot':
          return { nodes: richNodes(), truncated: false };
        case 'querySelector':
          return { found: true, nodes: [richNodes()[2]] };
        case 'findText':
          return { found: true };
        default:
          return { done: true };
      }
    },
    prepare: async () => ({ runner: { uptimeMs: 1 }, connectMs: 1, healthCheckMs: 1 }),
  };
}

function permissiveTool(world: World) {
  let clipboard = '';
  let darkMode = false;
  return createRecordingAppleToolProvider({
    simctl: async (args, options) => {
      const joined = args.join(' ');
      const list = simctlListDevicesResult(args, 'com.apple.CoreSimulator.SimRuntime.iOS-18-0', [
        { name: 'iPhone 15', udid: 'sim-1' },
      ]);
      if (list) return list;
      if (joined === 'pbcopy sim-1') {
        clipboard = String(options?.stdin ?? '');
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (joined === 'pbpaste sim-1') return { stdout: `${clipboard}\n`, stderr: '', exitCode: 0 };
      if (joined === 'listapps sim-1') {
        return {
          stdout: '{"com.example.demo":{"CFBundleDisplayName":"Demo"}}\n',
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    devicectl: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    macosHelper: async (args) => {
      const data: Record<string, unknown> = { surface: 'frontmost-app' };
      if (args[0] === 'app' && args[1] === 'frontmost') {
        Object.assign(data, {
          bundleId: 'com.apple.systempreferences',
          appName: 'System Settings',
          pid: 1,
        });
      }
      if (args[0] === 'snapshot') {
        Object.assign(data, {
          nodes: richNodes().map((node) => ({ ...node, surface: 'frontmost-app' })),
          truncated: false,
          backend: 'macos-helper',
        });
      }
      if (args[0] === 'read') Object.assign(data, { text: 'General pane' });
      if (args[0] === 'press')
        Object.assign(data, { x: 10, y: 10, bundleId: 'com.apple.systempreferences' });
      if (args[0] === 'alert') {
        Object.assign(data, {
          title: 'Alert',
          role: 'AXSheet',
          buttons: ['OK'],
          action: args[1],
          bundleId: 'com.apple.systempreferences',
        });
      }
      return { stdout: `${JSON.stringify({ ok: true, data })}\n`, stderr: '', exitCode: 0 };
    },
    macosHost: {
      openBundle: async () => {},
      openTarget: async () => {},
      readClipboard: async () => clipboard,
      writeClipboard: async (text) => {
        clipboard = text;
      },
      readDarkMode: async () => darkMode,
      setDarkMode: async (enabled) => {
        darkMode = enabled;
      },
      listApps: async () => [{ bundleId: 'com.example.demo', name: 'Demo' }],
    },
    plist:
      world === 'ios'
        ? {
            readJson: async () => ({
              CFBundleIdentifier: 'com.example.demo',
              CFBundleName: 'Demo',
            }),
          }
        : undefined,
  });
}

function permissiveRecording(): RecordingProvider {
  return {
    startIosSimulatorRecording: ({ outPath }) => {
      fs.writeFileSync(outPath, likelyPlayableMp4Container());
      return {
        child: { kill: () => true },
        wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
      };
    },
  };
}

async function createWorldDaemon(world: World): Promise<ProviderScenarioHarness> {
  const device = world === 'ios' ? PROVIDER_SCENARIO_IOS_SIMULATOR : PROVIDER_SCENARIO_MACOS;
  return await createProviderScenarioHarness({
    appleRunnerProvider: () => permissiveRunner(),
    appleToolProvider: () => permissiveTool(world).provider,
    recordingProvider: () => permissiveRecording(),
    deviceInventoryProvider: async () => [device],
  });
}

async function ensureSession(daemon: ProviderScenarioHarness, world: World): Promise<void> {
  if (daemon.session()) return;
  const { positionals, flags } = WORLDS[world].open;
  await daemon.callCommand('open', positionals ?? [], flags ?? {});
}

async function withCommandTimeout(
  work: Promise<ProviderScenarioRpcResult>,
  command: string,
): Promise<ProviderScenarioRpcResult> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Command "${command}" did not return within 20s in the fake harness. Give it faster ` +
              `args or move it to SKIPPED_COMMANDS in apple-platform-output-guard.test.ts.`,
          ),
        ),
      20_000,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

function driveOrder(): string[] {
  const commands = Object.keys(DRIVEN_COMMANDS);
  return [
    ...commands.filter((command) => !DRIVE_LAST.has(command)),
    ...commands.filter((command) => DRIVE_LAST.has(command)),
  ];
}

async function runWorldGuard(world: World): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-device-apple-guard-${world}-`));
  const appPath = path.join(tmpDir, 'Demo.app');
  fs.mkdirSync(appPath, { recursive: true });
  fs.writeFileSync(
    path.join(appPath, 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.demo</string><key>CFBundleName</key><string>Demo</string></dict></plist>',
    'utf8',
  );
  fs.writeFileSync(path.join(tmpDir, 'push-src.txt'), 'payload', 'utf8');

  const ctx: DriveContext = { world, leaf: WORLDS[world].leaf, tmpDir, appPath };
  const daemon = await createWorldDaemon(world);
  const leaks: LeakHit[] = [];
  const leavesSeen = new Set<string>();

  try {
    for (const command of driveOrder()) {
      for (const step of DRIVEN_COMMANDS[command]!(ctx)) {
        await ensureSession(daemon, world);
        const response = await withCommandTimeout(
          daemon.callCommand(command, step.positionals ?? [], step.flags ?? {}),
          command,
        );
        const out = {
          leaks: [] as Array<{ kind: 'value' | 'key'; path: string }>,
          leaves: new Set<string>(),
        };
        scan(response.json, '$', out);
        for (const hit of out.leaks) leaks.push({ command, world, kind: hit.kind, path: hit.path });
        for (const leaf of out.leaves) leavesSeen.add(leaf);
      }
    }
  } finally {
    await daemon.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const unexpected = leaks.filter((hit) => !isTrackedLeak(hit));
  assert.deepEqual(
    unexpected,
    [],
    `Public command responses leaked the internal '${INTERNAL_APPLE}' platform on the ${world} ` +
      `Apple session. Route the offending output field through publicPlatformString(device):\n` +
      unexpected.map((hit) => `  - ${hit.command}: ${hit.kind} at ${hit.path}`).join('\n'),
  );

  // Prove the public-leaf projection is actually exercised for this Apple OS: a
  // regression that swapped the leaf back to `apple` would trip the leak scan above
  // AND drop the world's leaf from every response.
  assert.ok(
    leavesSeen.has(WORLDS[world].leaf),
    `Expected at least one ${world} response to emit the public leaf '${WORLDS[world].leaf}'. ` +
      `Saw leaves: ${[...leavesSeen].join(', ') || '(none)'}`,
  );
}

test('every public command is driven or explicitly skipped (no silent escape)', () => {
  const driven = new Set(Object.keys(DRIVEN_COMMANDS));
  const skipped = new Set(Object.keys(SKIPPED_COMMANDS));
  const known = new Set<string>(Object.values(PUBLIC_COMMANDS));

  for (const command of Object.values(PUBLIC_COMMANDS)) {
    const inDriven = driven.has(command);
    const inSkipped = skipped.has(command);
    assert.ok(
      inDriven || inSkipped,
      `Public command "${command}" is neither driven nor skipped. Add it to DRIVEN_COMMANDS ` +
        `(preferred) or SKIPPED_COMMANDS in apple-platform-output-guard.test.ts so it can't ` +
        `escape the apple-leak guard.`,
    );
    assert.ok(!(inDriven && inSkipped), `Public command "${command}" is both driven and skipped.`);
  }
  for (const command of [...driven, ...skipped]) {
    assert.ok(known.has(command), `Guard references "${command}", which is not a public command.`);
  }
});

test('macOS Apple session never emits the internal apple platform on the wire', async () => {
  await runWorldGuard('macos');
}, 120_000);

test('iOS-simulator Apple session never emits the internal apple platform on the wire', async () => {
  await runWorldGuard('ios');
}, 120_000);
