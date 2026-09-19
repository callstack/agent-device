import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SnapshotSourceError } from './errors.ts';
import { decodeSnapshotBridgeTree } from './tree.ts';
import type { SnapshotSourceLimits } from './types.ts';

const limits: SnapshotSourceLimits = {
  maxRequestBytes: 1024,
  maxResponseBytes: 4096,
  maxNodes: 20,
  maxTraversalDepth: 10,
  maxDurationMs: 1000,
};

const application = 'XC_kAXXCAttributeElementType';
const baseType = 'XC_kAXXCAttributeElementBaseType';
const frame = 'XC_kAXXCAttributeFrame';
const children = 'XC_kAXXCAttributeChildren';
const label = 'XC_kAXXCAttributeLabel';
const automationType = 'XC_kAXXCAttributeAutomationType';
const traits = 'XC_kAXXCAttributeTraits';

test('the bridge tree becomes one depth-first raw snapshot with viewport evidence', () => {
  const result = decodeSnapshotBridgeTree(
    {
      [application]: 'Application',
      [frame]: { X: 0, Y: 0, Width: 390, Height: 844 },
      [children]: [
        {
          [application]: 'Window',
          [baseType]: 'UIWindow',
          [frame]: { X: 0, Y: 0, Width: 390, Height: 844 },
          [children]: [
            {
              [automationType]: 9,
              [label]: 'Continue',
              [frame]: { X: 20, Y: 700, Width: 120, Height: 48 },
              [children]: [],
            },
          ],
        },
      ],
    },
    { truncated: false },
    limits,
  );

  assert.deepEqual(result.nodes, [
    {
      index: 0,
      type: 'Application',
      role: 'Application',
      rect: { x: 0, y: 0, width: 390, height: 844 },
      depth: 0,
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'Window',
      role: 'Window',
      subrole: 'UIWindow',
      rect: { x: 0, y: 0, width: 390, height: 844 },
      depth: 1,
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Continue',
      rect: { x: 20, y: 700, width: 120, height: 48 },
      depth: 2,
    },
  ]);
  assert.deepEqual(result.viewport, {
    kind: 'reported',
    rect: { x: 0, y: 0, width: 390, height: 844 },
  });
  assert.equal(result.maxTraversalDepth, 2);
  assert.equal(result.opaqueRemoteElements, 0);
});

test('the bridge tree counts web-hosted remote leaves that reach the viewport', () => {
  const viewport = { X: 0, Y: 0, Width: 390, Height: 844 };
  const remoteLeaf = (rect?: Record<string, number>) => ({
    [application]: 'AXRemoteElement',
    [baseType]: 'NSObject',
    ...(rect ? { [frame]: rect } : {}),
    [children]: [],
  });
  const decode = (host: Record<string, unknown>, root: Record<string, unknown> = {}) =>
    decodeSnapshotBridgeTree(
      { [application]: 'Application', [frame]: viewport, [children]: [host], ...root },
      { truncated: false },
      limits,
    );
  const webView = (content: Record<string, unknown>) => ({
    [automationType]: 58,
    [frame]: viewport,
    [children]: [
      {
        [automationType]: 58,
        [baseType]: 'WKContentView',
        [frame]: viewport,
        [children]: [content],
      },
    ],
  });

  const opaque = decode(webView(remoteLeaf(viewport)));
  assert.equal(opaque.nodes[2]?.type, 'WebView');
  assert.equal(opaque.nodes[3]?.role, 'AXRemoteElement');
  assert.equal(opaque.opaqueRemoteElements, 1);

  assert.equal(decode(webView(remoteLeaf())).opaqueRemoteElements, 1, 'frameless leaf refuses');
  assert.equal(
    decode(webView(remoteLeaf({ X: 0, Y: 0, Width: 0, Height: 0 }))).opaqueRemoteElements,
    0,
    'zero-area leaf hosts nothing',
  );
  assert.equal(
    decode(webView(remoteLeaf({ X: 0, Y: 2000, Width: 390, Height: 600 }))).opaqueRemoteElements,
    0,
    'off-screen leaf is not on this screen',
  );
  assert.equal(
    decode(webView(remoteLeaf({ X: 0, Y: 2000, Width: 390, Height: 600 })), { [frame]: undefined })
      .opaqueRemoteElements,
    1,
    'without a viewport a positive-area leaf refuses',
  );
  assert.equal(
    decode({ [automationType]: 0, [frame]: viewport, [children]: [remoteLeaf(viewport)] })
      .opaqueRemoteElements,
    0,
    'a remote leaf outside a web view is not classified',
  );
  assert.equal(
    decode(
      webView({
        ...remoteLeaf(viewport),
        [children]: [{ [automationType]: 42, [label]: 'More information', [children]: [] }],
      }),
    ).opaqueRemoteElements,
    0,
    'a crossed boundary is not opaque',
  );
});

