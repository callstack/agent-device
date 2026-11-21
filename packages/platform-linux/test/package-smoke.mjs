import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');

/**
 * A stand-in for one Linux desktop session: the input synthesizer, clipboard, screenshot tool and
 * AT-SPI helper the family asks a desktop for. Each stub answers one canned reply and appends its
 * argv plus the `PATH` and `DISPLAY` it was spawned with, so the test can prove which executable ran,
 * with what arguments, and through which host environment. The paths are baked into the stubs rather
 * than passed by environment: the plugin builds each spawn environment from the host it was set up
 * with, so nothing this fixture needs travels through it.
 */
function desktopToolStubSource(tool, logFile, reply) {
  return [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    'const joined = args.join(" ");',
    'fs.appendFileSync(' +
      JSON.stringify(logFile) +
      String.raw`, "TOOL: " + ${JSON.stringify(tool)} + "\nARGS: " + joined + "\nPATH: " + process.env.PATH + "\nDISPLAY: " + (process.env.DISPLAY || "") + "\n");`,
    String.raw`const answer = (text) => process.stdout.write(text + "\n");`,
    reply,
  ].join('\n');
}

/** The AT-SPI helper's reply: two nodes for one window, in the shape `atspi-dump.py` prints. */
function atspiStubSource(logFile) {
  const tree = JSON.stringify({
    nodes: [
      {
        index: 0,
        role: 'frame',
        label: 'Stub Window',
        rect: { x: 0, y: 0, width: 400, height: 300 },
        enabled: true,
        hittable: true,
        depth: 0,
      },
      {
        index: 1,
        role: 'push button',
        label: 'OK',
        rect: { x: 40, y: 80, width: 60, height: 30 },
        enabled: true,
        hittable: true,
        depth: 1,
        parentIndex: 0,
      },
    ],
    truncated: false,
    surface: 'desktop',
  });
  return [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    'fs.appendFileSync(' +
      JSON.stringify(logFile) +
      String.raw`, "TOOL: python3\nARGS: " + args.map((a) => (a.includes("/") ? "<script>" : a)).join(" ") + "\nPATH: " + process.env.PATH + "\nDISPLAY: " + (process.env.DISPLAY || "") + "\n");`,
    `process.stdout.write(${JSON.stringify(tree + '\n')});`,
  ].join('\n');
}

/** A screenshot writer: `scrot <path>` produces a file, which is all the family asks of it. */
function scrotStubSource(logFile) {
  return [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    'fs.appendFileSync(' +
      JSON.stringify(logFile) +
      String.raw`, "TOOL: scrot\nARGS: " + args.join(" ") + "\nPATH: " + process.env.PATH + "\nDISPLAY: " + (process.env.DISPLAY || "") + "\n");`,
    'if (args.length > 0) {',
    '  fs.writeFileSync(args[args.length - 1], Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));',
    ' }',
  ].join('\n');
}

