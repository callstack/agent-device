import fs from 'node:fs';
import path from 'node:path';
import { expect, onTestFinished, test, vi } from 'vitest';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type {
  PerfRuntimeOperations,
  PerfNativeCaptureLiveHandle,
  PerfNativeCaptureSnapshot,
} from '@agent-device/contracts/perf-runtime';
import { deviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import { DAEMON_HTTP_TENANT_HEADER } from '@agent-device/contracts/daemon-http';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import {
  makeAndroidSession,
  makeIosAppSession,
} from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { screenshotRuntimeFixture } from '../../__tests__/support/screenshot-runtime-fixture.ts';
import { screenshotCommandSurface } from '../../__tests__/support/screenshot-command-surface-fake.ts';
import { createRequestHandler } from '../../__tests__/support/test-device-runtime-gateway.ts';
import {
  cleanupDownloadableArtifact,
  leaseVerifier,
  trackDownloadableArtifact,
} from '../../resources/artifact-tracking.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { successfulData, withHttp } from './http-output.fixtures.ts';

const tenantId = 'report-tenant';
const positionals = ['cpu', 'profile', 'report', 'xctrace'];

function reportFixture() {
  const root = mkdtempForTestSync('daemon-perf-report-');
  const sessionStore = makeSessionStore('daemon-perf-report-session-');
  const leaseRegistry = new LeaseRegistry();
  const gateway = screenshotRuntimeFixture().gateway;
  const inspectFacts: typeof gateway.inspectFacts = async (...args) => {
    const facts = await gateway.inspectFacts(...args);
    return {
      ...facts,
      operations: {
        ...facts.operations,
        perfProfileReport: { available: true },
        perfNativeCaptureStart: { available: true },
      },
    };
  };
  const perfProfileReport = vi.fn<PerfRuntimeOperations['perfProfileReport']>(
    async ({ outPath }) => {
      fs.writeFileSync(outPath, 'generated-report');
      return { outPath };
    },
  );
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: screenshotCommandSurface,
    logPath: path.join(root, 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry,
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: {
      ...gateway,
      inspectFacts,
      bind: async (request) => {
        const binding = await gateway.bind(request);
        return {
          ...binding,
          facts: await inspectFacts(request.device),
          operations: {
            ...binding.operations,
            perfProfileReport,
            perfNativeCaptureStart: fixtureCapture(request.device),
          },
        };
      },
    },
    trackDownloadableArtifact,
  });
  const profilePath = path.join(root, 'retained.trace');
  fs.mkdirSync(profilePath);
  const retainProfile = (name: string, leaseId?: string) => {
    sessionStore.publish(
      name,
      makeIosAppSession(name, {
        ...(name.startsWith(tenantId + ':')
          ? { sessionScope: { kind: 'tenant', id: tenantId } }
          : {}),
        lastPerfProfile: {
          profile: {
            kind: 'xctrace',
            mode: 'cpu-profile',
            outPath: profilePath,
            template: 'Time Profiler',
          },
          leaseVerifier: leaseId ? leaseVerifier(leaseId) : null,
        },
      }),
    );
  };
  return {
    handler,
    sessionStore,
    leaseRegistry,
    profilePath,
    retainProfile,
    perfProfileReport,
  };
}

function fixtureCapture(device: DeviceInfo): PerfRuntimeOperations['perfNativeCaptureStart'] {
  return async (input) => {
    let outPath = input.outPath;
    const snapshot = (): PerfNativeCaptureSnapshot =>
      input.kind === 'simpleperf'
        ? simpleperfHandoff(outPath)
        : {
            kind: 'xctrace',
            mode: 'cpu-profile',
            appBundleId: input.appId,
            template: 'Time Profiler',
            outPath,
          };
    const handle: PerfNativeCaptureLiveHandle = {
      inspect: snapshot,
      setOutputPath: (value) => {
        outPath = value;
      },
      finish: async () => {
        if (input.kind === 'simpleperf') {
          fs.writeFileSync(outPath, 'fixture');
        } else {
          fs.mkdirSync(outPath, { recursive: true });
          fs.writeFileSync(path.join(outPath, 'sample'), 'fixture');
        }
        return { status: 'completed', result: snapshot() };
      },
      forceCleanup: async () => ({ status: 'cleaned' }),
      [Symbol.asyncDispose]: async () => {},
    };
    return {
      pendingHandle: new PendingTransferGuard(handle),
      envelope: createDurableResourceEnvelope({
        resourceKind: 'perf-capture',
        sessionId: input.sessionId,
        device: deviceIdentity(device),
        owner: localRuntimeOwner(device.platform),
        fence: input.fence,
        lifecycle: 'open',
        descriptor: { version: 1, body: { kind: 'fixture' } },
      }),
      response: snapshot(),
    };
  };
}

