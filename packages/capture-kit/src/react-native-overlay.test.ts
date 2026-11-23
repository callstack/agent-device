import { describe, expect, test } from 'vitest';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { snapshotViewportSizeFrom } from '@agent-device/kernel/rect';
import {
  analyzeReactNativeOverlay,
  formatReactNativeOverlayWarning,
} from './react-native-overlay.ts';

/**
 * Exercises the collapsed-warning scoring seam through the package's public analyzer. The
 * scoring comparators only run once two or more banner candidates are tied for dismissal, so
 * the single-banner daemon-handler tests never reach them.
 */

function node(overrides: Partial<SnapshotNode> & { ref: string; index: number }): SnapshotNode {
  return { kind: 'Unknown', ...overrides } as SnapshotNode;
}

const collapsedBannerRect = { x: 0, y: 794, width: 402, height: 52 };

describe('React Native collapsed warning dismissal', () => {
  test('a hittable banner wins dismissal over a non-hittable one at any position', () => {
    const state = analyzeReactNativeOverlay([
      node({
        index: 0,
        ref: 'e1',
        label: '!, Warning at the very bottom',
        rect: { ...collapsedBannerRect, y: 900 },
        hittable: false,
      }),
      node({
        index: 1,
        ref: 'e2',
        label: '!, Warning above it',
        rect: { ...collapsedBannerRect, y: 794 },
        hittable: true,
      }),
    ]);

    expect(state.detected).toBe(true);
    // Hittability outranks position: the tappable banner wins even though the other sits lower.
    expect(state.primaryAction).toMatchObject({
      action: 'close-collapsed-banner',
      ref: 'e2',
      label: '!, Warning above it',
    });
  });

  test('between two equally hittable banners the wider one is dismissed first', () => {
    const state = analyzeReactNativeOverlay([
      node({
        index: 0,
        ref: 'e1',
        label: '!, Narrow warning',
        rect: { x: 0, y: 500, width: 200, height: 52 },
        hittable: true,
      }),
      node({
        index: 1,
        ref: 'e2',
        label: '!, Wide warning',
        rect: { x: 0, y: 400, width: 402, height: 52 },
        hittable: true,
      }),
    ]);

    expect(state.primaryAction?.ref).toBe('e2');
  });

  test('two banners without a hittable fact fall back to width and then the lower position', () => {
    const state = analyzeReactNativeOverlay([
      node({
        index: 0,
        ref: 'e1',
        label: '!, Upper warning',
        rect: { x: 0, y: 300, width: 402, height: 52 },
      }),
      node({
        index: 1,
        ref: 'e2',
        label: '!, Lower warning',
        rect: { x: 0, y: 794, width: 402, height: 52 },
      }),
    ]);

    // Both score 0 on hittable and width, so the greater y — the banner the user sees last — wins.
    expect(state.primaryAction?.ref).toBe('e2');
  });

  test('formatReactNativeOverlayWarning answers only for a detected overlay', () => {
    const warning = formatReactNativeOverlayWarning([
      node({
        index: 0,
        ref: 'e1',
        label: '!, Open debugger to view warnings.',
        rect: collapsedBannerRect,
        hittable: true,
      }),
    ]);
    expect(warning).toContain('agent-device react-native dismiss-overlay');

    expect(formatReactNativeOverlayWarning([node({ index: 0, ref: 'e1', label: 'Save' })])).toBe(
      undefined,
    );
  });
});

