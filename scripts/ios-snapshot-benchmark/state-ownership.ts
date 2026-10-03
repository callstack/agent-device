import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BenchmarkCellAdmissionError } from './lifecycle.ts';

const BENCHMARK_OWNER_MARKER = '.agent-device-ios-snapshot-benchmark-owner';
const BENCHMARK_OWNER_MARKER_CONTENT = 'agent-device-ios-snapshot-benchmark.v1\n';

export function createBenchmarkStateRoot(): string {
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-ios-benchmark-'));
  fs.writeFileSync(path.join(ownerRoot, BENCHMARK_OWNER_MARKER), BENCHMARK_OWNER_MARKER_CONTENT, {
    flag: 'wx',
  });
  return ownerRoot;
}

export function assertBenchmarkOwner(ownerRoot: string): void {
  const resolvedOwnerRoot = path.resolve(ownerRoot);
  if (!fs.existsSync(resolvedOwnerRoot)) {
    throw ownershipError(`Benchmark state directory must already exist: ${resolvedOwnerRoot}`);
  }
  const rootStat = fs.lstatSync(resolvedOwnerRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw ownershipError(
      `Benchmark state directory must be a real directory: ${resolvedOwnerRoot}`,
    );
  }
  const markerPath = path.join(resolvedOwnerRoot, BENCHMARK_OWNER_MARKER);
  if (!fs.existsSync(markerPath)) {
    throw ownershipError(`Benchmark state directory is not benchmark-owned: ${resolvedOwnerRoot}`);
  }
  const markerStat = fs.lstatSync(markerPath);
  if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
    throw ownershipError(`Benchmark owner marker must be a regular file: ${markerPath}`);
  }
  if (fs.readFileSync(markerPath, 'utf8') !== BENCHMARK_OWNER_MARKER_CONTENT) {
    throw ownershipError(`Benchmark owner marker is invalid: ${markerPath}`);
  }
}

export function assertOwnedDerivedPath(derivedPath: string, ownerRoot: string): void {
  assertBenchmarkOwner(ownerRoot);
  const resolvedOwnerRoot = path.resolve(ownerRoot);
  const resolvedDerivedPath = path.resolve(derivedPath);
  if (!isDescendant(resolvedDerivedPath, resolvedOwnerRoot)) {
    throw ownershipError(
      'Derived-data path must be a descendant of the benchmark state directory.',
    );
  }
  if (fs.existsSync(resolvedDerivedPath) && fs.lstatSync(resolvedDerivedPath).isSymbolicLink()) {
    throw ownershipError(`Derived-data path must not be a symbolic link: ${resolvedDerivedPath}`);
  }
  const realOwnerRoot = fs.realpathSync.native(resolvedOwnerRoot);
  const realExistingParent = fs.realpathSync.native(findExistingPath(resolvedDerivedPath));
  if (!isDescendantOrSame(realExistingParent, realOwnerRoot)) {
    throw ownershipError('Derived-data path resolves outside the benchmark state directory.');
  }
}

export function clearDerivedData(derivedPath: string, ownerRoot: string): void {
  assertOwnedDerivedPath(derivedPath, ownerRoot);
  if (fs.existsSync(derivedPath)) fs.rmSync(derivedPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(derivedPath), { recursive: true });
}

function ownershipError(message: string): BenchmarkCellAdmissionError {
  return new BenchmarkCellAdmissionError('derived-path', message);
}

function isDescendant(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isDescendantOrSame(candidate: string, root: string): boolean {
  return candidate === root || isDescendant(candidate, root);
}

function findExistingPath(target: string): string {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw ownershipError(`Could not resolve derived-data parent: ${target}`);
    }
    current = parent;
  }
  return current;
}
