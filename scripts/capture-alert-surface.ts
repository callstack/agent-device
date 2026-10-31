// Records an app's whole accessibility tree from a booted iOS simulator into the alert surface
// corpus that `swift test --package-path apple/snapshot-presentation` replays. See
// apple/snapshot-presentation/Tests/AlertSurfaceCorpus/README.md.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    udid: { type: 'string' },
    bundle: { type: 'string' },
    name: { type: 'string' },
  },
});
const { udid, bundle, name } = values;
if (!udid || !bundle || !name || !/^[a-z0-9-]+$/.test(name)) {
  throw new Error(
    'Usage: pnpm capture:alert-surface --udid <simulator> --bundle <bundle id> --name <kebab-case-name>',
  );
}

const root = path.resolve(import.meta.dirname, '..');
const derived = path.join(root, '.tmp', 'alert-surface-runner');
const fixture = path.join(
  root,
  'apple/snapshot-presentation/Tests/AlertSurfaceCorpus',
  `${name}.json`,
);

execFileSync('sh', ['./scripts/build-xcuitest-apple.sh'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    AGENT_DEVICE_XCUITEST_PLATFORM: 'ios',
    AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS: '1',
    AGENT_DEVICE_XCUITEST_ARCHS: 'arm64',
    AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH: derived,
    AGENT_DEVICE_XCUITEST_DESTINATION: 'generic/platform=iOS Simulator',
  },
});
const products = path.join(derived, 'Build', 'Products');
const xctestrun = fs.readdirSync(products).find((file) => file.endsWith('.xctestrun'));
if (!xctestrun) throw new Error(`No .xctestrun in ${products}`);

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-surface-'));
const output = path.join(outputDir, 'tree.json');
let nodes: unknown[];
try {
  execFileSync(
    'xcodebuild',
    [
      'test-without-building',
      '-xctestrun',
      path.join(products, xctestrun),
      '-destination',
      `platform=iOS Simulator,id=${udid}`,
      '-only-testing:AgentDeviceRunnerUITests/RunnerTests/testCaptureAlertSurfaceTree',
    ],
    {
      stdio: 'inherit',
      // xcodebuild strips the TEST_RUNNER_ prefix before the test process reads these.
      env: {
        ...process.env,
        TEST_RUNNER_AGENT_DEVICE_ALERT_SURFACE_BUNDLE_ID: bundle,
        TEST_RUNNER_AGENT_DEVICE_ALERT_SURFACE_OUTPUT: output,
      },
    },
  );
  if (!fs.existsSync(output)) throw new Error('The capture test wrote no tree');
  nodes = JSON.parse(fs.readFileSync(output, 'utf8')) as unknown[];
} finally {
  fs.rmSync(outputDir, { recursive: true, force: true });
}

const devices = JSON.parse(
  execFileSync('xcrun', ['simctl', 'list', 'devices', '-j'], { encoding: 'utf8' }),
) as { devices: Record<string, Array<{ udid: string; name: string }>> };
const [runtime, device] =
  Object.entries(devices.devices)
    .flatMap(([key, list]) => list.map((entry) => [key, entry] as const))
    .find(([, entry]) => entry.udid === udid) ?? [];
const previous = fs.existsSync(fixture)
  ? (JSON.parse(fs.readFileSync(fixture, 'utf8')) as {
      expect?: unknown;
      nearMisses?: unknown;
      nearMissesOmitting?: unknown;
    })
  : {};
const recorded = {
  capture: {
    bundle,
    device: device?.name ?? udid,
    runtime: runtime?.replace('com.apple.CoreSimulator.SimRuntime.', '') ?? 'unknown',
    commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
  },
  ...(previous.expect === undefined ? {} : { expect: previous.expect }),
  // A recapture re-records `nodes`, never what the rules were checked to report, so both keys
  // survive a recapture the way `expect` does.
  ...(previous.nearMisses === undefined ? {} : { nearMisses: previous.nearMisses }),
  ...(previous.nearMissesOmitting === undefined
    ? {}
    : { nearMissesOmitting: previous.nearMissesOmitting }),
};
// One node per line, so a recapture reads as a reviewable diff of changed nodes.
const header = JSON.stringify(recorded, null, 2).replace(/\n}$/, '');
const body = nodes.map((node) => `    ${JSON.stringify(node)}`).join(',\n');
fs.writeFileSync(fixture, `${header},\n  "nodes": [\n${body}\n  ]\n}\n`);
console.log(
  previous.expect === undefined
    ? `Wrote ${path.relative(root, fixture)}. Add "expect" from what the screen shows.`
    : `Wrote ${path.relative(root, fixture)}. Kept its "expect".`,
);
