import { legacyDispatchCapture } from '../../__tests__/legacy-snapshot-capture-fixture.ts';
import { IOS_SIMULATOR } from '../../../__tests__/test-utils/device-fixtures.ts';
import {
  getRuntimeBindings,
  mockFillPoint,
  mockFocusPoint,
  mockTapPoint,
  resetGetRuntimeFixture,
} from './interaction-get-runtime-fixture.ts';

export { mockFocusPoint };
export const findTouchRuntimeBindings = getRuntimeBindings;
/**
 * Find's delegated touch legs record their calls on the shared capture double, so the suite can
 * assert which command each leg re-invoked without a dispatcher to observe (R58).
 */
export const mockDispatch = legacyDispatchCapture;

export function resetFindTouchRuntimeFixture(): void {
  resetGetRuntimeFixture();
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockImplementation(async (_device: unknown, command: string) => {
    return command === 'snapshot' ? { nodes: [] } : {};
  });
  mockTapPoint.mockImplementation(async (input) => {
    return await legacyDispatchCapture(
      IOS_SIMULATOR,
      'press',
      [String(input.point.x), String(input.point.y)],
      undefined,
      input.execution,
    );
  });
  mockFillPoint.mockImplementation(async (input) => {
    return await legacyDispatchCapture(
      IOS_SIMULATOR,
      'fill',
      [String(input.point.x), String(input.point.y), input.text],
      undefined,
      input.execution,
    );
  });
}
