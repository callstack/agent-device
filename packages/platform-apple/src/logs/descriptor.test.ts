import { expect, test } from 'vitest';
import { appleAppLogDescriptorCodec } from './descriptor.ts';

type DescriptorBody = Parameters<typeof appleAppLogDescriptorCodec.decode>[0];

const validBodies: readonly DescriptorBody[] = [
  {
    transport: 'apple-log-stream',
    backend: 'ios-simulator',
    outputPath: '/sessions/one/app.log',
  },
  {
    transport: 'coredevice-console',
    backend: 'ios-device',
    outputPath: '/sessions/one/app.log',
    pidPath: '/sessions/one/app-log.pid',
  },
  {
    transport: 'apple-log-stream',
    backend: 'macos',
    outputPath: '/sessions/one/app.log',
  },
];

test.each(validBodies)('decodes a coherent Apple app-log descriptor', (body) => {
  expect(appleAppLogDescriptorCodec.decode(body)).toEqual({
    status: 'decoded',
    descriptor: body,
  });
});

const invalidBodies: readonly DescriptorBody[] = [
  {
    transport: 'unknown',
    backend: 'ios-simulator',
    outputPath: '/sessions/one/app.log',
  },
  {
    transport: 'apple-log-stream',
    backend: 'unknown',
    outputPath: '/sessions/one/app.log',
  },
  { transport: 'apple-log-stream', backend: 'ios-simulator', outputPath: ' ' },
  {
    transport: 'apple-log-stream',
    backend: 'ios-simulator',
    outputPath: '/sessions/one/app.log',
    pidPath: '',
  },
  {
    transport: 'coredevice-console',
    backend: 'ios-simulator',
    outputPath: '/sessions/one/app.log',
  },
  {
    transport: 'apple-log-stream',
    backend: 'ios-device',
    outputPath: '/sessions/one/app.log',
  },
];

test.each(invalidBodies)('rejects an incoherent Apple app-log descriptor', (body) => {
  expect(appleAppLogDescriptorCodec.decode(body)).toEqual({
    status: 'invalid',
    message: 'Invalid Apple app-log descriptor',
  });
});