function captureRequest(action: 'start' | 'stop', meta = {}, kind = 'xctrace') {
  return {
    command: 'perf',
    session: 'capture',
    positionals: ['cpu', 'profile', action, kind],
    meta,
  };
}

test.each(['xctrace', 'simpleperf'] as const)(
  'explicit %s reports check the path and identity of an older daemon-owned source',
  async (kind) => {
    const fixture = reportFixture();
    const makeSession = kind === 'xctrace' ? makeIosAppSession : makeAndroidSession;
    fixture.sessionStore.publish(
      'capture',
      makeSession('capture', { appBundleId: 'com.example.app' }),
    );
    const reporter = fixture.sessionStore.publish('reporter', makeSession('reporter'));
    if (kind === 'simpleperf') {
      fixture.sessionStore.update(reporter, {
        lastPerfProfile: {
          profile: simpleperfHandoff(path.join(fixture.profilePath, 'local.perf.data')),
          leaseVerifier: null,
        },
      });
    }
    const scope = { tenantId, runId: 'producer', leaseBackend: 'android-instance' } as const;
    const meta = { ...scope, leaseId: fixture.leaseRegistry.allocateLease(scope).leaseId };
    await withHttp(fixture.handler, async (post) => {
      const complete = async () => {
        successfulData(await post(captureRequest('start', meta, kind)));
        const result = successfulData(await post(captureRequest('stop', meta, kind)));
        const artifactId = result.artifacts?.[0]?.artifactId;
        expect(artifactId).toBeTypeOf('string');
        cleanupDownloadableArtifact(artifactId!);
        return result.outPath as string;
      };
      const older = await complete();
      expect(await complete()).not.toBe(older);
      const moved = older + '-moved';
      fs.renameSync(older, moved);
      if (kind === 'xctrace') fs.mkdirSync(older);
      else fs.writeFileSync(older, 'replacement');
      const report = (source: string, owner = {}) =>
        post(
          {
            command: 'perf',
            session: 'reporter',
            positionals: ['cpu', 'profile', 'report', kind, '', '', source],
            meta: owner,
          },
          false,
        );

      const refusals = [await report(older), await report(moved)];
      expect(refusals.map((body) => body.error?.data?.details?.reason)).toEqual([
        'LEASE_OUTPUT_MISMATCH',
        'LEASE_OUTPUT_MISMATCH',
      ]);
      expect(fixture.perfProfileReport).not.toHaveBeenCalled();
      successfulData(await report(moved, meta));
    });
  },
);

test('public-network perf report uses the session capture despite an explicit host path', async () => {
  const fixture = reportFixture();
  fixture.retainProfile('capture');
  const explicitPath = fixture.profilePath + '-external';
  fs.mkdirSync(explicitPath);
  await withHttp(fixture.handler, async (post) => {
    successfulData(
      await post({
        command: 'perf',
        session: 'capture',
        positionals: [...positionals, '', '', explicitPath],
      }),
    );
  });
  expect(fixture.perfProfileReport).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      tracePath: fs.realpathSync(fixture.profilePath),
    }),
  );
});

test('a tenant-isolated local xctrace report keeps the same-lease handoff for an independent source', async () => {
  const fixture = reportFixture();
  const scope = { tenantId, runId: 'perf', leaseBackend: 'ios-simulator' } as const;
  const lease = fixture.leaseRegistry.allocateLease(scope);
  const name = `${tenantId}:capture`;
  fixture.retainProfile(name, lease.leaseId);
  const explicitPath = fixture.profilePath + '-external';
  fs.mkdirSync(explicitPath);
  await withHttp(fixture.handler, async (post) => {
    successfulData(
      await post(
        {
          command: 'perf',
          session: 'capture',
          positionals: [...positionals, '', '', explicitPath],
          meta: { ...scope, leaseId: lease.leaseId, sessionIsolation: 'tenant' },
        },
        false,
      ),
    );
  });
  expect(fixture.perfProfileReport).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      tracePath: fs.realpathSync(explicitPath),
      profile: expect.objectContaining({ outPath: fixture.profilePath }),
      template: 'Time Profiler',
    }),
  );
});

test('an independent local xctrace source keeps the unleased session handoff and template', async () => {
  const fixture = reportFixture();
  fixture.retainProfile('capture');
  const explicitPath = fixture.profilePath + '-external';
  fs.mkdirSync(explicitPath);
  await withHttp(fixture.handler, async (post) => {
    successfulData(
      await post(
        {
          command: 'perf',
          session: 'capture',
          positionals: [...positionals, '', '', explicitPath],
        },
        false,
      ),
    );
  });
  expect(fixture.perfProfileReport).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      tracePath: fs.realpathSync(explicitPath),
      profile: expect.objectContaining({ outPath: fixture.profilePath }),
      template: 'Time Profiler',
    }),
  );
});

