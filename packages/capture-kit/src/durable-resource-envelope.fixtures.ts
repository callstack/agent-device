import { createDurableResourceEnvelope } from './durable-resource-envelope.ts';

export const APP_LOG_ENVELOPE_FIXTURE = createDurableResourceEnvelope({
  resourceKind: 'app-log',
  sessionId: 'session-1',
  device: {
    id: 'emulator-5554',
    family: 'android',
    kind: 'emulator',
    target: 'mobile',
  },
  owner: { kind: 'local-family', family: 'android' },
  fence: { token: 'fence-2', generation: 2 },
  lifecycle: 'open',
  descriptor: {
    version: 2,
    body: { pid: 42, outputPath: '/tmp/app.log' },
  },
  metadata: { startedAt: 1_700_000_000_000 },
});
