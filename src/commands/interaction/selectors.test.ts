import { expect, test } from 'vitest';
import { UNSUPPORTED_FIND_ACTION_HINT } from '@agent-device/selectors';
import { AppError } from '@agent-device/kernel/errors';
import type { CliFlags } from '@agent-device/contracts/command';
import { selectorCliReaders } from './selectors.ts';

const BASE_FLAGS: CliFlags = { json: false, help: false, version: false };

// #1597: this CLI reader has its own "Unsupported find action" throw site,
// separate from packages/selectors/src/internal/find.ts's raw-positional
// parser (the daemon-side path). Both must carry the same recovery hint —
// this pins the reader actually reachable from `agent-device find <text>
// press` on the terminal.
test('find CLI reader attaches the supported-actions hint on an unsupported action', () => {
  try {
    selectorCliReaders.find(['text', 'Follow', 'press'], BASE_FLAGS);
    expect.unreachable('find CLI reader should have thrown for an unsupported action');
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe('INVALID_ARGS');
    expect(appError.message).toBe('Unsupported find action: press');
    expect(appError.details?.hint).toBe(UNSUPPORTED_FIND_ACTION_HINT);
  }
});
