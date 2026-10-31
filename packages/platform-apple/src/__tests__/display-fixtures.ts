/** Verbatim `devicectl device info displays` shape for a closed iPhone Duo. */
export const IPHONE_DUO_CLOSED = {
  result: {
    displays: [
      {
        active: true,
        backlightState: 'activeOn',
        bounds: [
          [0, 0],
          [1398, 2034],
        ],
        currentOrientation: 'rot0',
        displayId: 1,
        name: 'LCD',
        nativeOrientation: 'rot0',
        nativeSize: [1398, 2034],
        pointScale: 3,
        primary: true,
        type: { integrated: {} },
        uniqueId: '2C570360-1D02-40A1-BFBF-11197BB1159C',
      },
      {
        active: false,
        backlightState: 'off',
        bounds: [
          [0, 0],
          [2007, 2853],
        ],
        currentOrientation: 'rot90',
        displayId: 3,
        name: 'LCD-1',
        nativeOrientation: 'rot0',
        nativeSize: [2007, 2853],
        pointScale: 3,
        primary: false,
        type: { integrated: {} },
        uniqueId: '162CC14D-0995-4D13-9C83-B609458243C8',
      },
    ],
    orientation: { currentDeviceOrientation: 'portrait' },
  },
};

/**
 * The same Duo with the hinge open: the inner panel is lit and the outer one is dark. The `rot90`
 * the inner panel reports in a portrait hold is what makes its interaction space 951x669 for a
 * 669x951 native panel (ADR 0025).
 */
export const IPHONE_DUO_OPEN = {
  result: {
    displays: [
      {
        active: false,
        backlightState: 'off',
        bounds: [
          [0, 0],
          [1398, 2034],
        ],
        currentOrientation: 'rot0',
        displayId: 1,
        name: 'LCD',
        nativeOrientation: 'rot0',
        nativeSize: [1398, 2034],
        pointScale: 3,
        primary: true,
        type: { integrated: {} },
        uniqueId: '2C570360-1D02-40A1-BFBF-11197BB1159C',
      },
      {
        active: true,
        backlightState: 'activeOn',
        bounds: [
          [0, 0],
          [2007, 2853],
        ],
        currentOrientation: 'rot90',
        displayId: 3,
        name: 'LCD-1',
        nativeOrientation: 'rot0',
        nativeSize: [2007, 2853],
        pointScale: 3,
        primary: false,
        type: { integrated: {} },
        uniqueId: '162CC14D-0995-4D13-9C83-B609458243C8',
      },
    ],
    orientation: { currentDeviceOrientation: 'portrait' },
  },
};

/** Measured on a real iPhone 17: CoreDevice omits `active` entirely for one panel. */
export const IPHONE_17_SINGLE_PANEL = {
  result: {
    displays: [
      {
        backlightState: 'activeOn',
        displayId: 1,
        name: 'LCD',
        nativeSize: [1206, 2622],
        pointScale: 3,
        primary: true,
        type: { integrated: {} },
      },
    ],
  },
};
