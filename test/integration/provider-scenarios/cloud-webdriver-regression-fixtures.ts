import assert from 'node:assert/strict';
import type {
  DeviceLease,
  LeaseLifecycleContext,
  ProviderDeviceRuntime,
} from '@agent-device/contracts/device';
import type { RunHostCommand } from '@agent-device/provider-webdriver';
import {
  CloudWebDriverTestServer,
  type CloudWebDriverHttpCall,
  cloudWebDriverTestJson,
  startCloudWebDriverTestServer,
  type StartedCloudWebDriverTestServer,
} from './cloud-webdriver-test-server.ts';

export const PROVIDER_REGRESSION_CLIENT_VERSION = '0.20.3-regression-test';

export class ProviderRegressionServer extends CloudWebDriverTestServer {
  sessionFailuresRemaining = 0;

  static async start(): Promise<StartedCloudWebDriverTestServer<ProviderRegressionServer>> {
    return await startCloudWebDriverTestServer(new ProviderRegressionServer());
  }

  protected respond(call: CloudWebDriverHttpCall) {
    if (`${call.method} ${call.path}` === 'POST /wd/hub/session') {
      if (this.sessionFailuresRemaining > 0) {
        this.sessionFailuresRemaining -= 1;
        return cloudWebDriverTestJson({ value: { message: 'transient provider failure' } }, 503);
      }
      return cloudWebDriverTestJson({
        value: { sessionId: 'wd-regression', capabilities: { platformName: 'Android' } },
      });
    }
    return cloudWebDriverTestJson({ value: null });
  }
}

export class AwsRemoteAccessHost {
  readonly sessionArn = 'arn:aws:devicefarm:session/regression';
  readonly calls: string[][] = [];
  private readonly appiumEndpoint: string;
  private readonly device: { name: string; platform: string; os: string };

  constructor(options: {
    appiumEndpoint: string;
    device?: { name: string; platform: string; os: string };
  }) {
    this.appiumEndpoint = options.appiumEndpoint;
    this.device = options.device ?? {
      name: 'Google Pixel 8',
      platform: 'ANDROID',
      os: '14',
    };
  }

  readonly run: RunHostCommand = async (command, args) => {
    this.calls.push([command, ...args]);
    switch (args[1]) {
      case 'create-remote-access-session':
        return this.result({
          remoteAccessSession: { arn: this.sessionArn, status: 'PENDING' },
        });
      case 'get-remote-access-session':
        return this.result({
          remoteAccessSession: {
            arn: this.sessionArn,
            status: 'RUNNING',
            remoteDebugUrl: 'wss://live-control.example/socket',
            endpoints: {
              video: 'wss://video.example/socket',
              appium: this.appiumEndpoint,
            },
            device: this.device,
          },
        });
      case 'stop-remote-access-session':
        return this.result({
          remoteAccessSession: { arn: this.sessionArn, status: 'STOPPING' },
        });
      case 'list-artifacts':
        return this.result({ artifacts: [] });
      default:
        throw new Error(`unexpected AWS command: ${command} ${args.join(' ')}`);
    }
  };

  private result(value: unknown): { stdout: string } {
    return { stdout: JSON.stringify(value) };
  }
}

export function providerRuntimeFor(
  runtimes: readonly ProviderDeviceRuntime[],
  provider: string,
): ProviderDeviceRuntime {
  const runtime = runtimes.find((candidate) => candidate.provider === provider);
  assert.ok(runtime, `missing ${provider} runtime`);
  return runtime;
}

export function providerRegressionLease(provider: string): DeviceLease {
  return {
    leaseId: 'regression-lease',
    tenantId: 'team-a',
    runId: 'run-a',
    clientId: 'client-a',
    leaseProvider: provider,
    backend: 'android-instance',
    deviceKey: 'provider-device-regression',
    createdAt: 1,
    expiresAt: 2,
    heartbeatAt: 1,
  };
}

export function browserStackRegressionContext(): LeaseLifecycleContext {
  return {
    flags: {
      platform: 'android',
      device: 'Google Pixel 8',
      providerApp: 'bs://preuploaded',
      providerOsVersion: '14.0',
    },
  };
}

export function awsRegressionContext(
  platform: 'android' | 'ios' = 'android',
): LeaseLifecycleContext {
  return {
    flags: {
      platform,
      awsProjectArn: 'arn:aws:devicefarm:us-west-2:123:project/project-id',
      awsDeviceArn: 'arn:aws:devicefarm:us-west-2::device/device-id',
    },
  };
}
