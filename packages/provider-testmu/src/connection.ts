import fs from 'node:fs';
import path from 'node:path';
import type { ProviderPluginHost } from 'agent-device/plugins';
import type { CliFlags } from '@agent-device/contracts/command';
import {
  rejectRefusedProviderProfileFields,
  type ProviderProfileFieldDeclaration,
} from '@agent-device/contracts/provider-profile-fields';
import { canonicalTestMuAppReference, isTestMuAppReference } from './providers.ts';
import { verifyTestMuConnection } from './testmu-connection-verification.ts';
import { readTestMuDeviceFeatureFields, readTestMuDeviceType } from './testmu-device-features.ts';

export function createTestMuConnection(
  host: ProviderPluginHost,
  fields: ProviderProfileFieldDeclaration,
) {
  const required = (value: string | undefined, name: string) => {
    if (value?.trim()) return value;
    throw host.createError('INVALID_ARGS', `connect testmu requires ${name}.`);
  };
  return {
    resolve: ({ flags, cwd }: { flags: CliFlags; cwd: string }) => {
      rejectRefusedProviderProfileFields(flags, fields);
      required(host.env.LT_USERNAME, 'LT_USERNAME');
      required(host.env.LT_ACCESS_KEY, 'LT_ACCESS_KEY');
      if (flags.platform !== 'android' && flags.platform !== 'ios')
        throw host.createError('INVALID_ARGS', 'connect testmu requires --platform ios|android.');
      let app = canonicalTestMuAppReference(
        required(flags.providerApp, '--provider-app <lt://app-id, URL, or local path>'),
      );
      if (app.startsWith('lt://')) {
        if (!isTestMuAppReference(app))
          throw host.createError(
            'INVALID_ARGS',
            'connect testmu requires a valid lt:// app reference.',
          );
      } else if (!/^https?:\/\//i.test(app)) {
        app = path.resolve(cwd, app);
        if (!fs.statSync(app, { throwIfNoEntry: false })?.isFile())
          throw host.createError('INVALID_ARGS', `TestMu AI app file not found: ${app}`);
      }
      return {
        profile: {
          leaseProvider: 'testmu',
          leaseBackend:
            flags.leaseBackend ?? (flags.platform === 'ios' ? 'ios-instance' : 'android-instance'),
          platform: flags.platform,
          device: required(flags.device, '--device <name>'),
          providerOsVersion: required(flags.providerOsVersion, '--provider-os-version <version>'),
          providerApp: app,
          providerDeviceType: readTestMuDeviceType(flags),
          providerProject: flags.providerProject,
          providerBuild: flags.providerBuild,
          providerSessionName: flags.providerSessionName,
          ...readTestMuDeviceFeatureFields(flags),
        } as const,
        extraFlags: { providerApp: app },
      };
    },
    verify: async ({ flags }: { flags: CliFlags }) => {
      if (flags.platform !== 'android' && flags.platform !== 'ios')
        throw host.createError('INVALID_ARGS', 'TestMu profile missed platform.');
      return await verifyTestMuConnection(
        {
          provider: 'testmu',
          username: required(host.env.LT_USERNAME, 'LT_USERNAME'),
          accessKey: required(host.env.LT_ACCESS_KEY, 'LT_ACCESS_KEY'),
          platform: flags.platform,
          deviceName: required(flags.device, '--device'),
          osVersion: required(flags.providerOsVersion, '--provider-os-version'),
          app: canonicalTestMuAppReference(required(flags.providerApp, '--provider-app')),
          deviceType: readTestMuDeviceType(flags),
          apiEndpoint: host.env.TESTMU_API_ENDPOINT,
        },
        host.clientVersion,
      );
    },
  };
}
