import { aggregateProfiles } from './profile.ts';
import { summarize } from './stats.ts';
import type { Measurement } from './types.ts';

type MeasurementInput = Omit<
  Measurement,
  'wallClock' | 'daemon' | 'elementCount' | 'profile' | 'failures' | 'notes'
>;

function numbers(values: (number | undefined)[]): number[] {
  return values.filter((n): n is number => typeof n === 'number');
}

/** Summarizes the successful samples; failed samples count only toward `failures`. */
export function buildMeasurement(input: MeasurementInput): Measurement {
  const ok = input.samples.filter((s) => s.ok);
  const failures = input.samples.length - ok.length;
  const notes: string[] = [];
  if (failures > 0) {
    const codes = [...new Set(input.samples.filter((s) => !s.ok).map((s) => s.errorCode))];
    notes.push(`${failures}/${input.samples.length} failed: ${codes.join(', ')}`);
  }
  return {
    ...input,
    wallClock: summarize(ok.map((s) => s.wallClockMs)),
    daemon: summarize(numbers(ok.map((s) => s.daemonMs))),
    elementCount: summarize(numbers(ok.map((s) => s.elementCount ?? s.snapshot?.nodeCount))),
    profile: aggregateProfiles(input.samples),
    failures,
    notes,
  };
}
