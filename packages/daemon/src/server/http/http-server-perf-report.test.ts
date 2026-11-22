import fs from 'node:fs';
import path from 'node:path';
import { expect, onTestFinished, test, vi } from 'vitest';
import { DAEMON_HTTP_TENANT_HEADER } from '@agent-device/contracts/daemon-http';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { makeIosAppSession } from '../../__tests__/support/session-factories.ts';
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
  const inspectFacts = vi.fn<typeof gateway.inspectFacts>(async (...args) => {
    const facts = await gateway.inspectFacts(...args);
    return {
      ...facts,
      operations: { ...facts.operations, perfProfileReport: { available: true } },
    };
  });
  const perfProfileReport = vi.fn(async ({ outPath }: { outPath: string }) => {
    fs.writeFileSync(outPath, 'generated-report');
    return { outPath };
  });
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
          operations: { ...binding.operations, perfProfileReport },
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
    inspectFacts,
  };
}

test.each(['public without a lease', 'tenant-scoped under another lease'])(
  'perf report refuses an explicit host trace path from a %s request before runtime admission',
  async (origin) => {
    const fixture = reportFixture();
    const isPublic = origin === 'public without a lease';
    const scope = { tenantId, runId: 'perf', leaseBackend: 'android-instance' } as const;
    const producer = fixture.leaseRegistry.allocateLease({ ...scope, runId: 'producer' });
    fixture.retainProfile(isPublic ? 'capture' : `${tenantId}:capture`, producer.leaseId);
    const explicitPath = fixture.profilePath + '-external';
    fs.mkdirSync(explicitPath);
    const meta = isPublic
      ? {}
      : {
          ...scope,
          leaseId: fixture.leaseRegistry.allocateLease(scope).leaseId,
          sessionIsolation: 'tenant',
        };
    await withHttp(fixture.handler, async (post) => {
      const body = await post(
        {
          command: 'perf',
          session: 'capture',
          positionals: [...positionals, '', '', explicitPath],
          meta,
        },
        isPublic,
      );
      expect(body.error?.data).toMatchObject({
        code: 'INVALID_ARGS',
        details: { reason: 'REMOTE_HOST_INPUT_DENIED', field: 'tracePath' },
      });
      expect(fixture.inspectFacts).not.toHaveBeenCalled();
      expect(fixture.perfProfileReport).not.toHaveBeenCalled();
    });
  },
);

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
