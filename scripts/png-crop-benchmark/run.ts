import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { terminatePngWorker } from '@agent-device/capture-kit/png-worker-client';
import { parseBenchmarkArgs } from './args.ts';
import { buildCorpus, CROP_SCENARIOS, readCaptureFile, type Capture } from './corpus.ts';
import { sampleScenario, type ScenarioSample } from './pipelines.ts';
import { renderReport } from './report.ts';

/**
 * `pnpm bench:png-crop` — a cheap, device-free comparison of the two crop pipelines over generated
 * captures. Pass `--file <png>` (repeatable) to add real captures to the same table.
 */

const CORPUS_DIR = path.join('.tmp', 'png-crop-benchmark');

async function main(): Promise<void> {
  const options = parseBenchmarkArgs(process.argv.slice(2));
  const captures: Capture[] = [
    ...buildCorpus(CORPUS_DIR),
    ...options.captureFiles.map((filePath, index) => readCaptureFile(filePath, index + 1)),
  ];
  process.stderr.write(
    `[png-crop-bench] ${captures.length} captures x ${CROP_SCENARIOS.length} crop boxes, ${options.rounds} rounds each\n`,
  );
  try {
    const samples = await sampleAll(captures, options.rounds);
    process.stdout.write(`${renderReport(samples)}\n`);
    writeJsonReport(options.jsonPath, options.rounds, samples);
  } finally {
    await terminatePngWorker();
  }
}

async function sampleAll(captures: readonly Capture[], rounds: number): Promise<ScenarioSample[]> {
  const samples: ScenarioSample[] = [];
  for (const capture of captures) {
    for (const scenario of CROP_SCENARIOS) {
      samples.push(await sampleScenario(capture, scenario, rounds));
    }
  }
  return samples;
}

function writeJsonReport(jsonPath: string | undefined, rounds: number, samples: unknown): void {
  if (jsonPath === undefined) return;
  mkdirSync(path.dirname(path.resolve(jsonPath)), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify({ rounds, samples }, null, 2)}\n`);
  process.stderr.write(`[png-crop-bench] json: ${jsonPath}\n`);
}

await main();