function simpleperfHandoff(outPath: string) {
  return {
    kind: 'simpleperf',
    mode: 'cpu-profile',
    type: 'cpu-profile',
    outPath,
    packageName: 'com.example.app',
    appPid: '1712',
    profilerPid: '6804',
    remotePath: '/data/local/tmp/cpu.perf.data',
  } as const;
}

test('a local Simpleperf report uses the stopped handoff when its export has moved', async () => {
  const fixture = reportFixture();
  const formerPath = path.join(fixture.profilePath, 'cpu.perf.data');
  fs.writeFileSync(formerPath, 'fixture');
  fs.renameSync(formerPath, path.join(fixture.profilePath, 'moved.perf.data'));
  const profile = simpleperfHandoff(formerPath);
  fixture.sessionStore.publish(
    'capture',
    makeAndroidSession('capture', {
      appBundleId: profile.packageName,
      lastPerfProfile: { profile, leaseVerifier: null },
    }),
  );
  await withHttp(fixture.handler, async (post) => {
    successfulData(
      await post(
        {
          command: 'perf',
          session: 'capture',
          positionals: ['cpu', 'profile', 'report', 'simpleperf', '', '', 'cpu.perf.data'],
          meta: { cwd: fixture.profilePath },
        },
        false,
      ),
    );
  });
  expect(fixture.perfProfileReport).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      tracePath: formerPath,
      profile,
    }),
  );
});

test.each(['HTTP request', 'direct daemon request'])(
  'an unleased %s perf report is downloadable by the requester tenant',
  async (origin) => {
    const fixture = reportFixture();
    fixture.retainProfile('capture');
    await withHttp(fixture.handler, async (post, base) => {
      const request = { command: 'perf', session: 'capture', positionals };
      const report = successfulData(
        origin === 'HTTP request'
          ? await post({ ...request, meta: { tenantId } })
          : { result: await reportWithoutHttpTenantStamp() },
      );
      async function reportWithoutHttpTenantStamp() {
        const response = await fixture.handler({
          ...request,
          token: 'test-token',
          flags: { tenant: tenantId },
          internal: { publicNetworkOnly: true },
        });
        if (!response.ok) throw new Error(JSON.stringify(response.error));
        return response;
      }
      const id = report.artifacts?.[0]?.artifactId;
      expect(id).toBeTypeOf('string');
      const fetchReport = (tenant?: string) =>
        fetch(`${base}/artifacts/${id}`, {
          headers: {
            authorization: 'Bearer test-token',
            ...(tenant ? { [DAEMON_HTTP_TENANT_HEADER]: tenant } : {}),
          },
        });
      expect((await fetchReport('other-tenant')).status).toBe(401);
      expect((await fetchReport()).status).toBe(401);
      const download = await fetchReport(tenantId);
      expect(download.status).toBe(200);
      expect(await download.text()).toBe('generated-report');
    });
  },
);

test.each(['retained in another session', 'registered as an artifact', 'also retained locally'])(
  'trusted local perf report refuses a lease-owned source %s',
  async (owner) => {
    const fixture = reportFixture();
    const lease = fixture.leaseRegistry.allocateLease({
      tenantId,
      runId: 'owner',
      leaseBackend: 'android-instance',
    });
    if (owner === 'also retained locally') fixture.retainProfile('capture');
    else fixture.sessionStore.publish('capture', makeIosAppSession('capture'));
    if (owner === 'registered as an artifact') {
      const id = trackDownloadableArtifact({
        artifactPath: fixture.profilePath,
        artifactType: 'performance',
        leaseVerifier: leaseVerifier(lease.leaseId),
      });
      onTestFinished(() => cleanupDownloadableArtifact(id));
    } else {
      fixture.retainProfile('leased', lease.leaseId);
    }
    const alias = fixture.profilePath + '-alias';
    fs.symlinkSync(fixture.profilePath, alias, 'dir');
    await withHttp(fixture.handler, async (post) => {
      const body = await post(
        {
          command: 'perf',
          session: 'capture',
          positionals:
            owner === 'also retained locally' ? positionals : [...positionals, '', '', alias],
        },
        false,
      );
      expect(body.error?.data?.details).toMatchObject({ reason: 'LEASE_OUTPUT_MISMATCH' });
      expect(fixture.perfProfileReport).not.toHaveBeenCalled();
    });
  },
);

test('trusted local perf report returns INVALID_ARGS for an unreadable explicit source', async () => {
  const fixture = reportFixture();
  fixture.retainProfile('capture');
  const file = path.join(fixture.profilePath, 'file');
  fs.writeFileSync(file, '');
  await withHttp(fixture.handler, async (post) => {
    const body = await post(
      {
        command: 'perf',
        session: 'capture',
        positionals: [...positionals, '', '', path.join(file, 'unreadable.trace')],
      },
      false,
    );
    expect(body.error?.data).toMatchObject({
      code: 'INVALID_ARGS',
      details: { field: 'tracePath' },
    });
    expect(fixture.perfProfileReport).not.toHaveBeenCalled();
  });
});
