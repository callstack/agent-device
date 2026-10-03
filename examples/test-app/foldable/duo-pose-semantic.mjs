#!/usr/bin/env node
// LOCAL / MANUAL ONLY — not automatic regression coverage and not wired to any CI gate.
//
// Semantic interaction replay across iPhone Duo pose transitions (issue #2731, parent #2725).
//
// It drives the existing `agent-device` CLI/daemon against one explicit, booted iPhone Duo
// simulator and asserts the app reacts after every pose change: a Catalog tap is proved to activate
// by an absent->present `catalog-title` transition (measured from the same snapshot that resolved
// the tap's ref, with `home-title` gone after), the Home reset is asserted before the next fold,
// Add to cart moves the cart counter, a scroll reveals a canary, a long press moves a dedicated
// count, and a multipointer pinch changes a recognized scale. It never reuses a ref or coordinate
// across a pose change or a mutation: every tap resolves a fresh ref from the snapshot taken
// immediately before it, and a dropped session re-opens but never replays an interaction ref.
//
// GitHub Actions cannot schedule this yet: hosted macOS images carry no iPhone Duo runtime and no
// self-hosted Duo runner is registered (see the issue investigation). Run it locally on a host
// that owns exactly one booted iPhone Duo for the duration of the run.
//
// Requirements (enforced up front with an actionable failure, never a silent skip):
//   * DEVELOPER_DIR pinned to a Duo-capable Xcode (the iOS 27.1 runtime ships only with Xcode 27.1+).
//   * An iPhone Duo simulator already booted on that toolchain, not shared with a concurrent run
//     (concurrent runs rebuild the shared Apple runner and race the pose/capture state).
//   * Nothing else for pose control: `fold` drives the hinge through simulator HID, compiling a
//     helper and dispatching it inside the simulator with `simctl spawn`, so no Device Hub window
//     and no host Accessibility permission is involved. It refuses a single-panel simulator as
//     `single-panel-device` and a pose the hinge read-back does not confirm as `fold-pose-unverified`.
//   * The Agent Device Tester fixture app installed on that simulator.
//
// Usage (from the repository root):
//   DEVELOPER_DIR=<Xcode-27.1>/Contents/Developer \
//     node examples/test-app/foldable/duo-pose-semantic.mjs --udid <DUO-UDID>
//
// Flags:
//   --udid <UDID>              Booted iPhone Duo simulator (required).
//   --session <name>           Session name (default: duo-pose-semantic).
//   --state-dir <dir>          Isolated daemon state dir (default: a /private/tmp path).
//   --app <target>             App target for `open` (default: "Agent Device Tester").
//   --artifacts-dir <dir>      Failure artifacts (default: <state-dir>/artifacts).
//   --demo-geometry-mutation   Derive the pinch origin from a different control's bounds instead
//                              of the target's own bounds, so the semantic scale assertion FAILS.
//                              Proves the assertion is sensitive to targeting geometry. A red run
//                              is the expected outcome here.
//   --demo-skip-home-reset     Skip the reset-to-Home tap so the "Home is the active route" check
//                              and the next pose's before-state FAIL in a closed/half-open pose.
//                              Proves the activation check is sensitive to a missed Home reset.
//                              A red run is the expected outcome here.
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = join(REPO_ROOT, 'bin', 'agent-device.mjs');
const DEVELOPER_DIR = process.env.DEVELOPER_DIR;
const POSES = ['closed', 'half-open', 'open', 'closed'];
const START_POSE = 'closed';
const STRUCTURAL = new Set(['open', 'fold', 'snapshot', 'close']);
const TRANSIENT =
  /XCTEST_RECORDED_FAILURE|runner session was invalidated|may not have been performed|No active session|SESSION_NOT_FOUND|Daemon request timed out|CommandRunnerStarting|Starting XCTest runner/i;

