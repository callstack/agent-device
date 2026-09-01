import { LOCAL_STATES, SCREEN_FIXTURES } from '../ios-snapshot-benchmark/definitions.ts';
import type { LocalState, ScreenId } from '../ios-snapshot-benchmark/types.ts';
import type { CandidateId, SpikeReport } from './types.ts';

const FULL_STATES = LOCAL_STATES;
const FULL_SCREENS = SCREEN_FIXTURES.map((fixture) => fixture.id);

export function corpusCoverage(
  states: readonly LocalState[],
  screens: readonly ScreenId[],
  cells: SpikeReport['cells'],
  candidates: readonly CandidateId[],
): SpikeReport['corpusCoverage'] {
  const fullRequested =
    FULL_STATES.every((state) => states.includes(state)) &&
    FULL_SCREENS.every((screen) => screens.includes(screen));
  if (!fullRequested || cells.length === 0) return 'decisive-early-stop';
  const fullProduced = candidates.every((candidate) =>
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
