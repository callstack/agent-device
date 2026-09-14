import type { ScenarioSample } from './pipelines.ts';
import { speedup } from './statistics.ts';

/** The benchmark's report: one row per capture and crop box, plus the corpus honesty check. */

const COLUMN_WIDTHS: readonly number[] = [30, 11, 13, 11, 10, 22];

export function renderReport(samples: readonly ScenarioSample[]): string {
  const rows = [
    renderRow(['capture / crop', 'box', 'whole-image', 'region', 'speed-up', 'artifact']),
    renderRow(['-', '-', '-', '-', '-', '-']),
    ...samples.map((sample) =>
      renderRow([
        `${sample.capture} ${sample.scenario}`,
        `${sample.box.width}x${sample.box.height}`,
        `${sample.wholeImage.medianMs.toFixed(1)}ms`,
        `${sample.region.medianMs.toFixed(1)}ms`,
        `${speedup(sample.wholeImage.medianMs, sample.region.medianMs).toFixed(2)}x`,
        `${kilobytes(sample.wholeImage.outBytes)} -> ${kilobytes(sample.region.outBytes)}`,
      ]),
    ),
  ];
  return [...rows, '', footnotes(samples)].join('\n');
}

function footnotes(samples: readonly ScenarioSample[]): string {
  const timings = 'median of the measured rounds; artifact = encoded crop, whole-image -> region';
  const corpus = [...new Map(samples.map((sample) => [sample.capture, sample])).values()].map(
    (sample) => `  ${sample.label}: ${(sample.captureBytes / 1024).toFixed(0)} kB compressed`,
  );
  return [
    timings,
    '',
    'Corpus compressed sizes, so an unrealistic corpus is visible. A real 1206x2622 simulator',
    'capture of a UI screen is ~245 kB, and the same device showing a photo screen is ~3 MB.',
    ...corpus,
  ].join('\n');
}

function renderRow(cells: readonly string[]): string {
  return cells
    .map((cell, index) => cell.padEnd(COLUMN_WIDTHS[index] ?? cell.length))
    .join('  ')
    .trimEnd();
}

function kilobytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)}kB`;
}
