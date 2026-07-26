#!/usr/bin/env node
// Regenerates the checked-in layer-1 and layer-2 fixtures from the pinned
// upstream Maestro artifacts. This is a manual, toolchain-heavy operation run
// ONLY when the upstream pin changes — normal CI verifies the checked-in
// fixtures deterministically (no Java) via `verify.ts`.
//
// Steps:
//   1. Resolve the pinned dev.mobile jars via the Gradle harness.
//   2. Verify each pinned artifact's SHA-256 against `pinned-upstream.json`
//      (the integrity gate the old hand-typed harness never enforced).
//   3. Run the harness over the corpus to emit generated layer-1/layer-2 JSON.
//   4. Wrap each with the upstream pin and write it to `fixtures/`.
//
// Requirements: JDK 17+. Gradle is provided by the committed wrapper
// (`jvm-harness/gradlew`); override with MAESTRO_CONFORMANCE_GRADLE to reuse an
// existing Gradle install.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeManifest } from './build-manifest.mjs';
import { fixtureContentHash } from './fixture-seal.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = path.join(HERE, 'jvm-harness');
const CORPUS_DIR = path.join(HERE, 'corpus');
const FIXTURES_DIR = path.join(HERE, 'fixtures');

function readPin() {
  return JSON.parse(fs.readFileSync(path.join(HERE, 'pinned-upstream.json'), 'utf8'));
}

function gradle(args, options = {}) {
  const override = process.env.MAESTRO_CONFORMANCE_GRADLE;
  const [cmd, baseArgs] = override
    ? [override, []]
    : [process.platform === 'win32' ? 'gradlew.bat' : './gradlew', []];
  return execFileSync(cmd, [...baseArgs, '-p', HARNESS_DIR, '--no-daemon', '--console=plain', '-q', ...args], {
    cwd: HARNESS_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  });
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function verifyArtifacts(pin) {
  const output = gradle(['printUpstreamJars']);
  const resolved = new Map();
  for (const line of output.split('\n')) {
    const match = /^UPSTREAM_JAR (\S+):(\S+) (.+)$/.exec(line.trim());
    if (match) resolved.set(`dev.mobile:${match[1]}:${match[2]}`, match[3]);
  }
  for (const artifact of pin.artifacts) {
    const jarPath = resolved.get(artifact.coordinate);
    if (!jarPath) throw new Error(`Pinned artifact ${artifact.coordinate} was not resolved by Gradle.`);
    const actual = sha256(jarPath);
    if (actual !== artifact.sha256) {
      throw new Error(
        `SHA-256 mismatch for ${artifact.coordinate}\n  pinned:   ${artifact.sha256}\n  resolved: ${actual}\n  ${jarPath}`,
      );
    }
    console.log(`verified ${artifact.coordinate} (${actual.slice(0, 12)}…)`);
  }
}

function writeFixture(name, pin, content) {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  const { version, tag, commit, project } = pin;
  const wrapped = {
    schemaVersion: 2,
    generatedBy: 'scripts/maestro-conformance/regenerate.mjs',
    upstream: { project, version, tag, commit, artifacts: pin.artifacts },
    ...content,
  };
  // Seal the generated content. Verifying only the embedded upstream pin would
  // let a hand edit to the captured commands/constants pass CI — which is the
  // exact transcription failure mode this oracle exists to remove. The seal is
  // recomputed on every verify run, so an edit must also forge the hash; the
  // scheduled conformance-regenerate job then re-derives from upstream and fails
  // on any byte difference, which forgery cannot survive.
  const wrappedWithSeal = { ...wrapped, contentHash: fixtureContentHash(wrapped) };
  const target = path.join(FIXTURES_DIR, name);
  fs.writeFileSync(target, `${JSON.stringify(wrappedWithSeal, null, 2)}\n`);
  console.log(`wrote ${path.relative(HERE, target)}`);
}

function main() {
  const pin = readPin();
  console.log(`Regenerating Maestro ${pin.version} conformance fixtures (${pin.commit.slice(0, 12)}).`);

  // Refresh corpus provenance first so a newly added flow is picked up.
  const manifest = writeManifest(pin);
  console.log(`corpus manifest: ${manifest.flows.length} flows`);

  verifyArtifacts(pin);

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-conformance-'));
  try {
    gradle(['run', `--args=--corpus ${CORPUS_DIR} --out ${outDir}`], { stdio: 'inherit' });
    const layer1 = JSON.parse(fs.readFileSync(path.join(outDir, 'layer1-parser.json'), 'utf8'));
    const layer2 = JSON.parse(fs.readFileSync(path.join(outDir, 'layer2-semantics.json'), 'utf8'));
    writeFixture('layer1-parser.json', pin, layer1);
    writeFixture('layer2-semantics.json', pin, layer2);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  console.log('Done. Review the diff, then run `node --experimental-strip-types scripts/maestro-conformance/verify.test.ts`.');
}

main();