describe('React Native overlay evidence', () => {
  test('app text with a generic severity prefix is not an overlay', () => {
    const nodes = [
      node({
        index: 0,
        ref: 'e1',
        type: 'StaticText',
        label: 'Error: invalid email',
        rect: { x: 16, y: 300, width: 300, height: 44 },
      }),
      node({ index: 1, ref: 'e2', type: 'Button', label: 'Close', hittable: true }),
    ];
    expect(analyzeReactNativeOverlay(nodes).detected).toBe(false);
    expect(formatReactNativeOverlayWarning(nodes)).toBe(undefined);
  });

  test('iOS app error text in a two-line banner-sized StaticText is not an overlay', () => {
    // iOS reports `hittable` from geometry, so every visible StaticText is hittable: neither that
    // flag nor the banner shape is evidence for a bare severity prefix.
    const nodes = [
      node({
        index: 0,
        ref: 'e1',
        type: 'StaticText',
        label: 'Error: password must contain at least 8 characters and one number',
        rect: { x: 16, y: 412, width: 370, height: 40 },
        hittable: true,
      }),
    ];
    expect(analyzeReactNativeOverlay(nodes).detected).toBe(false);
    expect(formatReactNativeOverlayWarning(nodes)).toBe(undefined);
  });

  test('a generic severity banner counts once a React Native stack frame is on screen', () => {
    const nodes = [
      node({ index: 0, ref: 'e1', label: 'Warning: state update on unmounted component' }),
      node({ index: 1, ref: 'e2', label: 'App.tsx:42:7', rect: collapsedBannerRect }),
    ];
    expect(analyzeReactNativeOverlay(nodes).detected).toBe(true);
  });

  test('a collapsed LogBox summary banner is an overlay by itself', () => {
    const nodes = [
      node({ index: 0, ref: 'e1', label: '!, Warning: x', rect: collapsedBannerRect }),
    ];
    expect(analyzeReactNativeOverlay(nodes).detected).toBe(true);
  });
});

/**
 * From two entries up, LogBox's badge renders the entry count instead of `!`
 * (`LogBoxNotificationCountBadge`), so the banner's joined label starts with a number. App rows
 * open the same way, which is why the count form arms only on LogBox's own banner placement.
 */
