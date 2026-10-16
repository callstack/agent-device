import { readFileSync } from 'node:fs';
import type { DaemonResponseData, ResponseLevel } from '@agent-device/kernel/contracts';
import { RESPONSE_VIEWS } from '../../src/server/response-views.ts';

function responseView(
  command: string,
  data: DaemonResponseData,
  level: ResponseLevel,
): DaemonResponseData {
  const view = RESPONSE_VIEWS[command];
  if (!view) throw new Error(`No daemon response view is registered for ${command}`);
  return view(data, level);
}

function renderOutputEconomyResponseViews(fixtures: {
  snapshot: DaemonResponseData;
  settle: DaemonResponseData;
  settleTail: DaemonResponseData;
  selector: DaemonResponseData;
  screenshot: DaemonResponseData;
  network: DaemonResponseData;
}) {
  return {
    snapshotDigest: responseView('snapshot', fixtures.snapshot, 'digest'),
    settleDigest: responseView('click', fixtures.settle, 'digest'),
    settleTailDigest: responseView('click', fixtures.settleTail, 'digest'),
    selectorDigest: responseView('get', fixtures.selector, 'digest'),
    screenshotDefault: responseView('screenshot', fixtures.screenshot, 'default'),
    screenshotDigest: responseView('screenshot', fixtures.screenshot, 'digest'),
    networkDigest: responseView('network', fixtures.network, 'digest'),
  };
}

const fixtures = JSON.parse(readFileSync(0, 'utf8')) as Parameters<
  typeof renderOutputEconomyResponseViews
>[0];
process.stdout.write(JSON.stringify(renderOutputEconomyResponseViews(fixtures)));