function parseArgs(argv) {
  const opts = {
    udid: undefined,
    session: 'duo-pose-semantic',
    stateDir: join(tmpdir(), 'duo-pose-semantic-state'),
    app: 'Agent Device Tester',
    artifactsDir: undefined,
    demoGeometryMutation: false,
    demoSkipHomeReset: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(`missing value for ${flag}`, `Pass a value after ${flag}.`);
      i += 1;
      return value;
    };
    switch (flag) {
      case '--udid':
        opts.udid = next();
        break;
      case '--session':
        opts.session = next();
        break;
      case '--state-dir':
        opts.stateDir = next();
        break;
      case '--app':
        opts.app = next();
        break;
      case '--artifacts-dir':
        opts.artifactsDir = next();
        break;
      case '--demo-geometry-mutation':
        opts.demoGeometryMutation = true;
        break;
      case '--demo-skip-home-reset':
        opts.demoSkipHomeReset = true;
        break;
      default:
        fail(`unknown flag ${flag}`, 'Run with no flags to see usage.');
    }
  }
  opts.artifactsDir ??= join(opts.stateDir, 'artifacts');
  return opts;
}

function fail(message, hint) {
  process.stderr.write(`\nSETUP FAILED: ${message}\n${hint ? `HINT: ${hint}\n` : ''}`);
  process.exit(1);
}

function assertSetup(condition, message, hint) {
  if (!condition) fail(message, hint);
}

const opts = parseArgs(process.argv.slice(2));
assertSetup(
  Boolean(DEVELOPER_DIR),
  'DEVELOPER_DIR is not set.',
  'Pin it to a Duo-capable Xcode, e.g. DEVELOPER_DIR=/Applications/Xcode-27.1.0-Beta.app/Contents/Developer.',
);
assertSetup(
  Boolean(opts.udid),
  '--udid is required.',
  'Pass the UDID of a booted iPhone Duo simulator.',
);

// Keep the long fold/waits from tripping the default 5-minute idle reap for this local run.
const CHILD_ENV = {
  ...process.env,
  DEVELOPER_DIR,
  FORCE_COLOR: '0',
  AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '1800000',
  AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS: '1800000',
};
const GLOBALS = [
  '--platform',
  'ios',
  '--udid',
  opts.udid,
  '--session',
  opts.session,
  '--state-dir',
  opts.stateDir,
];

function exec(cmd, args) {
  return new Promise((res, rej) => {
    execFile(cmd, args, { env: CHILD_ENV, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) rej(Object.assign(err, { stdout, stderr }));
      else res(stdout);
    });
  });
}

function cli(args, { json = false, allowFail = false } = {}) {
  const full = [...args, ...GLOBALS, ...(json ? ['--json'] : [])];
  return exec(process.execPath, [CLI, ...full])
    .then((stdout) => {
      if (!json) return stdout;
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw new Error(`non-JSON output for: ${args.join(' ')}`);
      }
      if (parsed.success) return parsed.data;
      throw Object.assign(
        new Error(parsed.error?.code ? `${parsed.error.code}: ${parsed.error.message}` : 'failed'),
        {
          code: parsed.error?.code,
        },
      );
    })
    .catch((error) => {
      if (allowFail) return undefined;
      throw error;
    });
}

async function command(args, { json = false } = {}) {
  try {
    return await cli(args, { json });
  } catch (error) {
    const dropped =
      error.code === 'SESSION_NOT_FOUND' || /No active session/i.test(String(error.message));
    if (!dropped) throw error;
    process.stderr.write('  (session dropped; re-opening)\n');
    await cli(['open', opts.app]);
    // Reopening relaunches the app, so it is a state change: never resend an interaction that
    // carries an @ref or raw coordinates. Only pose/observation commands retry transparently;
    // interactions surface as transient so actOn/snapshotNodes re-resolve a fresh ref.
    if (!STRUCTURAL.has(args[0])) throw error;
    return await cli(args, { json });
  }
}

// ---- device / toolchain admission -----------------------------------------------------------

