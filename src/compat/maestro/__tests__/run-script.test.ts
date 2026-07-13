import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { AppError } from '../../../kernel/errors.ts';
import { executeRunScriptFile } from '../run-script-execution.ts';

test('executeRunScriptFile exposes env and serializes output values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-maestro-run-script-'));
  const scriptPath = path.join(root, 'setup.js');
  fs.writeFileSync(
    scriptPath,
    `
output.text = SERVER_PATH
output.number = 42
output.boolean = false
output.object = { ready: true }
`,
  );

  try {
    expect(executeRunScriptFile({ scriptPath, env: { SERVER_PATH: 'local' } })).toEqual({
      'output.text': 'local',
      'output.number': '42',
      'output.boolean': 'false',
      'output.object': '{"ready":true}',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('executeRunScriptFile rejects output keys that cannot become replay variables', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-maestro-run-script-'));
  const scriptPath = path.join(root, 'setup.js');
  fs.writeFileSync(scriptPath, `output['nested.value'] = 'ambiguous'`);

  try {
    expect(() => executeRunScriptFile({ scriptPath, env: {} })).toThrowError(AppError);
    try {
      executeRunScriptFile({ scriptPath, env: {} });
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('INVALID_ARGS');
      expect((error as AppError).message).toContain('output key cannot contain');
      expect((error as AppError).details).toEqual({ scriptPath, key: 'nested.value' });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('executeRunScriptFile keeps recovery guidance separate from its bounded error message', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-maestro-run-script-'));
  const scriptPath = path.join(root, 'setup.js');
  fs.writeFileSync(scriptPath, `output.result = json('').value`);

  try {
    executeRunScriptFile({ scriptPath, env: {} });
    throw new Error('expected runScript to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).message).toBe(
      'Maestro runScript failed: Maestro runScript json() received an empty body.',
    );
    expect((error as AppError).details).toEqual({
      hint: 'Check the preceding HTTP response status and setup server output.',
      scriptPath,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('executeRunScriptFile strips prototype keys from json output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-maestro-run-script-'));
  const scriptPath = path.join(root, 'setup.js');
  fs.writeFileSync(
    scriptPath,
    `
const parsed = json('{"safe":1,"__proto__":{"polluted":true},"nested":{"prototype":{"polluted":true},"ok":2}}')
output.result = [
  Object.prototype.hasOwnProperty.call(parsed, '__proto__'),
  Object.prototype.hasOwnProperty.call(parsed.nested, 'prototype'),
  parsed.nested.ok
].join(':')
`,
  );

  try {
    expect(executeRunScriptFile({ scriptPath, env: {} })).toEqual({
      'output.result': 'false:false:2',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
