import { AppError } from '@agent-device/kernel/errors';
import { createAwsDeviceFarmCommandRunner } from './aws-device-farm.ts';
import type { RunHostCommand } from './dependencies.ts';
import type {
  CloudWebDriverConnectionVerification,
  CloudWebDriverConnectionVerificationOptions,
} from './connection-verification.ts';
import type { ProviderConnectionResource } from '@agent-device/contracts/remote';

type AwsOptions = Extract<
  CloudWebDriverConnectionVerificationOptions,
  { provider: 'aws-device-farm' }
>;

export function readAwsDeviceFarmRegionFromArn(arn: string): string | undefined {
  return /^arn:[^:]+:devicefarm:([^:]+):/.exec(arn)?.[1];
}

export async function verifyAwsDeviceFarmConnection(
  options: AwsOptions,
  runHostCommand: RunHostCommand,
): Promise<CloudWebDriverConnectionVerification> {
  const runAwsJson = createAwsDeviceFarmCommandRunner({
    runHostCommand,
    region: options.region,
  });
  const [projectResponse, deviceResponse, uploadResponse] = await Promise.all([
    runAwsJson('get-project', ['--arn', options.projectArn]),
    runAwsJson('get-device', ['--arn', options.deviceArn]),
    options.appArn ? runAwsJson('get-upload', ['--arn', options.appArn]) : undefined,
  ]);
  const project = readAwsResource(projectResponse, 'project');
  const device = readAwsResource(deviceResponse, 'device');
  const devicePlatform = readAwsPlatform(device.platform);
  if (devicePlatform !== options.platform) {
    throw new AppError(
      'INVALID_ARGS',
      `AWS Device Farm device "${readString(device.name) ?? options.deviceArn}" is ${devicePlatform}, not ${options.platform}.`,
    );
  }

  const app = options.appArn
    ? verifyAwsUpload(readAwsResource(uploadResponse, 'upload'), options)
    : {
        status: 'missing' as const,
        message:
          'No app upload is attached; AWS Device Farm does not support install after allocation. Reconnect with --aws-app-arn <arn>.',
      };
  return {
    provider: 'aws-device-farm',
    service: 'AWS Device Farm',
    verificationMessage: options.appArn
      ? 'Credentials, project, device, and app upload verified.'
      : 'Credentials, project, and device verified.',
    project: { name: readString(project.name), reference: options.projectArn },
    device: {
      status: 'verified',
      name: readString(device.name) ?? options.deviceArn,
      reference: options.deviceArn,
      platform: devicePlatform,
      osVersion: readString(device.os),
      availability: readString(device.availability),
    },
    app,
  };
}

function verifyAwsUpload(
  upload: Record<string, unknown>,
  options: AwsOptions,
): ProviderConnectionResource {
  const status = readString(upload.status);
  if (status !== 'SUCCEEDED') {
    throw new AppError(
      'COMMAND_FAILED',
      `AWS Device Farm app upload is not ready (${status ?? 'unknown status'}).`,
      {
        status,
        hint: 'Wait for the upload to succeed or reconnect with a different --aws-app-arn.',
      },
    );
  }
  const expectedType = options.platform === 'android' ? 'ANDROID_APP' : 'IOS_APP';
  const type = readString(upload.type);
  if (type !== expectedType) {
    throw new AppError(
      'INVALID_ARGS',
      `AWS Device Farm app upload type is ${type ?? 'unknown'}, expected ${expectedType}.`,
    );
  }
  return {
    status: 'verified',
    name: readString(upload.name),
    reference: options.appArn,
  };
}

function readAwsResource(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new AppError('COMMAND_FAILED', `AWS Device Farm ${key} response was not an object.`);
  }
  const resource = (value as Record<string, unknown>)[key];
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
    throw new AppError('COMMAND_FAILED', `AWS Device Farm response missed ${key}.`);
  }
  return resource as Record<string, unknown>;
}

function readAwsPlatform(value: unknown): 'android' | 'ios' {
  if (value === 'ANDROID') return 'android';
  if (value === 'IOS') return 'ios';
  throw new AppError(
    'UNSUPPORTED_PLATFORM',
    `AWS Device Farm device platform is ${String(value)}.`,
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
