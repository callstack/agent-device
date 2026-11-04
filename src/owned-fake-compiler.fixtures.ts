import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from '@agent-device/test-kit';

/** How long the never-finishing compiler outlives a test that failed to stop it, in ms. */
const SELF_BOUND_MS = 30_000;

/**
 * A `xcrun` that never finishes, so a test can watch the compiler its own spawn started and prove
 * who stops it. It answers only the Swift compile `agent-device` issues, records the pid of every
 * process this harness turned into `xcrun`, and bounds itself if nobody closes its owner. Nothing
 * here scans the process table or signals a pid the harness did not create.
 */
export type OwnedFakeCompiler = Readonly<{
  /** The one `PATH` the host under test may name: it carries only the fake `xcrun`. */
  toolchainDir: string;
  /** The Swift cache the host under test compiles into. */
  cacheDir: string;
  /** The environment the host under test must carry for the fake tool to report itself. */
  env: Readonly<Record<string, string>>;
  /** Every compiler this harness started that is still running. */
  runningCompilerPids(): number[];
  /** The cache's `bin` entries, so a lock or unpublished output can be named. */
  cacheBinEntries(): string[];
}>;

const PID_DIR_ENV = 'AGENT_DEVICE_FAKE_COMPILER_PID_DIR';

export function createOwnedFakeCompiler(name: string): OwnedFakeCompiler {
  const root = mkdtempForTestSync(name);
  const toolchainDir = path.join(root, 'toolchain');
  const pidDir = path.join(root, 'pids');
  const cacheDir = path.join(root, 'swift-cache');
  fs.mkdirSync(toolchainDir, { recursive: true });
  fs.writeFileSync(
    path.join(toolchainDir, 'xcrun'),
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      "const pidDir = require('node:path').join(__dirname, '..', 'pids');",
      `const selfBoundMs = ${SELF_BOUND_MS};`,
      'const args = process.argv.slice(2);',
      "if (args.length < 5 || args[0] !== '--no-cache' || args[1] !== 'swiftc' || args[args.length - 2] !== '-o' || !args[args.length - 1]) {",
      '  console.error(`fake xcrun: expected swiftc <source.swift>... -o <output>; got ${JSON.stringify(args)}`);',
      '  process.exit(2);',
      '}',
      "process.on('SIGINT', () => process.exit(0));",
      "process.on('SIGTERM', () => process.exit(0));",
      'fs.mkdirSync(pidDir, { recursive: true });',
      'fs.writeFileSync(`${pidDir}/${process.pid}`, process.argv.slice(2).join(" "));',
      // A test that never reached its shutdown still gives this compiler back on its own, so no
      // harness leaves a spinning child behind for the next worker or the next run to inherit.
      'setTimeout(() => process.exit(0), selfBoundMs);',
      'setInterval(() => {}, 1_000);',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return {
    toolchainDir,
    cacheDir,
    env: { [PID_DIR_ENV]: pidDir, AGENT_DEVICE_SWIFT_CACHE_DIR: cacheDir },
    runningCompilerPids: () => readPids(pidDir).filter(isProcessAlive),
    cacheBinEntries: () => {
      try {
        return fs.readdirSync(path.join(cacheDir, 'bin'));
      } catch {
        return [];
      }
    },
  };
}

function readPids(pidDir: string): number[] {
  try {
    return fs
      .readdirSync(pidDir)
      .map(Number)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 is a liveness probe, which the unit-test signal guard always allows.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
