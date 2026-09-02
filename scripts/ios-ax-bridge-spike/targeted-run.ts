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
import { runTargetedEvidence } from './targeted-evidence.ts';
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
  const evidence = await runTargetedEvidence(config);
  const target = readTarget(config.udid, 'com.callstack.agentdevicelab');
  const artifact: TargetedRawArtifact = {
    schemaVersion: TARGETED_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    revision: readGitRevision(config.repoRoot),
    command:
      'pnpm bench:ios-ax-bridge:targeted -- --udid <UDID> --guest-companion <PATH> --guest-python python3 --guest-site-packages <PATH> --apply-preferences',
    sourceArtifact: { path: SOURCE, revision: readSpikeReport(SOURCE).revision },
    target: { udid: target.udid, name: target.name, runtime: target.runtime },
    toolchain: readToolchain(),
    guestMechanism: readSpikeReport(SOURCE).guestMechanism,
    preferenceEvidence: evidence.preferenceEvidence,
    config: {
      states: ['warm', 'relaunch'],
      screens: ['quiet', 'list', 'nested-scroll', 'alert', 'system-surface', 'xctest-stress'],
      samples: 20,
      bootstrapSamples: evidence.bootstrap.length,
    },
    bootstrap: evidence.bootstrap,
    recovery: evidence.recovery,
    simulator: evidence.simulator,
  };
  fs.writeFileSync(TARGETED, gzipSync(`${JSON.stringify(artifact)}\n`, { level: 9 }));
  writeCorrectedReport(
    CORRECTED,
    buildCorrectedReport({
      sourcePath: SOURCE,
      source: readSpikeReport(SOURCE),
      targetedPath: TARGETED,
      targeted: readTargetedArtifact(TARGETED),
    }),
  );
  process.stdout.write(`${CORRECTED}\n`);
}
