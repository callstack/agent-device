#!/usr/bin/env node
// Throwaway prototype (NOT product code): validate device/artifact -> simulator app-data transfer.
// Self-contained: execFile + node:fs only, per the ".mjs cannot import TS helpers" rule.
//
//   export --device <id> --app <bundleId> --out <dir> [--container data|groups]
//   import --device <id> --app <bundleId> --from <dir>
//
// Interchange format is a PLAIN DIRECTORY (the simulator's data container tree), which we proved
// round-trips reliably. `.xcappdata` + `simctl install_app_data` is rejected as the primary format:
// it needs Xcode's undocumented AppDataInfo.plist schema and is flaky device->sim (see notes).
import { execFile } from 'node:child_process';
import { cp, rm, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 1 << 26 }, (error, stdout, stderr) =>
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
    );
  });

const xcrun = (...args) => exec('xcrun', args);
const need = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

// `simctl get_app_container` only resolves for simulators; a miss means a physical CoreDevice.
async function simDataContainer(device, bundle, container) {
  const { code, stdout } = await xcrun('simctl', 'get_app_container', device, bundle, container);
  const dir = stdout.trim();
  return code === 0 && dir.startsWith('/') ? dir : null;
}

async function exportSimulator(containerPath, outDir) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await cp(containerPath, outDir, { recursive: true });
}

async function importSimulator(device, bundle, fromDir) {
  await xcrun('simctl', 'terminate', device, bundle); // best-effort; may not be running
  const dest = await simDataContainer(device, bundle, 'data');
  if (!dest) throw new Error(`no data container for ${bundle}; install & launch the app first`);
  // Replace contents, keep the container dir itself (matches "clear app state" behavior).
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  await cp(fromDir, dest, { recursive: true });
}

// Physical device: one devicectl call each way (verified flag surface on the Xcode 27 seed;
// needs a dev-signed/debuggable build for house-arrest access — a release build cannot be pulled).
async function exportDevice(device, bundle, outDir, domainType) {
  const { code, stderr } = await xcrun(
    'devicectl', 'device', 'copy', 'from', '--device', device,
    '--domain-type', domainType, '--domain-identifier', bundle,
    '--source', '.', '--destination', outDir, '-r', 'true',
  );
  if (code !== 0) throw new Error(`devicectl copy from failed: ${stderr.trim()}`);
}

async function main() {
  const [command] = process.argv.slice(2);
  const device = need('device');
  const app = need('app');
  const container = need('container') ?? 'data';
  if (!command || !device || !app) {
    console.error('usage: export|import --device <id> --app <bundleId> --out|--from <dir>');
    process.exit(2);
  }

  if (command === 'export') {
    const outDir = need('out') ?? (await mkdtemp(path.join(tmpdir(), 'ad-export-')));
    const sim = await simDataContainer(device, app, container);
    if (sim) {
      await exportSimulator(sim, outDir);
      console.log(`exported simulator ${app} -> ${outDir}`);
    } else {
      const domainType = container === 'groups' ? 'appGroupDataContainer' : 'appDataContainer';
      await exportDevice(device, app, outDir, domainType);
      console.log(`exported device ${app} -> ${outDir}`);
    }
    return;
  }

  if (command === 'import') {
    const fromDir = need('from');
    if (!fromDir) throw new Error('import requires --from <dir>');
    // Scope today: import targets a simulator (the reported value: reproduce tester state locally).
    await importSimulator(device, app, fromDir);
    console.log(`imported ${fromDir} -> simulator ${app}`);
    return;
  }

  throw new Error(`unknown command ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
