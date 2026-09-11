import assert from 'node:assert/strict';

import { assertWaitText, snapshotNodes } from './live-assertions.ts';
import { acceptDeepLinkConfirmationIfPresent } from './live-automation-scenario.ts';
import { type LiveContext, runStep, verifyBehavior } from './live-harness.ts';

const WEBVIEW_LAB_DEEP_LINK = 'agent-device-test-app:///webview';
// The first WebContent process of the run spawns here; a cold CI simulator needs more than the
// shared 10 s wait budget before the page's tree exists.
const PAGE_LOAD_WAIT_MS = '20000';
// Page-only landmarks: the fixture's <title> equals its <h1>, and the web view node carries the
// document title as its label before the body's tree exists, so the heading proves nothing.
const PAGE_LINK = 'Jump to form';
const PAGE_FIELD_LABEL = 'Email address';
// The first capture of the generation refuses the bridge tree (`remote-content-boundary`) and opens
// the circuit; every later capture reports `circuit-disabled`. Which one this snapshot sees depends
// on how many observations the readiness waits above it consumed, so both prove the fallback.
const XCTEST_FALLBACK_WARNING =
  /^Simulator AX snapshot unavailable \((remote-content-boundary|circuit-disabled)\); used XCTest for this app generation\.$/;

/**
 * #2484: the host AX bridge reads one process and a WebKit page lives in another, so the bridge
 * tree of this screen ends at an `AXRemoteElement` leaf under the web view. The route must refuse
 * that tree and serve XCTest, which resolves remote elements, or the page's link, text, and form
 * vanish from every snapshot and no ref can reach them.
 */
export async function assertWebViewRemoteContent(context: LiveContext): Promise<void> {
  await runStep(context, 'open WebView accessibility lab', [
    'open',
    context.appId,
    '--relaunch',
    '--launch-url',
    WEBVIEW_LAB_DEEP_LINK,
  ]);
  await acceptDeepLinkConfirmationIfPresent(context);
  // `wait` observes through the same route as `snapshot`: page content is reachable only once the
  // route has stopped publishing the bridge's page-less tree.
  await runStep(context, 'wait for the WebView page to expose its link', [
    'wait',
    'text',
    PAGE_LINK,
    PAGE_LOAD_WAIT_MS,
  ]);

  const snapshot = await runStep(context, 'capture WebView lab snapshot', ['snapshot']);
  const nodes = snapshotNodes(snapshot);
  assert.ok(
    nodes.some((node) => node.type === 'Link' && node.label === PAGE_LINK),
    `WebView page link must be present with its semantic role: ${JSON.stringify(snapshot)}`,
  );
  // First-viewport content only: the fixture's form controls sit below the fold.
  assert.ok(
    nodes.some((node) => node.label === PAGE_FIELD_LABEL),
    `WebView page field label "${PAGE_FIELD_LABEL}" is missing: ${JSON.stringify(snapshot)}`,
  );
  const warnings = snapshot.json?.data?.warnings;
  assert.ok(
    Array.isArray(warnings) &&
      warnings.some(
        (warning) => typeof warning === 'string' && XCTEST_FALLBACK_WARNING.test(warning),
      ),
    `WebView snapshot must disclose the XCTest fallback for remote content: ${JSON.stringify(snapshot)}`,
  );

  await runStep(context, 'restore fixture home after WebView lab', [
    'open',
    context.appId,
    '--relaunch',
  ]);
  await assertWaitText(context, 'Agent Device Tester');
  verifyBehavior(
    context,
    'webview-remote-content',
    'a WKWebView page keeps its link and field label in snapshots because the route refuses the bridge tree that ends at the remote element and serves XCTest',
  );
}
