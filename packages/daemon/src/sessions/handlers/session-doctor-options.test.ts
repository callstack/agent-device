import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import { readDoctorOptions, remoteConnectionChecks } from './session-doctor-options.ts';

function doctorRequest(flags: Record<string, unknown>): DaemonRequest {
  return {
    token: 't',
    session: 'default',
    command: 'doctor',
    positionals: [],
    flags,
  } as DaemonRequest;
}

test('doctor only schedules Metro diagnostics for local requests', () => {
  const request = {
    ...doctorRequest({}),
    runtime: { metroHost: 'metro.example.invalid', metroPort: 8081 },
  };

  assert.equal(readDoctorOptions(request, undefined).shouldProbeMetro, true);
  assert.equal(
    readDoctorOptions({ ...request, internal: { publicNetworkOnly: true } }, undefined)
      .shouldProbeMetro,
    false,
  );
});

test('an enabled opt-in provider flag counts as configured provider scope', () => {
  const [check] = remoteConnectionChecks(doctorRequest({ providerNetworkLogs: true }), {
    required: true,
  });
  assert.equal(check?.status, 'pass');
  assert.deepEqual(check?.evidence, { providerNetworkLogs: '<configured>' });
});

test('a disabled opt-in provider flag is not provider scope', () => {
  const [check] = remoteConnectionChecks(doctorRequest({ providerNetworkLogs: false }), {
    required: true,
  });
  assert.equal(check?.status, 'fail');
});
