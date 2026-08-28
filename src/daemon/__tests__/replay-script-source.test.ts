import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { readReplayScriptSourceFile } from '../replay-script-source.ts';

test('reading a file the bundle does not carry names the file and the entry', () => {
  const bundle = { entry: '/flows/login.yaml', files: { '/flows/login.yaml': '---\n- back\n' } };

  try {
    readReplayScriptSourceFile(bundle, '/flows/missing.yaml');
    expect.unreachable('expected a missing bundled source to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INVALID_ARGS');
    expect((error as AppError).message).toContain('/flows/missing.yaml');
    expect((error as AppError).details).toMatchObject({ entry: '/flows/login.yaml' });
  }
});
