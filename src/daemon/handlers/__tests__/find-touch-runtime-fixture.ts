import { vi } from 'vitest';
import { IOS_SIMULATOR } from '../../../__tests__/test-utils/device-fixtures.ts';
import { dispatchCommand } from '../../../core/dispatch.ts';
import {
  getRuntimeBindings,
  mockFillPoint,
  mockFocusPoint,
  mockTapPoint,
  resetGetRuntimeFixture,
} from './interaction-get-runtime-fixture.ts';

export { mockFocusPoint };
export const findTouchRuntimeBindings = getRuntimeBindings;
export const mockDispatch = vi.mocked(dispatchCommand);

export function resetFindTouchRuntimeFixture(): void {
  resetGetRuntimeFixture();
  mockDispatch.mockReset();
  mockDispatch.mockImplementation(async (_device: unknown, command: string) => {
    return command === 'snapshot' ? { nodes: [] } : {};
  });
  mockTapPoint.mockImplementation(async (input) => {
    return await dispatchCommand(
      IOS_SIMULATOR,
      'press',
      [String(input.point.x), String(input.point.y)],
      undefined,
      input.execution,
    );
  });
  mockFillPoint.mockImplementation(async (input) => {
    return await dispatchCommand(
      IOS_SIMULATOR,
      'fill',
      [String(input.point.x), String(input.point.y), input.text],
      undefined,
      input.execution,
    );
  });
}