async function admitDevice() {
  let listing;
  try {
    listing = JSON.parse(await exec('xcrun', ['simctl', 'list', 'devices', '--json', 'available']));
  } catch (error) {
    fail('could not query simctl for available devices.', String(error.stderr || error.message));
  }
  const me = Object.values(listing.devices ?? {})
    .flat()
    .find((d) => d.udid === opts.udid);
  assertSetup(
    me,
    `UDID ${opts.udid} is not an available simulator on ${DEVELOPER_DIR}.`,
    'Boot an iPhone Duo on this toolchain and pass its UDID.',
  );
  assertSetup(
    me.state === 'Booted',
    `${me.name} (${opts.udid}) is not booted.`,
    `Boot it: xcrun simctl boot ${opts.udid}`,
  );
  assertSetup(
    /Duo/i.test(me.name),
    `${me.name} is not an iPhone Duo.`,
    'This scenario only exercises the iPhone Duo device type.',
  );
  return me;
}

// ---- interaction helpers --------------------------------------------------------------------

async function snapshotNodes() {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const data = await command(['snapshot', '-i'], { json: true });
      return data.nodes ?? [];
    } catch (error) {
      lastError = error;
      if (!TRANSIENT.test(String(error.message))) throw error;
      await sleep(2000);
    }
  }
  throw lastError;
}

async function warmRunner(maxMs = 150000) {
  const deadline = Date.now() + maxMs;
  for (let attempt = 1; Date.now() < deadline; attempt += 1) {
    const data = await cli(['snapshot', '-i'], { json: true, allowFail: true });
    if (data?.nodes) return;
    process.stderr.write(`  (warming Apple runner… attempt ${attempt})\n`);
    await sleep(3000);
  }
  throw new Error(
    'Apple runner did not become ready; run `agent-device prepare ios-runner` first.',
  );
}

async function waitForIdentifier(identifier, maxMs = 40000) {
  const deadline = Date.now() + maxMs;
  let nodes = await snapshotNodes();
  while (!nodes.some((n) => n.identifier === identifier) && Date.now() < deadline) {
    await sleep(1000);
    nodes = await snapshotNodes();
  }
  return nodes;
}

// ---- semantic checks ------------------------------------------------------------------------

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function findByIdentifier(nodes, id) {
  return nodes.find((n) => n.identifier === id);
}
function findButtonByLabel(nodes, label) {
  return nodes.find((n) => n.type === 'Button' && n.label === label);
}
function labelOf(nodes, identifier) {
  return findByIdentifier(nodes, identifier)?.label;
}

// Performs a UI action against a freshly-resolved ref, retrying with a fresh snapshot on a
// transient runner/orientation failure. Never reuses a ref across attempts. Returns the node, the
// snapshot that ultimately resolved it, and `firstNodes`: the very first snapshot that resolved the
// target, before any tap attempt. Callers reading a before-state must use `firstNodes`, because a
// retried action's resolve snapshot can already reflect a tap that landed.
async function actOnFresh(findNode, perform, what, { retries = 4 } = {}) {
  let lastError;
  let firstNodes;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const nodes = await snapshotNodes();
    const node = findNode(nodes);
    if (node) {
      firstNodes ??= nodes;
      try {
        await perform(node);
        return { node, nodes, firstNodes };
      } catch (error) {
        lastError = error;
        if (!TRANSIENT.test(String(error.message))) throw error;
      }
    } else {
      lastError = new Error(`${what}: target not present in snapshot`);
    }
    await sleep(1500 + attempt * 1000);
  }
  throw lastError ?? new Error(`${what}: action failed`);
}

function actOn(findNode, perform, what, opts) {
  return actOnFresh(findNode, perform, what, opts).then((r) => r.node);
}

// Waits until the route identified by `want` is active and `gone` has left the tree, then returns
// that snapshot. The `-i` snapshot carries only the active screen, so an absent route title proves
// the previous screen is no longer mounted.
async function waitForActiveRoute(want, gone, { maxMs = 8000, pollMs = 400 } = {}) {
  const deadline = Date.now() + maxMs;
  let nodes = await snapshotNodes();
  while (Date.now() < deadline) {
    if (findByIdentifier(nodes, want) && !findByIdentifier(nodes, gone)) return nodes;
    await sleep(pollMs);
    nodes = await snapshotNodes();
  }
  return nodes;
}

