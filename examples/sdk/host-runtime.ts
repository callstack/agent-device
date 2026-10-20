/**
 * Host-owned runtime: start the daemon inside this process, drive it through the
 * client it hands back, and end it with one `close()`.
 *
 * Demonstrates: `startAgentDevice` from `agent-device`.
 *
 * Prerequisites: none — the runtime is this process's own, so no daemon needs to
 * be running and no device is touched here. `sessions.list()` asks that runtime
 * for its sessions, which is empty until something opens one.
 *
 * Run: node --experimental-strip-types examples/sdk/host-runtime.ts
 */
import { startAgentDevice } from 'agent-device';

const host = await startAgentDevice({
  // Required: a host claims a directory of its own rather than attaching to
  // whatever an ambient AGENT_DEVICE_STATE_DIR happens to name.
  stateDir: './.host-runtime-state',
});

try {
  console.log(`state dir: ${host.clientConfig.stateDir}`);
  // The pin names exactly this instance — token, pid and process start time — so a
  // second process handed this config reaches this runtime and refuses anything
  // that later replaced it. It carries a bearer token: keep it inside this host.
  console.log(`pinned pid: ${host.clientConfig.daemonBinding?.pid}`);
  const sessions = await host.client.sessions.list();
  console.log(`sessions: ${sessions.length}`);
} finally {
  // One close, safe to repeat or overlap, and it never exits this process. What the
  // runtime could not finish comes back in the report instead of being swallowed.
  const report = await host.close();
  const unfinished = [
    ...report.providerReleases.pending,
    ...report.providerReleases.unknown,
    ...report.runners.handedOff,
    ...report.plugins.pending,
  ];
  if (report.requests.abandoned > 0 || report.sessions.failed > 0 || unfinished.length > 0) {
    console.log(`closed with unfinished work: ${JSON.stringify(report)}`);
  }
}