test('packed core serves the Linux desktop only after the managed platform is installed', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-linux-pack-'));
  // The desktop tools are host executables the plugin reads through PATH. Every CLI run names a PATH
  // carrying none of them, so a machine that has a real desktop would not answer with its own windows,
  // and the plugin's missing-toolchain report is what an uninstalled toolchain looks like everywhere.
  const strippedHost = (source) =>
    Object.fromEntries(
      Object.entries(source).filter(
        ([name]) =>
          !name.startsWith('AGENT_DEVICE_') &&
          !['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_SESSION_TYPE', 'DISPLAY_SERVER'].includes(name),
      ),
    );
  const env = {
    ...strippedHost(process.env),
    AGENT_DEVICE_HOME: path.join(scratch, 'home'),
    AGENT_DEVICE_STATE_DIR: path.join(scratch, 'state'),
    AGENT_DEVICE_CLAIMS_DIR: path.join(scratch, 'claims'),
    AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1',
  };
  const stubBin = path.join(scratch, 'stub-bin');
  fs.mkdirSync(stubBin, { recursive: true });
  const cliEnv = {
    ...env,
    PATH: [stubBin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    HOME: scratch,
  };
  const exec = (command, args, cwd = scratch) =>
    execFileSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000 });
  const cliText = (...args) =>
    exec(process.execPath, ['node_modules/agent-device/bin/agent-device.mjs', ...args], scratch);
  const runCliWith = (environment, expectedExit, ...args) => {
    const invoke = () =>
      execFileSync(
        process.execPath,
        ['node_modules/agent-device/bin/agent-device.mjs', ...args, '--json'],
        {
          cwd: scratch,
          env: environment,
          encoding: 'utf8',
          timeout: 120_000,
          maxBuffer: 32 * 1024 * 1024,
        },
      );
    try {
      const reply = JSON.parse(invoke());
      assert.equal(expectedExit, 0);
      return reply;
    } catch (error) {
      if (expectedExit !== 0 && error.status === expectedExit) return JSON.parse(error.stdout);
      throw error;
    }
  };
  const runCli = (expectedExit, ...args) => runCliWith(cliEnv, expectedExit, ...args);
  try {
    const [packed] = JSON.parse(
      exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], repo),
    );
    assert.ok(!packed.files.some(({ path }) => path.includes('/platform-linux/')));
    exec(
      'pnpm',
      ['pack', '--out', path.join(scratch, 'linux.tgz')],
      path.join(repo, 'packages/platform-linux'),
    );
    // The AT-SPI helper ships with the plugin and is resolved relative to it. A tarball without it
    // would install, answer a toolchain report, and then fail on the first capture, so it is checked
    // where it is packed rather than only where it is committed.
    const packedPlugin = exec('tar', ['tzf', path.join(scratch, 'linux.tgz')]);
    assert.match(packedPlugin, /^package\/linux\/atspi-dump\.py$/m, packedPlugin);
    fs.writeFileSync(path.join(scratch, 'package.json'), '{"private":true}');
    exec('npm', [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      path.join(scratch, packed.filename),
    ]);

    // Without the plugin: a request that names the family answers the typed outcome with the install
    // command, an unfiltered request skips the family silently, and help still renders.
    const { error } = runCli(1, 'devices', '--platform', 'linux');
    assert.equal(error.details.reason, 'plugin-not-installed');
    assert.match(error.hint, /agent-device plugins add @agent-device\/linux/);

    const open = runCli(1, 'open', 'xterm', '--platform', 'linux');
    assert.equal(open.error.details.reason, 'plugin-not-installed');

    // Doctor names the family's own blocker through a failing toolchain row, built from the same
    // absence outcome the discovery request raises. An unfiltered doctor stays silent about it.
    const scoped = runCli(0, 'doctor', '--platform', 'linux');
    const toolchain = scoped.data.checks.find((check) => check.id === 'toolchain');
    assert.equal(toolchain.status, 'fail');
    assert.equal(toolchain.evidence.reason, 'plugin-not-installed');
    assert.equal(toolchain.evidence.package, '@agent-device/linux');
    assert.match(toolchain.command, /agent-device plugins add @agent-device\/linux/);
    const unscoped = runCli(0, 'doctor');
    assert.ok(
      !unscoped.data.checks.some((check) => JSON.stringify(check).includes('@agent-device/linux')),
      'an unfiltered doctor names no plugin the core lacks',
    );
    runCli(0, 'devices');
    // The family's help renders with no plugin installed: nothing about Linux depends on it.
    assert.match(cliText('help', 'devices'), /devices/);
    runCli(0, 'daemon', 'stop');

    runCli(0, 'plugins', 'add', './linux.tgz');
    runCli(0, 'daemon', 'stop');

    // The Linux desktop device is the host's own session, so the family answers one only for a Linux
    // host. Everything below needs that host: the installed plugin then drives a whole interaction on
    // tools it resolved from the host PATH, which is what this run's Ubuntu job provides.
    if (process.platform !== 'linux') return;

    // The plugin is loaded and active before any device is named: a store entry whose family fails to
    // register would report a failed state here rather than an empty device list later.
    const plugins = runCli(0, 'daemon', 'status').data.plugins;
    assert.ok(
      plugins.some((plugin) => plugin.platform === 'linux' && plugin.state === 'active'),
      JSON.stringify(plugins),
    );

    // An X11 session with the desktop tools on PATH, and a display nobody else's window manager owns.
    const desktopEnv = { ...cliEnv, DISPLAY: ':77', XDG_SESSION_TYPE: 'x11' };
    const toolCalls = path.join(scratch, 'desktop-calls.log');
    plantDesktopTools(stubBin, toolCalls);

    const found = runCliWith(desktopEnv, 0, 'devices', '--platform', 'linux');
    assert.equal(found.data.devices.length, 1, JSON.stringify(found.data));
    assert.equal(found.data.devices[0].platform, 'linux');
    assert.equal(found.data.devices[0].id, 'local');
    assert.equal(found.data.devices[0].target, 'desktop');

    // The toolchain row the same host answers now names the tools it found, not an absent plugin.
    const installed = runCliWith(desktopEnv, 0, 'doctor', '--platform', 'linux');
    const installedToolchain = installed.data.checks.find((check) => check.id === 'toolchain');
    assert.equal(installedToolchain.status, 'pass', JSON.stringify(installedToolchain));
    assert.deepEqual(installedToolchain.evidence.tools, ['xdotool', 'xclip', 'scrot', 'python3']);

    const opened = runCliWith(desktopEnv, 0, 'open', 'stub-desktop', '--platform', 'linux');
    assert.equal(opened.data.message, 'Opened: stub-desktop');

    const captured = runCliWith(desktopEnv, 0, 'snapshot', '--platform', 'linux');
    assert.deepEqual(
      captured.data.nodes.map(({ role, value }) => ({ role, value })),
      [
        { role: 'frame', value: 'Stub Window' },
        { role: 'push button', value: 'OK' },
      ],
      JSON.stringify(captured.data.nodes),
    );

    const shot = path.join(scratch, 'screen.png');
    const shotResult = runCliWith(desktopEnv, 0, 'screenshot', shot, '--platform', 'linux');
    assert.equal(shotResult.data.path, shot);
    assert.deepEqual([...fs.readFileSync(shot).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

    const pressed = runCliWith(desktopEnv, 0, 'press', '42', '84', '--platform', 'linux');
    assert.equal(pressed.data.targetKind, 'point');
    runCliWith(desktopEnv, 0, 'close', 'stub-desktop', '--platform', 'linux');

    const recorded = fs.readFileSync(toolCalls, 'utf8').split('\n').filter(Boolean);
    const tools = recorded.filter((line) => line.startsWith('TOOL: '));
    const invoked = recorded.filter((line) => line.startsWith('ARGS: '));
    const paths = recorded.filter((line) => line.startsWith('PATH: '));
    const displays = recorded.filter((line) => line.startsWith('DISPLAY: '));
    assert.equal(tools.length, invoked.length, 'every recorded call names its tool');
    assert.equal(paths.length, invoked.length, 'every recorded call names the PATH it ran with');
    assert.deepEqual(
      tools.map(
        (line, index) => `${line.slice('TOOL: '.length)} ${invoked[index].slice('ARGS: '.length)}`,
      ),
      [
        'xdotool getmouselocation --shell',
        'xdotool mousemove --sync 42 84',
        'xdotool click 1',
        'xclip -selection clipboard -o',
        'xdotool getmouselocation --shell',
        'xdotool mousemove --sync 42 84',
        'xdotool click 1',
        'xdotool getmouselocation --shell',
        'xdotool mousemove --sync 42 84',
        'xdotool click 1',
      ].join('\n'),
      'the desktop route is the one the X11 session selects',
    );

    // The capture runs the helper the plugin shipped, and each spawn got the host environment the CLI
    // was started with: both facts come from the host, not from the bundle's own process.
    assert.ok(
      invoked.includes(
        'ARGS: <script> --surface desktop --max-nodes 1500 --max-depth 12 --max-apps 24',
      ),
      `the snapshot never ran the plugin's own AT-SPI helper: ${invoked.join(' | ')}`,
    );
    assert.ok(
      paths.every((line) => line.startsWith(`PATH: ${stubBin}${path.delimiter}`)),
      `a desktop tool ran with a PATH the plugin did not build: ${paths.join(' | ')}`,
    );
    assert.ok(
      displays.every((line) => line === 'DISPLAY: :77'),
      `a desktop tool ran without the display the host named: ${displays.join(' | ')}`,
    );
    assert.ok(
      !invoked.some((line) => line.startsWith('ARGS: /') && !line.includes('<script>')),
      `a helper was resolved outside the plugin bundle: ${invoked.join(' | ')}`,
    );
  } finally {
    try {
      if (fs.existsSync(path.join(scratch, 'node_modules/agent-device')))
        runCli(0, 'daemon', 'stop');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
});

/**
 * Plants the desktop tools the Linux family resolves for an X11 session: an input synthesizer, a
 * clipboard, a screenshot writer, a window closer, and the AT-SPI helper. Every one of them answers
 * one canned reply and records the call, so an interaction that reaches the desktop is visible in the
 * log rather than assumed.
 */
function plantDesktopTools(stubBin, logFile) {
  // The pointer reply is five lines, so it is assembled inside the stub rather than escaped here.
  const location = [
    String.raw`const pointer = ["X:0", "Y:0", "screen:0", "screen_width:1280", "screen_height:1024"].join("\n");`,
    'if (joined.includes("getmouselocation")) answer(pointer); else answer("");',
  ].join(' ');
  const stubs = {
    xdotool: desktopToolStubSource('xdotool', logFile, location),
    wmctrl: desktopToolStubSource(
      'wmctrl',
      logFile,
      'if (joined.includes("-c")) answer(""); else answer("");',
    ),
    'xdg-open': desktopToolStubSource('xdg-open', logFile, 'answer("");'),
    xclip: desktopToolStubSource(
      'xclip',
      logFile,
      String.raw`if (joined.includes("-o")) answer("stub clipboard"); else answer("");`,
    ),
    scrot: scrotStubSource(logFile),
    python3: atspiStubSource(logFile),
  };
  for (const [tool, source] of Object.entries(stubs)) {
    const file = path.join(stubBin, tool);
    fs.writeFileSync(file, source, 'utf8');
    fs.chmodSync(file, 0o755);
  }
}
