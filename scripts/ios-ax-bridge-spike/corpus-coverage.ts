import type { LocalState, ScreenId } from '../ios-snapshot-benchmark/types.ts';
import type { SpikeReport } from './types.ts';

const FULL_STATES = ['cold-cold', 'cold', 'warm', 'relaunch'] as const;
const FULL_SCREENS = [
  'quiet',
  'list',
  'nested-scroll',
  'alert',
  'system-surface',
  'xctest-stress',
] as const;

export function corpusCoverage(
  states: readonly LocalState[],
  screens: readonly ScreenId[],
  cells: SpikeReport['cells'],
): SpikeReport['corpusCoverage'] {
  const fullRequested =
    FULL_STATES.every((state) => states.includes(state)) &&
    FULL_SCREENS.every((screen) => screens.includes(screen));
  if (!fullRequested || cells.length === 0) return 'decisive-early-stop';
  const exercisedCandidates = new Set(cells.map((cell) => cell.candidate));
  const fullProduced = [...exercisedCandidates].every((candidate) =>
    FULL_STATES.every((state) =>
      FULL_SCREENS.every((screen) =>
        cells.some(
          (cell) =>
            cell.candidate === candidate &&
            cell.state === state &&
            cell.screen === screen &&
            cell.acquisitionSamples.length >= cell.sampleMinimum,
        ),
      ),
    ),
  );
  return fullProduced ? 'full' : 'decisive-early-stop';
}