test('the bridge tree reads enabled from the NotEnabled trait', () => {
  const button = (word?: unknown) => ({
    [automationType]: 9,
    [label]: 'Place order',
    [frame]: { X: 20, Y: 700, Width: 120, Height: 48 },
    ...(word === undefined ? {} : { [traits]: word }),
    [children]: [],
  });
  const decode = (word?: unknown) =>
    decodeSnapshotBridgeTree(
      { [application]: 'Application', [children]: [button(word)] },
      { truncated: false },
      limits,
    ).nodes[1];

  const buttonTrait = 1n;
  const notEnabledTrait = 1n << 8n;
  const toggleButtonTrait = 1n << 53n;
  const privateHighTrait = 1n << 60n;
  const word = (traits: bigint) => traits.toString();
  assert.equal(decode(word(buttonTrait))?.enabled, true);
  assert.equal(decode(word(buttonTrait | notEnabledTrait))?.enabled, false);
  assert.equal(decode(word(0n))?.enabled, true);
  assert.equal(decode(word(toggleButtonTrait))?.enabled, true, 'a switch reads past 2^53');
  assert.equal(
    decode(word(toggleButtonTrait | notEnabledTrait))?.enabled,
    false,
    'a disabled switch',
  );
  assert.equal(
    decode(word(privateHighTrait | notEnabledTrait))?.enabled,
    false,
    'a word past double precision keeps bit 8',
  );
  assert.equal(decode(word(privateHighTrait | 255n))?.enabled, true, 'no carry into bit 8');
  assert.equal(decode()?.enabled, undefined, 'no traits word leaves enabled unknown');
  const traitsInvalid = (error: unknown) =>
    error instanceof SnapshotSourceError && error.failureCode === 'traits-invalid';
  assert.throws(() => decode(256), traitsInvalid);
  assert.throws(() => decode('1.5'), traitsInvalid);
  assert.throws(() => decode('-1'), traitsInvalid);
  assert.throws(() => decode(''), traitsInvalid);
});

test('the bridge tree rejects unknown fields, invalid frames, and bounded overflows', () => {
  assert.throws(
    () => decodeSnapshotBridgeTree({ [children]: [], unknown: true }, { truncated: false }, limits),
    /node-contains-unknown-field/,
  );
  assert.throws(
    () =>
      decodeSnapshotBridgeTree(
        { [frame]: { X: 0, Y: 0, Width: -1, Height: 1 }, [children]: [] },
        { truncated: false },
        limits,
      ),
    /frame-invalid/,
  );
  assert.throws(
    () =>
      decodeSnapshotBridgeTree(
        {
          [children]: Array.from({ length: limits.maxNodes + 1 }, () => ({ [children]: [] })),
        },
        { truncated: false },
        limits,
      ),
    /node-limit-exceeded/,
  );
});

test('the bridge tree requires a typed truncation flag', () => {
  assert.throws(
    () => decodeSnapshotBridgeTree({ [children]: [] }, { truncated: 'yes' }, limits),
    /truncated-invalid/,
  );
});

test('a window reporting the app box quarter-turned is counted as an unresolved coordinate space', () => {
  const landscapeKeyboardWindow = {
    [application]: 'Application',
    [baseType]: 'UIRemoteKeyboardWindow',
    [frame]: { X: 0, Y: 0, Width: 402, Height: 874 },
    [children]: [
      {
        [automationType]: 20,
        [label]: 'q',
        [frame]: { X: 154, Y: 77, Width: 45, Height: 72 },
        [children]: [],
      },
    ],
  };
  const appWindow = {
    [application]: 'Application',
    [baseType]: 'UIWindow',
    [frame]: { X: 0, Y: 0, Width: 874, Height: 402 },
    [children]: [],
  };
  const turned = (roots: unknown[]) =>
    decodeSnapshotBridgeTree(
      {
        [application]: 'Application',
        [frame]: { X: 0, Y: 0, Width: 874, Height: 402 },
        [children]: roots,
      },
      { truncated: false },
      limits,
    ).unresolvedCoordinateSpaceWindows;

  assert.equal(turned([appWindow, landscapeKeyboardWindow]), 1);
  // The shape the runner's own tree reports: the window keeps the app's box and the surface under it
  // carries the turn.
  assert.equal(
    turned([
      {
        [application]: 'Window',
        [baseType]: 'UIRemoteKeyboardWindow',
        [frame]: { X: 0, Y: 0, Width: 874, Height: 402 },
        [children]: [{ ...landscapeKeyboardWindow, [application]: 'Other' }],
      },
    ]),
    1,
  );
  // Deep in the tree, a turned box is content reporting large bounds rather than a hosted surface.
  assert.equal(
    turned([
      {
        [application]: 'Window',
        [frame]: { X: 0, Y: 0, Width: 874, Height: 402 },
        [children]: [
          {
            [application]: 'Group',
            [frame]: { X: 0, Y: 0, Width: 874, Height: 402 },
            [children]: [{ ...landscapeKeyboardWindow, [application]: 'Group' }],
          },
        ],
      },
    ]),
    0,
  );
  assert.equal(turned([appWindow]), 0);
  // Reading the turned window as the app frame flags the app's own window instead: the turned node
  // matches its own frame exactly, and the app window becomes the turned one. An unexpected root order
  // still refuses rather than publishing a screen in two spaces.
  assert.equal(
    decodeSnapshotBridgeTree(
      [{ ...landscapeKeyboardWindow, [children]: [] }, appWindow],
      { truncated: false },
      limits,
    ).unresolvedCoordinateSpaceWindows,
    1,
  );
  // Portrait: the two spaces coincide, and a square app frame cannot be told from its own turn.
  assert.equal(
    decodeSnapshotBridgeTree(
      {
        [application]: 'Application',
        [frame]: { X: 0, Y: 0, Width: 402, Height: 874 },
        [children]: [
          { ...landscapeKeyboardWindow, [frame]: { X: 0, Y: 0, Width: 402, Height: 874 } },
        ],
      },
      { truncated: false },
      limits,
    ).unresolvedCoordinateSpaceWindows,
    0,
  );
  assert.equal(
    decodeSnapshotBridgeTree(
      {
        [application]: 'Application',
        [frame]: { X: 0, Y: 0, Width: 402, Height: 402 },
        [children]: [
          { ...landscapeKeyboardWindow, [frame]: { X: 0, Y: 0, Width: 402, Height: 402 } },
        ],
      },
      { truncated: false },
      limits,
    ).unresolvedCoordinateSpaceWindows,
    0,
  );
});
