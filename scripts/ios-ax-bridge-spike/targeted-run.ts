import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseConfig } from './config.ts';
import {
  buildCorrectedReport,
  readSpikeReport,
  readTargetedArtifact,
  writeCorrectedReport,
} from './corrected-report.ts';
import { readVerifiedGuestMechanism } from './guest-binary.ts';
import { runTargetedEvidence } from './targeted-evidence.ts';
import { TARGETED_RELAUNCH_SAMPLES, TARGETED_RELAUNCH_SCREENS } from './targeted-relaunch.ts';
import { TARGETED_SCHEMA_VERSION, type TargetedRawArtifact } from './corrected-types.ts';
import { readGitRevision, readTarget, readToolchain } from '../ios-snapshot-benchmark/host.ts';

const SOURCE = 'docs/evidence/ios-simulator-ax-bridge-2026-09-01-final.json.gz';
const TARGETED = 'docs/evidence/ios-simulator-ax-bridge-2026-09-02-targeted.json.gz';
const CORRECTED = 'docs/evidence/ios-simulator-ax-bridge-2026-09-02-corrected.json.gz';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}

async function main(argv: readonly string[]): Promise<void> {
  const config = parseConfig(argv);
  try {
    await capture(config);
  } finally {
    fs.rmSync(config.stateDir, { recursive: true, force: true });
  }
}

async function capture(config: ReturnType<typeof parseConfig>): Promise<void> {
  const revision = readGitRevision(config.repoRoot);
  if (revision.dirty) {
    throw new Error('Targeted bridge evidence must be captured from a clean Git revision.');
  }
  const guestMechanism = readVerifiedGuestMechanism(config.guestBridge);
  const source = readSpikeReport(SOURCE);
  const evidence = await runTargetedEvidence(config);
  const target = readTarget(config.udid, 'com.callstack.agentdevicelab');
  const artifact: TargetedRawArtifact = {
    schemaVersion: TARGETED_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    revision,
    command:
      'pnpm bench:ios-ax-bridge:targeted -- --udid <UDID> --guest-bridge <PATH>/Resources/SimulatorFrameworkBridge',
    sourceArtifact: {
      path: SOURCE,
      revision: source.revision,
      hostClient: String((source.guestMechanism as { client?: unknown }).client ?? 'unknown'),
    },
    target: { udid: target.udid, name: target.name, runtime: target.runtime },
    toolchain: readToolchain(),
    host: evidence.host,
    guestMechanism,
    limits: config.limits,
    config: {
      states: ['warm', 'relaunch'],
      screens: TARGETED_RELAUNCH_SCREENS,
      samples: TARGETED_RELAUNCH_SAMPLES,
      bootstrapSamples: evidence.bootstrap.length,
    },
    bootstrap: evidence.bootstrap,
    relaunch: evidence.relaunch,
    recovery: evidence.recovery,
  };
  fs.writeFileSync(TARGETED, gzipSync(`${JSON.stringify(artifact)}\n`, { level: 9 }));
  writeCorrectedReport(
    CORRECTED,
    buildCorrectedReport({
      sourcePath: SOURCE,
      source,
      targetedPath: TARGETED,
      targeted: readTargetedArtifact(TARGETED),
    }),
  );
  process.stdout.write(`${CORRECTED}\n`);
}