function gotoTab(label) {
  return actOn(
    (n) => findButtonByLabel(n, label),
    (node) => command(['click', `@${node.ref}`]),
    `tab ${label}`,
  );
}
function tapIdentifier(identifier, what) {
  return actOn(
    (n) => findByIdentifier(n, identifier),
    (node) => command(['click', `@${node.ref}`]),
    what ?? identifier,
  );
}
function longPressIdentifier(identifier, what) {
  return actOn(
    (n) => findByIdentifier(n, identifier),
    (node) => command(['longpress', `@${node.ref}`, '700']),
    what ?? identifier,
  );
}

// A fold re-lays-out the app; a tap during the re-layout fails as a recorded XCTest failure. Wait
// until the tab-bar geometry stops changing between snapshots.
async function waitForStable({ maxMs = 18000, pollMs = 1500 } = {}) {
  const deadline = Date.now() + maxMs;
  let previous;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const nodes = await snapshotNodes();
    const sig = JSON.stringify(
      nodes
        .filter((n) => n.type === 'Button')
        .map((n) => [
          n.label ?? n.identifier,
          Math.round(n.rect?.x ?? -1),
          Math.round(n.rect?.y ?? -1),
        ]),
    );
    if (sig && sig === previous) return;
    previous = sig;
  }
}

async function fold(pose) {
  const data = await command(['fold', pose], { json: true });
  const screen = data.screen
    ? `${data.screen.widthPt}x${data.screen.heightPt}pt on ${data.screen.display}`
    : 'unknown';
  process.stdout.write(`\n# fold ${pose}: hinge ${data.hingeAngleDegrees}°, lit ${screen}\n`);
  await waitForStable();
  return data;
}

// ---- scenario -------------------------------------------------------------------------------

function parseScale(status) {
  const m = /scale\s+([0-9.]+)/.exec(String(status));
  return m ? Number(m[1]) : Number.NaN;
}
function cartCounts(nodes) {
  return nodes
    .filter((n) => /In cart:\s*\d+/.test(String(n.label)))
    .map((n) => Number(/In cart:\s*(\d+)/.exec(n.label)[1]));
}

// Presses the Catalog tab and requires a real route transition, not just a presence that could be
// stale. From the same snapshot that resolved the tap's ref, `catalog-title` must be ABSENT (we are
// on Home) before the tap; after it `catalog-title` must be PRESENT while `home-title` is GONE. The
// `-i` snapshot carries only the active screen, so proving absent->present rejects a no-op tap, an
// off-target tap, and any navigator that kept the previous screen mounted. In the open pose it also
// increments the cart counter — a value-based activation effect.
async function activateCatalog(pose, artifacts) {
  const { firstNodes: before } = await actOnFresh(
    (n) => findButtonByLabel(n, 'Catalog'),
    (node) => command(['click', `@${node.ref}`]),
    'Catalog tab',
  );
  const catalogBefore = Boolean(findByIdentifier(before, 'catalog-title'));
  const homeBefore = Boolean(findByIdentifier(before, 'home-title'));
  const after = await waitForActiveRoute('catalog-title', 'home-title');
  const catalogAfter = Boolean(findByIdentifier(after, 'catalog-title'));
  const homeAfter = Boolean(findByIdentifier(after, 'home-title'));
  const ok = !catalogBefore && homeBefore && catalogAfter && !homeAfter;
  record(
    `press Catalog tab routes and activates it (${pose})`,
    ok,
    `catalog ${catalogBefore ? 'present' : 'absent'}->${catalogAfter ? 'present' : 'absent'}, ` +
      `home ${homeBefore ? 'present' : 'absent'}->${homeAfter ? 'present' : 'absent'}`,
  );
  if (!ok) await saveFailureSnapshot(artifacts, `catalog-${pose}`);

  if (pose === 'open') {
    let nodes = await snapshotNodes();
    const cartBefore = cartCounts(nodes);
    await tapIdentifier('add-citrus-kit', 'add to cart');
    nodes = await snapshotNodes();
    const cartAfter = cartCounts(nodes);
    record(
      'Add to cart increments the cart counter (open)',
      cartAfter.some((c, i) => c > (cartBefore[i] ?? -1)),
      `${JSON.stringify(cartBefore)} -> ${JSON.stringify(cartAfter)}`,
    );
  }
}

