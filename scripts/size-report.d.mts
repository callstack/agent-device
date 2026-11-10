// Type surface for the plain-Node size report (it must stay runnable by bare `node`).
// Keep it in step with the exports of `./size-report.mjs`.
export type SizeReport = Readonly<{
  npmPack: Readonly<{ tarballBytes: number; unpackedBytes: number }>;
  cleanInstalled: Readonly<{ totalBytes: number }>;
  startup?: Readonly<{
    runs: number;
    benchmarks: readonly Readonly<{ name: string; medianMs: number }>[];
  }>;
}>;

export function formatMarkdown(report: SizeReport, baseReport: SizeReport | null): string;
