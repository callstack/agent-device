import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function readSnapshotData(snapshot) {
  if (!isSuccessfulSnapshotEnvelope(snapshot)) throw invalidSnapshotEnvelope();
  if (!hasSnapshotNodes(snapshot.data)) throw invalidSnapshotEnvelope();
  return snapshot.data;
}

function isSuccessfulSnapshotEnvelope(value) {
  return isRecord(value) && value.success === true;
}

function hasSnapshotNodes(value) {
  return isRecord(value) && Array.isArray(value.nodes);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object';
}

function invalidSnapshotEnvelope() {
  return new Error('Expected the public successful snapshot JSON envelope with a nodes array');
}

function readSnapshotLabels(data) {
  return data.nodes.map((node) => String(node.label ?? ''));
}

function assertHelperBackend(metadata) {
  if (metadata.backend !== 'android-helper') {
    throw new Error(`Expected android-helper backend, received ${metadata.backend}`);
  }
}

function assertHelperVersion(metadata, packageVersion) {
  if (metadata.helperVersion !== packageVersion) {
    throw new Error(
      `Expected helper version ${packageVersion}, received ${metadata.helperVersion}`,
    );
  }
}

function assertFixtureHomeScreen(labels, expectedAppId) {
  if (!labels.includes('Agent Device Tester')) {
    throw new Error(`Expected ${expectedAppId} home screen, received labels: ${labels.join(', ')}`);
  }
}

function assertForegroundApp(data, expectedAppId) {
  if (data.appBundleId !== expectedAppId) {
    throw new Error(
      `Expected foreground app ${expectedAppId}, received ${String(data.appBundleId)}`,
    );
  }
}

export function assertAndroidFixtureSnapshot(snapshot, expectedAppId, packageVersion) {
  const data = readSnapshotData(snapshot);
  const metadata = data.androidSnapshot;
  assertHelperBackend(metadata);
  assertHelperVersion(metadata, packageVersion);
  assertForegroundApp(data, expectedAppId);
  assertFixtureHomeScreen(readSnapshotLabels(data), expectedAppId);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [snapshotPath, expectedAppId] = process.argv.slice(2);
  if (!snapshotPath || !expectedAppId) {
    throw new Error('Usage: assert-android-fixture-snapshot.mjs <snapshot-path> <app-id>');
  }
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url));
  const packageVersion = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version;
  assertAndroidFixtureSnapshot(snapshot, expectedAppId, packageVersion);
}