describe('React Native collapsed banner with the entry-count badge', () => {
  const iosViewport = snapshotViewportSizeFrom({ x: 0, y: 0, width: 402, height: 874 });
  const androidViewport = snapshotViewportSizeFrom({ x: 0, y: 0, width: 1080, height: 2400 });
  /** LogBox's frame on a 402x874 surface: `left: 10; right: 10; bottom: 20`, notification 48 high. */
  const iosCountBannerRect = { x: 10, y: 806, width: 382, height: 48 };

  test('a banner whose badge shows the entry count is an overlay and a dismiss target', () => {
    const state = analyzeReactNativeOverlay(
      [
        node({
          index: 0,
          ref: 'e1',
          label: '20, Failed to fetch',
          rect: iosCountBannerRect,
          hittable: true,
        }),
      ],
      iosViewport,
    );

    expect(state.detected).toBe(true);
    expect(state.primaryAction).toMatchObject({
      action: 'close-collapsed-banner',
      ref: 'e1',
      label: '20, Failed to fetch',
    });
  });

  test('a device-pixel count banner floating off the bottom edge is an overlay', () => {
    // Android rects are physical pixels, so LogBox's 10 dp inset reads as 10 x density there: 26.25
    // px on this 420 dpi capture, and the 20 dp bottom gap as 52.5 px.
    const state = analyzeReactNativeOverlay(
      [
        node({
          index: 0,
          ref: 'e1',
          label: '8, Network request failed',
          rect: { x: 26.25, y: 2213.25, width: 1027.5, height: 126 },
          hittable: true,
        }),
      ],
      { width: 1080, height: 2400, rectUnitsPerDp: 2.625 },
    );

    expect(state.detected).toBe(true);
  });

  test('a device-pixel count banner is not an overlay when the capture published no density', () => {
    // Without the density, 26 px cannot be read as LogBox's 10 dp, and guessing one would arm on any
    // inset card whose gap happens to measure ten pixels.
    const state = analyzeReactNativeOverlay(
      [
        node({
          index: 0,
          ref: 'e1',
          label: '8, Network request failed',
          rect: { x: 26.25, y: 2213.25, width: 1027.5, height: 126 },
          hittable: true,
        }),
      ],
      androidViewport,
    );

    expect(state.detected).toBe(false);
  });

  test('an ordinary row whose label starts with a number is not an overlay', () => {
    const nodes = [
      node({
        index: 0,
        ref: 'e1',
        label: '2, Morning',
        rect: { x: 0, y: 320, width: 402, height: 52 },
        hittable: true,
      }),
    ];
    expect(analyzeReactNativeOverlay(nodes, iosViewport).detected).toBe(false);
    expect(formatReactNativeOverlayWarning(nodes, iosViewport)).toBe(undefined);
  });

  test('a tab bar row whose label starts with a number is not an overlay', () => {
    const nodes = [
      node({
        index: 0,
        ref: 'e1',
        label: '3, Cart',
        rect: { x: 202, y: 811, width: 200, height: 63 },
        hittable: true,
      }),
    ];
    expect(analyzeReactNativeOverlay(nodes, iosViewport).detected).toBe(false);
    expect(formatReactNativeOverlayWarning(nodes, iosViewport)).toBe(undefined);
  });

  test('a full-width footer row flush with the bottom edge is not an overlay', () => {
    const nodes = [
      node({
        index: 0,
        ref: 'e1',
        label: '2, Continue shopping',
        rect: { x: 0, y: 822, width: 402, height: 52 },
        hittable: true,
      }),
    ];
    expect(analyzeReactNativeOverlay(nodes, iosViewport).detected).toBe(false);
    expect(formatReactNativeOverlayWarning(nodes, iosViewport)).toBe(undefined);
  });

  test('a tablet-width count banner keeps the fixed LogBox side gap', () => {
    // LogBox pins the banner 10 units from both edges whatever the surface: a 13" iPad Pro portrait
    // window, an iPad in landscape, an unfolded foldable.
    const iPadViewport = snapshotViewportSizeFrom({ x: 0, y: 0, width: 1032, height: 1376 });
    const state = analyzeReactNativeOverlay(
      [
        node({
          index: 0,
          ref: 'e1',
          label: '7, Unable to load image',
          rect: { x: 10, y: 1308, width: 1012, height: 48 },
          hittable: true,
        }),
      ],
      iPadViewport,
    );

    expect(state.detected).toBe(true);
  });

  test('an inset card above the tab bar is not an overlay', () => {
    // The card keeps 16pt side gaps, wider than LogBox's fixed 10, so only the banner's own gap
    // width separates it from a count banner.
    const nodes = [
      node({
        index: 0,
        ref: 'e1',
        label: '3, New messages',
        rect: { x: 16, y: 719, width: 370, height: 72 },
        hittable: true,
      }),
    ];
    expect(analyzeReactNativeOverlay(nodes, iosViewport).detected).toBe(false);
    expect(formatReactNativeOverlayWarning(nodes, iosViewport)).toBe(undefined);
  });

  test('an inset card on a landscape tablet is not an overlay', () => {
    // The same 16pt card on a 1366x1024 surface: the gap stays 16 while the surface grows, and
    // LogBox's own gap stays 10, so a card cannot reach the banner's placement by being wide.
    const landscape = snapshotViewportSizeFrom({ x: 0, y: 0, width: 1366, height: 1024 });
    const nodes = [
      node({
        index: 0,
        ref: 'e1',
        label: '4, 3 messages failed to send',
        rect: { x: 16, y: 900, width: 1334, height: 72 },
        hittable: true,
      }),
    ];
    expect(analyzeReactNativeOverlay(nodes, landscape).detected).toBe(false);
    expect(formatReactNativeOverlayWarning(nodes, landscape)).toBe(undefined);
  });

  test('a price label is not an overlay', () => {
    const nodes = [
      node({
        index: 0,
        ref: 'e1',
        label: '20,000원',
        rect: iosCountBannerRect,
        hittable: true,
      }),
    ];
    expect(analyzeReactNativeOverlay(nodes, iosViewport).detected).toBe(false);
    expect(formatReactNativeOverlayWarning(nodes, iosViewport)).toBe(undefined);
  });

  test('a count banner is not an overlay when the capture published no box', () => {
    const nodes = [
      node({
        index: 0,
        ref: 'e1',
        label: '20, Failed to fetch',
        rect: iosCountBannerRect,
        hittable: true,
      }),
    ];
    expect(analyzeReactNativeOverlay(nodes).detected).toBe(false);
  });
});

