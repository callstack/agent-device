import type { BenchmarkResult, Measurement, PackageSize, Summary } from './types.ts';

export function renderBenchmarkMarkdown(result: BenchmarkResult): string {
  const lines = [
    '# iOS snapshot convergence benchmark',
    '',
    `- Status: **${result.status}**`,
    `- Revision: ${result.revision.commit}`,
    `- Host: ${result.host.model} (${result.host.modelIdentifier}; ${result.host.cpu}, ${result.host.cpuCores} cores)`,
    `- Target: ${result.target.name} (${result.target.udid}, ${result.target.runtime})`,
    `- Generated: ${result.generatedAt}`,
    '',
    '| State | Screen | Transport | Execution | N | Wall median | Wall p95 | Daemon median | Response median | Failures |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---:|',
    ...result.measurements.map(measurementRow),
    '',
    '## Package size',
    '',
    packageSizeLines(result),
    '',
    '## Deep-button control',
    '',
    `- Fixture artifact: ${result.deepButtonEvidence.artifact} (depth ${result.deepButtonEvidence.depth})`,
    `- Red control: ${result.deepButtonEvidence.invalidShallowRule.command} (exit ${result.deepButtonEvidence.invalidShallowRule.exitCode})`,
    `  - ${result.deepButtonEvidence.invalidShallowRule.assertion}`,
    `- Safe control: ${result.deepButtonEvidence.safeFullRule.command} (exit ${result.deepButtonEvidence.safeFullRule.exitCode})`,
    `  - ${result.deepButtonEvidence.safeFullRule.assertion}`,
  ];
  if (result.stop) {
    lines.push('', '## Stop condition', '', `- ${result.stop.category}: ${result.stop.message}`);
    if (result.stop.reason) lines.push(`- Reason: ${result.stop.reason}`);
    if (result.stop.command) lines.push(`- Command: ${result.stop.command}`);
  }
  return `${lines.join('\n')}\n`;
}

function measurementRow(measurement: Measurement): string {
  return `| ${[
    measurement.state,
    measurement.screen,
    measurement.transport,
    measurement.execution,
    measurement.wallClockMs?.n ?? 0,
    formatSummaryValue(measurement.wallClockMs, 'median'),
    formatSummaryValue(measurement.wallClockMs, 'p95'),
    formatSummaryValue(measurement.daemonDurationMs, 'median'),
    formatSummaryValue(measurement.responseBytes, 'median'),
    measurement.failures,
  ].join(' | ')} |`;
}

function formatSummaryValue(summary: Summary | null, key: 'median' | 'p95'): string {
  return summary ? `${summary[key].toFixed(1)}` : '–';
}

function packageSizeLines(result: BenchmarkResult): string {
  const packageSize = result.packageSize;
  if (packageSize.status !== 'measured') return 'Not measured.';
  return measuredPackageSizeLines(packageSize);
}

function measuredPackageSizeLines(packageSize: PackageSize & { status: 'measured' }): string {
  return [
    ...packedSizeLines(packageSize),
    cleanInstalledSizeLine(packageSize),
    bundledSizeLine(packageSize),
  ].join('\n');
}

function packedSizeLines(packageSize: PackageSize): string[] {
  const packed = packageSize.packed;
  return [
    packageSizeLine('Packed tarball', packed?.tarballBytes),
    packageSizeLine('Packed unpacked tree', packed?.unpackedBytes),
  ];
}

function cleanInstalledSizeLine(packageSize: PackageSize): string {
  const cleanInstalled = packageSize.cleanInstalled;
  return packageTreeLine(
    'Clean-installed package tree',
    cleanInstalled?.packageBytes,
    cleanInstalled?.files,
  );
}

function bundledSizeLine(packageSize: PackageSize): string {
  const bundled = packageSize.bundled;
  return packageBundleLine('Bundled JavaScript', bundled?.rawBytes, bundled?.gzipBytes);
}

function packageSizeLine(label: string, bytes: number | undefined): string {
  return `- ${label}: ${bytes ?? '–'} bytes`;
}

function packageTreeLine(
  label: string,
  bytes: number | undefined,
  files: number | undefined,
): string {
  return `- ${label}: ${bytes ?? '–'} bytes (${files ?? '–'} files)`;
}

function packageBundleLine(
  label: string,
  raw: number | undefined,
  gzip: number | undefined,
): string {
  return `- ${label}: ${raw ?? '–'} raw / ${gzip ?? '–'} gzip bytes`;
}