// The loop returns to Home before every subsequent fold. Assert Home is actually the active route so
// a missed reset surfaces here instead of being mistaken for the next pose's activation result. A
// lingering `catalog-title`/`settings-title` (a navigator that kept the screen mounted) also fails.
async function resetToHomeAndAssert(pose, artifacts) {
  if (!opts.demoSkipHomeReset) await gotoTab('Home');
  const nodes = await waitForActiveRoute('home-title', 'catalog-title');
  const home = Boolean(findByIdentifier(nodes, 'home-title'));
  const catalog = Boolean(findByIdentifier(nodes, 'catalog-title'));
  const settings = Boolean(findByIdentifier(nodes, 'settings-title'));
  const ok = home && !catalog && !settings;
  record(
    `Home is the active route before the next fold (${pose})`,
    ok,
    `home=${home} catalog=${catalog} settings=${settings}`,
  );
  if (!ok) await saveFailureSnapshot(artifacts, `home-reset-${pose}`);
}

// Item 3: scroll to reveal a canary, then long-press it and assert its dedicated count moves.
// Item 4: one multipointer pinch whose origin is derived from the current target bounds.
async function openPoseChecks() {
  await gotoTab('Settings');
  let nodes = await snapshotNodes();
  assertRecord(findByIdentifier(nodes, 'settings-title'), 'Settings surface opened (open pose)');
  await tapIdentifier('open-automation-lab', 'open automation lab');
  nodes = await snapshotNodes();
  assertRecord(findByIdentifier(nodes, 'automation-title'), 'Automation lab opened (open pose)');

  const beforeScroll = new Set(nodes.map((n) => n.identifier).filter(Boolean));
  await command(['scroll', 'down']);
  nodes = await snapshotNodes();
  const count = findByIdentifier(nodes, 'automation-longpress-count');
  record(
    'scroll reveals a new canary (open)',
    Boolean(count && !beforeScroll.has('automation-longpress-count')),
    count
      ? `automation-longpress-count visible with "${count.label}"`
      : 'automation-longpress-count still hidden',
  );

  const countBefore = Number(/Long presses:\s*(\d+)/.exec(String(count?.label))?.[1]);
  await longPressIdentifier('automation-longpress', 'long-press canary');
  nodes = await snapshotNodes();
  const after = labelOf(nodes, 'automation-longpress-count');
  const countAfter = Number(/Long presses:\s*(\d+)/.exec(String(after))?.[1]);
  // Require a strict increment, not an exact +1: a transient retry can deliver two presses, and
  // two still proves the long press registered, while zero (an unregistered press) must fail.
  record(
    'long press increments its dedicated count (open)',
    Number.isFinite(countBefore) && Number.isFinite(countAfter) && countAfter > countBefore,
    `"Long presses: ${countBefore}" -> "${after}"`,
  );

  // The automation lab is pushed over the tab stack, so return to a tab surface before the Home
  // pinch canary. Its own "Continue to catalog" control pops back onto the tab navigator.
  await tapIdentifier('automation-continue-catalog', 'continue to catalog');
  await gotoTab('Home');
  nodes = await snapshotNodes();
  const target = findByIdentifier(nodes, 'transform-gesture-target');
  if (!target) throw new Error('transform-gesture-target not present on Home in the open pose');
  const scaleBefore = parseScale(labelOf(nodes, 'gesture-transform-status'));
  let origin;
  if (opts.demoGeometryMutation) {
    // Stale/wrong geometry: derive the origin from a DIFFERENT control's bounds (the drag source,
    // above the transform target) instead of the target's own bounds. The pinch is a valid
    // in-viewport gesture that lands off-target, so the transform scale never moves.
    const wrong = findByIdentifier(nodes, 'drag-source') ?? findByIdentifier(nodes, 'home-title');
    if (!wrong)
      throw new Error('demo-geometry-mutation: no off-target control to derive wrong bounds from');
    origin = [
      Math.round(wrong.rect.x + wrong.rect.width / 2),
      Math.round(wrong.rect.y + wrong.rect.height / 2),
    ];
    process.stdout.write(`  MUTATED pinch origin (wrong control bounds): ${origin.join(',')}\n`);
  } else {
    origin = [
      Math.round(target.rect.x + target.rect.width / 2),
      Math.round(target.rect.y + target.rect.height / 2),
    ];
    process.stdout.write(`  derived pinch origin: ${origin.join(',')}\n`);
  }
  await command(['gesture', 'pinch', '1.5', String(origin[0]), String(origin[1])]);
  nodes = await snapshotNodes();
  const scaleAfter = parseScale(labelOf(nodes, 'gesture-transform-status'));
  record(
    'multipointer pinch changes recognized scale (open)',
    Number.isFinite(scaleAfter) && Math.abs(scaleAfter - 1) > 0.01,
    `scale ${scaleBefore} -> ${scaleAfter} at origin ${origin.join(',')}`,
  );
}