/**
 * Shapes from an iOS 27 capture of React Native 0.88 with the app's own `[button] "Close"` and
 * `[button] "Dismiss"` on screen, where the overlay controls are LogBox's. Tests marked synthetic
 * build app layouts and Android or RedBox shapes from their layout code instead.
 */
describe('React Native overlay dismissal beside app Close and Dismiss buttons', () => {
  const viewport = snapshotViewportSizeFrom({ x: 0, y: 0, width: 402, height: 874 });
  const appButtons = [
    node({
      index: 9,
      ref: 'e10',
      type: 'Button',
      label: 'Close',
      rect: { x: 18, y: 231, width: 73, height: 45 },
      hittable: true,
    }),
    node({
      index: 10,
      ref: 'e11',
      type: 'Button',
      label: 'Dismiss',
      rect: { x: 99, y: 231, width: 89, height: 45 },
      hittable: true,
    }),
  ];
  const collapsedBanner = node({
    index: 48,
    ref: 'e49',
    type: 'Other',
    label: '!, agent-device overlay check',
    rect: { x: 10, y: 788, width: 382, height: 48 },
    hittable: true,
  });
  const componentStackText = node({
    index: 50,
    ref: 'e51',
    type: 'StaticText',
    label: 'Component Stack',
    rect: { x: 12, y: 659, width: 378, height: 20 },
  });
  const footerTile = (index: number, label: string, x: number, extra: Partial<SnapshotNode> = {}) =>
    node({
      index,
      ref: `e${index + 1}`,
      type: 'Other',
      label,
      rect: { x, y: 792, width: 134, height: 48 },
      hittable: false,
      ...extra,
    });
  /** LogBox's inspector footer as the XCTest capture lists it: three `flex: 1` tiles. */
  const inspectorFooter = [
    footerTile(59, 'Dismiss', 0),
    footerTile(60, 'Minimize', 134),
    footerTile(61, 'Copy', 268),
  ];

  test('a collapsed banner is closed at its own affordance, not at an app Close or Dismiss', () => {
    const state = analyzeReactNativeOverlay([...appButtons, collapsedBanner], viewport);

    expect(state.primaryAction).toMatchObject({
      action: 'close-collapsed-banner',
      ref: 'e49',
      point: { x: 370, y: 812 },
    });
  });

  test.each(['Dismiss', '×', 'Close'])(
    'synthetic: an app %s under the floating banner is not the banner close',
    (label) => {
      // LogBox floats over app content, so an app control can sit inside the banner's frame.
      const state = analyzeReactNativeOverlay(
        [
          collapsedBanner,
          node({
            index: 60,
            ref: 'e60',
            type: 'Button',
            label,
            parentIndex: 1,
            rect: { x: 300, y: 796, width: 80, height: 32 },
            hittable: true,
          }),
        ],
        viewport,
      );

      expect(state.primaryAction).toMatchObject({ action: 'close-collapsed-banner', ref: 'e49' });
    },
  );

  test('an app Dismiss beside inspector text alone is not a target', () => {
    const state = analyzeReactNativeOverlay(
      [
        ...appButtons,
        node({
          index: 84,
          ref: 'e84',
          type: 'StaticText',
          label: 'Call Stack',
          rect: { x: 12, y: 300, width: 90, height: 24 },
        }),
      ],
      viewport,
    );

    expect(state.detected).toBe(true);
    expect(state.primaryAction).toBe(null);
  });

  test('the inspector footer Dismiss wins over app buttons whatever its role', () => {
    const state = analyzeReactNativeOverlay(
      [...appButtons, componentStackText, ...inspectorFooter, collapsedBanner],
      viewport,
    );

    expect(state.primaryAction).toMatchObject({
      action: 'dismiss',
      ref: 'e60',
      point: { x: 67, y: 816 },
    });
  });

  test.each([
    { direction: 'left-to-right', minimizeX: 134, copyX: 268, tapX: 67 },
    { direction: 'right-to-left', minimizeX: 134, copyX: 0, tapX: 335 },
  ])(
    'a $direction footer folded into its Dismiss row is tapped in the Dismiss column',
    ({ minimizeX, copyX, tapX }) => {
      // The simulator accessibility capture labels the footer row with its first tile and nests
      // Minimize and Copy inside it, so the row's center would land on Minimize. Left to right is
      // from the device; right to left mirrors it.
      const row = { y: 792, width: 134, height: 82 };
      const state = analyzeReactNativeOverlay(
        [
          ...appButtons,
          componentStackText,
          node({
            index: 64,
            ref: 'e65',
            type: 'Other',
            label: 'Dismiss',
            rect: { x: 0, y: 792, width: 402, height: 82 },
            hittable: true,
          }),
          node({ index: 65, ref: 'e66', label: 'Minimize', rect: { ...row, x: minimizeX } }),
          node({ index: 66, ref: 'e67', label: 'Copy', rect: { ...row, x: copyX } }),
          { ...collapsedBanner, rect: { x: 10, y: 786.67, width: 382, height: 67.33 } },
        ],
        viewport,
      );

      expect(state.primaryAction).toMatchObject({
        action: 'dismiss',
        ref: 'e65',
        point: { x: tapX, y: 833 },
      });
    },
  );

  test('synthetic: a right-to-left footer keeps its Dismiss across float32 tile edges', () => {
    // A 430pt window splits into thirds that the tree reports as float32.
    const tile = (index: number, label: string, x: number) =>
      node({
        index,
        ref: `e${index}`,
        label,
        rect: { x, y: 850, width: 143.3333282470703, height: 48 },
      });
    const state = analyzeReactNativeOverlay(
      [
        ...appButtons,
        componentStackText,
        tile(59, 'Copy', 0),
        tile(60, 'Minimize', 143.33334350585938),
        tile(61, 'Dismiss', 286.6666564941406),
      ],
      snapshotViewportSizeFrom({ x: 0, y: 0, width: 430, height: 932 }),
    );

    expect(state.primaryAction).toMatchObject({ action: 'dismiss', ref: 'e61' });
  });

  test('synthetic: an app row with its own Reload and Dismiss is not the inspector footer', () => {
    const state = analyzeReactNativeOverlay(
      [
        node({
          index: 30,
          ref: 'e30',
          type: 'Button',
          label: 'Reload',
          rect: { x: 18, y: 300, width: 80, height: 44 },
          hittable: true,
        }),
        node({
          index: 31,
          ref: 'e31',
          type: 'Button',
          label: 'Dismiss',
          rect: { x: 106, y: 300, width: 89, height: 44 },
          hittable: true,
        }),
        componentStackText,
        ...inspectorFooter,
      ],
      viewport,
    );

    expect(state.primaryAction).toMatchObject({ action: 'dismiss', ref: 'e60' });
  });

  test.each([
    { shape: 'an inset segmented pair in portrait', width: 402, height: 874, x: 66 },
    { shape: 'an alert button pair in landscape', width: 874, height: 402, x: 302 },
  ])('synthetic: $shape of flush Reload and Dismiss is not a footer', ({ width, height, x }) => {
    const button = (index: number, label: string, left: number) =>
      node({
        index,
        ref: `e${index}`,
        type: 'Button',
        label,
        rect: { x: left, y: 300, width: 135, height: 44 },
        hittable: true,
      });
    const state = analyzeReactNativeOverlay(
      [button(30, 'Reload', x), button(31, 'Dismiss', x + 135), collapsedBanner],
      snapshotViewportSizeFrom({ x: 0, y: 0, width, height }),
    );

    expect(state.primaryAction).toMatchObject({ action: 'close-collapsed-banner', ref: 'e49' });
  });

  test('synthetic: an app Dismiss centered on screen with no footer partners is not a footer', () => {
    const state = analyzeReactNativeOverlay(
      [
        node({
          index: 30,
          ref: 'e30',
          type: 'Button',
          label: 'Dismiss',
          rect: { x: 151, y: 500, width: 100, height: 44 },
          hittable: true,
        }),
        collapsedBanner,
      ],
      viewport,
    );

    expect(state.primaryAction).toMatchObject({ action: 'close-collapsed-banner', ref: 'e49' });
  });

  test('synthetic: a footer row with a second Copy off its column is not read as a footer', () => {
    const state = analyzeReactNativeOverlay(
      [
        componentStackText,
        node({
          index: 70,
          ref: 'e70',
          label: 'Copy',
          rect: { x: 300, y: 792, width: 60, height: 48 },
        }),
        ...inspectorFooter,
      ],
      viewport,
    );

    expect(state.detected).toBe(true);
    expect(state.primaryAction).toBe(null);
  });

  test('without a surface, a three-column footer is still read', () => {
    // macOS desktop captures publish no viewport.
    const state = analyzeReactNativeOverlay([
      componentStackText,
      ...inspectorFooter,
      collapsedBanner,
    ]);

    expect(state.primaryAction).toMatchObject({ action: 'dismiss', ref: 'e60', point: { x: 67 } });
  });

  test("synthetic: without a surface, an app's flush two-button row is not a footer", () => {
    const button = (index: number, label: string, x: number) =>
      node({ index, ref: `e${index}`, label, rect: { x, y: 300, width: 135, height: 44 } });
    const state = analyzeReactNativeOverlay([
      button(30, 'Reload', 66),
      button(31, 'Dismiss', 201),
      collapsedBanner,
    ]);

    expect(state.primaryAction).toMatchObject({ action: 'close-collapsed-banner', ref: 'e49' });
  });

  test('synthetic: a malformed footer row does not fall back to the banner under it', () => {
    const state = analyzeReactNativeOverlay(
      [
        componentStackText,
        inspectorFooter[0]!,
        footerTile(60, 'Minimize', 113),
        inspectorFooter[2]!,
        collapsedBanner,
      ],
      viewport,
    );

    expect(state.detected).toBe(true);
    expect(state.primaryAction).toBe(null);
  });

  test('synthetic: an app Close beside a media player Minimize leaves the banner close', () => {
    const state = analyzeReactNativeOverlay(
      [footerTile(30, 'Minimize', 134), footerTile(31, 'Close', 0), collapsedBanner],
      viewport,
    );

    expect(state.primaryAction).toMatchObject({ action: 'close-collapsed-banner', ref: 'e49' });
  });

  test.each([
    { shape: 'stops short of the left edge', start: 20, width: 127.33 },
    { shape: 'stops short of the right edge', start: 0, width: 127.33 },
    { shape: 'runs past the left edge', start: -20, width: 140.67 },
  ])('synthetic: a portrait footer row that $shape is not read', ({ start, width }) => {
    const tiles = ['Dismiss', 'Minimize', 'Copy'].map((label, column) =>
      node({
        index: 59 + column,
        ref: `e${60 + column}`,
        label,
        rect: { x: start + column * width, y: 792, width, height: 48 },
      }),
    );
    const state = analyzeReactNativeOverlay(
      [componentStackText, ...tiles, collapsedBanner],
      viewport,
    );

    expect(state.primaryAction).toBe(null);
  });

  test('synthetic: an app Dismiss and a media player Minimize on different rows leave the banner close', () => {
    const state = analyzeReactNativeOverlay(
      [
        ...appButtons,
        node({
          index: 30,
          ref: 'e30',
          type: 'Button',
          label: 'Minimize',
          rect: { x: 18, y: 400, width: 100, height: 44 },
          hittable: true,
        }),
        collapsedBanner,
      ],
      viewport,
    );

    expect(state.primaryAction).toMatchObject({ action: 'close-collapsed-banner', ref: 'e49' });
  });

  test('synthetic: a Close tile beside Minimize and Copy is not the footer Dismiss', () => {
    const state = analyzeReactNativeOverlay(
      [componentStackText, footerTile(59, 'Close', 0), ...inspectorFooter.slice(1)],
      viewport,
    );

    expect(state.primaryAction).toBe(null);
  });

  test('synthetic: an app container titled with overlay words does not vouch for its Close', () => {
    const state = analyzeReactNativeOverlay(
      [
        node({
          index: 1,
          ref: 'e1',
          type: 'Other',
          label: 'Runtime error',
          rect: { x: 16, y: 300, width: 370, height: 200 },
        }),
        node({
          index: 2,
          ref: 'e2',
          type: 'Button',
          label: 'Close',
          parentIndex: 1,
          rect: { x: 334, y: 308, width: 44, height: 44 },
          hittable: true,
        }),
        node({
          index: 3,
          ref: 'e3',
          type: 'StaticText',
          label: 'Call Stack',
          parentIndex: 1,
          rect: { x: 24, y: 360, width: 90, height: 24 },
        }),
      ],
      viewport,
    );

    expect(state.detected).toBe(true);
    expect(state.primaryAction).toBe(null);
  });

  test('synthetic: an app "Dismiss (Esc)" button beside a banner is not RedBox', () => {
    const state = analyzeReactNativeOverlay(
      [
        node({
          index: 30,
          ref: 'e30',
          type: 'Button',
          label: 'Dismiss (Esc)',
          rect: { x: 18, y: 400, width: 120, height: 44 },
          hittable: true,
        }),
        collapsedBanner,
      ],
      viewport,
    );

    expect(state.primaryAction).toMatchObject({ action: 'close-collapsed-banner', ref: 'e49' });
  });

  test("synthetic: RedBox's footer Dismiss wins over an app Dismiss button", () => {
    // RCTRedBoxController: four buttons in a fill-equally stack view across the window.
    const redBoxButton = (index: number, label: string, x: number) =>
      node({
        index,
        ref: `e${index}`,
        type: 'Button',
        label,
        rect: { x, y: 792, width: 100.5, height: 48 },
        hittable: true,
      });
    const state = analyzeReactNativeOverlay(
      [
        ...appButtons,
        node({ index: 1, ref: 'e1', label: 'App.tsx:42:7' }),
        redBoxButton(40, 'Dismiss\n(ESC)', 0),
        redBoxButton(41, 'Reload\n(⌘R)', 100.5),
        redBoxButton(42, 'Copy\n(⌥⌘C)', 201),
        redBoxButton(43, 'Extra Info\n(⌘E)', 301.5),
      ],
      viewport,
    );

    expect(state.primaryAction).toMatchObject({
      action: 'dismiss',
      ref: 'e40',
      point: { x: 50, y: 816 },
    });
  });

  /**
   * Landscape shapes from the same device. Each footer button sits in its own SafeAreaView, so the
   * outer tiles lose the 62 pt side insets: the XCTest capture lists tiles at 62, 291.33 and 582.67,
   * and the simulator accessibility capture folds them into a full-width row labelled Dismiss.
   */
  describe('iPhone landscape inspector footer', () => {
    const landscape = snapshotViewportSizeFrom({ x: 0, y: 0, width: 874, height: 402 });
    const tile = (index: number, label: string, x: number, width: number, height = 48) =>
      node({ index, ref: `e${index + 1}`, label, rect: { x, y: 334, width, height } });

    test('the inset tiles are read as the footer', () => {
      const state = analyzeReactNativeOverlay(
        [
          ...appButtons,
          componentStackText,
          tile(15, 'Dismiss', 62, 229.33),
          tile(16, 'Minimize', 291.33, 291.33),
          tile(17, 'Copy', 582.67, 229.33),
        ],
        landscape,
      );

      expect(state.primaryAction).toMatchObject({
        action: 'dismiss',
        ref: 'e16',
        point: { x: 177, y: 358 },
      });
    });

    test('a folded row is tapped in its Dismiss column', () => {
      const state = analyzeReactNativeOverlay(
        [
          ...appButtons,
          componentStackText,
          tile(41, 'Dismiss', 0, 874, 68),
          tile(42, 'Minimize', 291.33, 291.33, 68),
          tile(43, 'Copy', 582.67, 291.33, 68),
        ],
        landscape,
      );

      expect(state.primaryAction).toMatchObject({
        action: 'dismiss',
        ref: 'e42',
        point: { x: 146, y: 368 },
      });
    });

    test('synthetic: a row inset past the landscape side inset is not a footer', () => {
      const state = analyzeReactNativeOverlay(
        [
          componentStackText,
          tile(15, 'Dismiss', 132, 180),
          tile(16, 'Minimize', 312, 180),
          tile(17, 'Copy', 492, 180),
        ],
        landscape,
      );

      expect(state.primaryAction).toBe(null);
    });
  });

  /**
   * Android publishes physical pixels. The footer's Pressable carries its text as content
   * description, but a capture may list only the centered TextViews, or both.
   */
  describe('synthetic Android inspector footer', () => {
    const surface = { width: 1080, height: 2400, rectUnitsPerDp: 2.625 };
    const text = (index: number, label: string, centerX: number, width: number) =>
      node({
        index,
        ref: `e${index}`,
        type: 'android.widget.TextView',
        label,
        rect: { x: centerX - width / 2, y: 2213, width, height: 53 },
      });
    const footerTexts = [
      // Text sits a few pixels off its column's center, within 2 dp at this density.
      text(70, 'Dismiss', 183, 160),
      text(71, 'Minimize', 543, 182),
      text(72, 'Copy', 897, 102),
    ];
    const footerTiles = ['Dismiss', 'Minimize', 'Copy'].map((label, column) =>
      node({
        index: 80 + column,
        ref: `e${80 + column}`,
        type: 'android.view.ViewGroup',
        label,
        rect: { x: column * 360, y: 2176, width: 360, height: 126 },
        hittable: true,
      }),
    );
    const banner = node({
      index: 90,
      ref: 'e90',
      label: '!, agent-device overlay check',
      rect: { x: 26, y: 2148, width: 1028, height: 126 },
      hittable: true,
    });
    const appDismiss = node({
      index: 20,
      ref: 'e20',
      type: 'android.widget.Button',
      label: 'Dismiss',
      rect: { x: 260, y: 600, width: 230, height: 118 },
      hittable: true,
    });

    test('only the footer text is listed: the Dismiss text is tapped, not the banner below', () => {
      const state = analyzeReactNativeOverlay(
        [appDismiss, componentStackText, ...footerTexts, banner],
        surface,
      );

      expect(state.primaryAction).toMatchObject({
        action: 'dismiss',
        ref: 'e70',
        point: { x: 183, y: 2240 },
      });
    });

    test('tiles and their text are both listed: Dismiss is still one column', () => {
      const state = analyzeReactNativeOverlay(
        [
          appDismiss,
          componentStackText,
          node({ index: 99, ref: 'e99', label: 'Dismiss' }),
          ...footerTiles,
          ...footerTexts,
          node({ index: 98, ref: 'e98', label: 'Minimize' }),
          banner,
        ],
        surface,
      );

      expect(state.primaryAction).toMatchObject({ action: 'dismiss', point: { x: 180 } });
    });

    test('in landscape, a footer inset by the cutout and the navigation bar is still read', () => {
      // LogBoxDialog margins the root by the cutout (110 px) and the side navigation bar (126 px).
      const columnWidth = (2400 - 110 - 126) / 3;
      const tile = (index: number, label: string, column: number) =>
        node({
          index,
          ref: `e${index}`,
          label,
          rect: { x: 110 + column * columnWidth, y: 940, width: columnWidth, height: 126 },
          hittable: true,
        });
      const state = analyzeReactNativeOverlay(
        [
          appDismiss,
          componentStackText,
          tile(80, 'Dismiss', 0),
          tile(81, 'Minimize', 1),
          tile(82, 'Copy', 2),
        ],
        { width: 2400, height: 1080, rectUnitsPerDp: 2.625 },
      );

      expect(state.primaryAction).toMatchObject({
        action: 'dismiss',
        ref: 'e80',
        point: { x: 471 },
      });
    });
  });
});
