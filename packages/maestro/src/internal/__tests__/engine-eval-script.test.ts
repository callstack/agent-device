import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { evaluateMaestroEvalScript } from '../engine-eval-script.ts';

describe('evaluateMaestroEvalScript', () => {
  test('evaluates a ${...} expression with env and output leaves bound', () => {
    assert.deepEqual(
      evaluateMaestroEvalScript('${output.upper = MY_NAME.toUpperCase()}', { MY_NAME: 'John' }),
      { 'output.upper': 'JOHN' },
    );
  });

  test('flattens arrays into index and length leaves', () => {
    assert.deepEqual(evaluateMaestroEvalScript('${output.list = [1, 2, 3]}', {}), {
      'output.list.0': '1',
      'output.list.1': '2',
      'output.list.2': '3',
      'output.list.length': '3',
    });
  });

  test('seeds output from prior leaves and reads them in a later expression', () => {
    assert.deepEqual(
      evaluateMaestroEvalScript('${output.total = Number(output.sum) + 10}', {
        'output.sum': '3',
      }),
      { 'output.sum': '3', 'output.total': '13' },
    );
  });

  test('resolves a host escape into output when trusted (why remote runs are refused)', () => {
    // `this` in the vm script is the sandbox global, whose prototype chain still reaches host
    // `Object`/`Function`, so it can construct a host-scoped `Function` and read `process`.
    // This pins the leak the gate exists for: local-trusted evalScript reaches the host realm,
    // so the remote HTTP surface must refuse evalScript wholesale before this runs.
    assert.deepEqual(
      evaluateMaestroEvalScript(
        '${output.pwned = this.constructor.constructor("return process.versions.node")()}',
        {},
      ),
      { 'output.pwned': process.versions.node },
    );
  });

  test('drops unsafe output segments and survives self-references', () => {
    assert.deepEqual(
      evaluateMaestroEvalScript('${output.__proto__ = 1; output.a = output; output.b = 2}', {}),
      { 'output.b': '2' },
    );
  });

  test('rejects a failing expression with a wrapped error', () => {
    assert.throws(
      () => evaluateMaestroEvalScript('${exploded.leaf()}', {}),
      /Maestro evalScript failed/,
    );
  });
});