function assertRecord(node, name) {
  record(name, Boolean(node));
  if (!node) throw new Error(`${name}: not present`);
}

async function saveFailureSnapshot(artifacts, tag) {
  try {
    const data = await command(['snapshot', '-i'], { json: true });
    const path = join(artifacts, `${tag}-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify(data, null, 2));
    process.stdout.write(`  (failure snapshot: ${path})\n`);
    return path;
  } catch {
    return undefined;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const device = await admitDevice();
  process.stdout.write(
    `Duo pose semantic check\n  device: ${device.name} (${device.udid})\n  toolchain: ${DEVELOPER_DIR}\n  session: ${opts.session}\n  demo-geometry-mutation: ${opts.demoGeometryMutation}\n  demo-skip-home-reset: ${opts.demoSkipHomeReset}\n\n`,
  );
  mkdirSync(opts.artifactsDir, { recursive: true });

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      await fold(START_POSE);
    } catch {
      process.stderr.write('  (could not restore starting pose)\n');
    }
    await cli(['close'], { allowFail: true });
  };

  try {
    await command(['open', opts.app, '--relaunch']);
    await warmRunner();
    const nodes = await waitForIdentifier('home-title');
    record(
      'fixture surface verified (Home)',
      Boolean(findByIdentifier(nodes, 'home-title')),
      'home-title present after launch',
    );

    for (const pose of POSES) {
      await fold(pose);
      await activateCatalog(pose, opts.artifactsDir);
      if (pose === 'open') await openPoseChecks();
      await resetToHomeAndAssert(pose, opts.artifactsDir);
    }
    await cleanup();
  } catch (error) {
    process.stderr.write(`\nRUN ERROR: ${error && error.message ? error.message : error}\n`);
    await saveFailureSnapshot(opts.artifactsDir, 'run-error');
    await cleanup();
    report();
    process.exit(1);
  }

  report();
  process.exit(results.some((r) => !r.ok) ? 1 : 0);
}

function report() {
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(
    `\n${results.length - failed.length}/${results.length} semantic checks passed\n`,
  );
  if (opts.demoGeometryMutation) {
    process.stdout.write(
      '(geometry-mutation demo: the pinch scale check is EXPECTED to fail here)\n',
    );
  }
  if (opts.demoSkipHomeReset) {
    process.stdout.write(
      '(skip-home-reset demo: a closed/half-open activation or Home-reset check is EXPECTED to fail)\n',
    );
  }
  for (const r of failed) process.stdout.write(`  FAILED: ${r.name} — ${r.detail ?? ''}\n`);
}

main().catch((error) => {
  process.stderr.write(`\nUNEXPECTED: ${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
