// The dithered pixel scenes behind the landing pages' windows: a scene generated in the browser
// and ordered-dithered at a fine grain into a ramp from near-black through a dark mix of the
// accent to the accent. Generated instead of shipped as an image, so it follows the accent.
//
// A scene is built once per size (the slow part: geometry and shading) and then animated
// cheaply, with a few arithmetic operations per cell each frame. Every scene runs in the dither
// worker (dither.worker.ts) or, where OffscreenCanvas is missing, on the page (dither-host.ts),
// and the social card imports this file too (og/og.html), so keep it free of DOM access.
//
// ---------------------------------------------------------------------------------------------
// THE PRODUCT'S SIGNATURE SCENE
//
// Every product gets one scene of its own: a metaphor taken from the product itself (its name,
// what it does, the vocabulary of its docs), drawn in the stepped, dithered language of the
// family. It goes behind the hero visual, on the social card and the banner. agent-device's is
// `loop` (below). Never reuse a sibling product's idea.
//
// To add a scene:
//   1. Write a SceneBuilder: `(cols, rows, focus) => ({ frame: (t) => tones })`.
//      `cols` x `rows` are dither cells (2 CSS px each), `focus` is 0..1 across, where the
//      product visual sits, `t` is seconds. `frame` fills and returns one tone (0..1) per cell:
//      0 is the background, about 0.5 the dark accent mix, 1 the accent.
//   2. Do the geometry once, outside `frame` (which typed arrays hold what per cell: which
//      shape owns it, its shaded tone, how far along it is), and keep `frame` to a few
//      operations per cell. It runs 12 times a second.
//   3. Shade like the family: lit faces about 0.85, shaded faces about 0.55, a bright rim on
//      exposed top edges, a dark gap around each shape so it separates from the ones behind,
//      a faint haze or rock texture behind (0.1 to 0.2), never a gradient on its own.
//   4. Motion is slow and stepped: a glint sweeping across, pulses travelling along. Pick a
//      still moment (`animate` draws t = 9 under reduced motion) that tells the story.
//   5. Add it to `scenes`, then use it: `<Dither scene="yours" focus={0.7} />`, and in og.html.
//   6. Keep sizes tied to the shorter side of the scene, so phone-width scenes don't blow up.
//      No landscapes, photos, 3D renders or smooth gradients.
// ---------------------------------------------------------------------------------------------

// 4x4 Bayer matrix, normalised to 0..1: the threshold a cell's tone must beat to step up.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((n) => (n + 0.5) / 16);

// Integer-hashed value noise. `period` makes it wrap horizontally.
const hash = (x: number, y: number) => {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
const noise = (x: number, y: number, period = 0) => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const x0 = period ? ((xi % period) + period) % period : xi;
  const x1 = period ? (x0 + 1) % period : xi + 1;
  const a = hash(x0, yi);
  const b = hash(x1, yi);
  const c = hash(x0, yi + 1);
  const d = hash(x1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};
const fbm = (x: number, y: number, octaves = 4, period = 0) => {
  let sum = 0;
  let amp = 0.5;
  let p = period;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x, y, p);
    x *= 2;
    y *= 2;
    p *= 2;
    amp *= 0.5;
  }
  return sum / (1 - Math.pow(0.5, octaves));
};
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** A scene at one size: `frame(t)` fills and returns the tone (0..1) of every cell. */
type Scene = { frame: (t: number) => Float32Array };
type SceneBuilder = (cols: number, rows: number, focus: number) => Scene;

/** A horizontally wrapping noise texture, sampled with a sliding offset. */
function mistTexture(cols: number, rows: number, scaleX: number, scaleY: number) {
  const tex = new Float32Array(cols * rows);
  const period = Math.max(1, Math.round(scaleX));
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      tex[y * cols + x] = fbm((x / cols) * period, (y / rows) * scaleY, 4, period);
    }
  }
  return tex;
}

function backdrop(cols: number, rows: number, focus: number, cy = 0.55) {
  const rock = new Float32Array(cols * rows);
  const aspect = cols / rows;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const d = Math.hypot((x / cols - focus) * aspect, (y / rows - cy) * 1.2);
      const grain = fbm((x / cols) * 4.5 * aspect, (y / rows) * 9, 4);
      rock[y * cols + x] = 0.11 * smooth(0.52, 0.85, grain) + 0.12 * Math.exp(-d * d * 4.5);
    }
  }
  return rock;
}

/** One stepped track round the focus: its half width and height, thickness and depth. */
type Track = { a: number; b: number; th: number; depth: number };

/** Signed distance from a cell (relative to the centre) to the track's rounded outline. */
function trackDistance(dx: number, dy: number, R: Track) {
  const r = R.b * 0.45;
  const qx = Math.abs(dx) - (R.a - r);
  const qy = Math.abs(dy) - (R.b - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** A track cell's tone, lit from the top left: the upper and left runs bright. */
function trackTone(d: number, dx: number, dy: number, R: Track) {
  let tone = dy < 0 || (dx < 0 && dy <= R.b * 0.5) ? 0.84 : 0.54;
  if (d > R.th / 2 - 1.5 && dy < 0) tone = 1; // the outer rim on the upper run
  if (d < -R.th / 2 + 1.5) tone *= 0.75; // the inner edge, in shadow
  return tone;
}

/** The per-cell layers a loop scene is built into. */
type LoopCells = {
  cols: number;
  rows: number;
  /** The track that owns a cell (0 is the main one), or -1 rock, -2 gap, -3 socket, -4 outline. */
  ring: Int8Array;
  shade: Float32Array;
  /** 0..1 round the track, clockwise from the left. */
  along: Float32Array;
  /** The station that owns a cell, or -1. */
  station: Int8Array;
};

/**
 * Gives cell (x, y) to the first track it falls on, around the centre (cx, cy). With `hollow`,
 * the main track becomes a dashed outline over an empty socket.
 */
function paintTrackCell(
  c: LoopCells,
  rings: readonly Track[],
  rock: Float32Array,
  x: number,
  y: number,
  cx: number,
  cy: number,
  hollow: boolean,
) {
  const q = Math.max(2, Math.round(rings[0]!.th / 2)); // the step every corner is cut on
  // Quantise to the step grid, so the corners come out stepped.
  const dx = Math.round((x - cx) / q) * q;
  const dy = Math.round((y - cy) / q) * q;
  const k = rings.findIndex((R) => Math.abs(trackDistance(dx, dy, R)) <= R.th / 2);
  if (k < 0) return;
  const R = rings[k]!;
  const d = trackDistance(dx, dy, R);
  const i = y * c.cols + x;
  c.along[i] = (Math.atan2(y - cy, x - cx) + Math.PI) / (2 * Math.PI);
  if (hollow && k === 0) {
    const edge = Math.abs(d) > R.th / 2 - 1.2;
    c.ring[i] = edge && (x + y) % 8 < 4 ? -4 : -3;
    rock[i] = 0;
    return;
  }
  c.ring[i] = k;
  const fade = smooth(0, 0.12, x / c.cols) * smooth(1, 0.88, x / c.cols);
  c.shade[i] = trackTone(d, dx, dy, R) * R.depth * fade;
}

/** A station: a stepped block of `size` centred on (sx, sy), with a dark gap around it. */
function paintStation(c: LoopCells, sx: number, sy: number, size: number, k: number) {
  const y0 = Math.round(sy - size / 2);
  const y1 = Math.round(sy + size / 2);
  const x0 = Math.round(sx - size / 2);
  const x1 = Math.round(sx + size / 2);
  for (let y = Math.max(0, y0 - 1); y < Math.min(c.rows, y1 + 1); y++) {
    for (let x = Math.max(0, x0 - 1); x < Math.min(c.cols, x1 + 1); x++) {
      const i = y * c.cols + x;
      if (y < y0 || y >= y1 || x < x0 || x >= x1) {
        c.shade[i] = 0;
        c.ring[i] = -2;
        continue;
      }
      c.station[i] = k;
      c.ring[i] = 0;
      c.shade[i] = y - y0 < 2 ? 1 : x < sx ? 0.8 : 0.56;
    }
  }
}

/** The glow of two pulses half a turn apart, `speed` turns a second, at `at` round the track. */
function pulseGlow(at: number, t: number, speed: number, width: number, gain: number, depth = 1) {
  let glow = 0;
  for (let p = 0; p < 2; p++) {
    const pos = (((t * speed + p / 2) % 1) + 1) % 1;
    let dd = Math.abs(at - pos);
    dd = Math.min(dd, 1 - dd);
    glow += Math.exp(-((dd / width) ** 2)) * gain * depth;
  }
  return glow;
}

// Loop: the agent closing its own loop on a running app. A stepped track circles the focus,
// with four stations on it (run, read, act, verify), and fainter echoes of the track around
// it. Pulses travel round the track and each station lights as a pulse reaches it. On the 404
// page (`hollow`) the main track and its stations are missing: a dashed outline marks where the
// track should be, and flares as the pulses pass along it.
/** `maxUnit` caps the size of the loop, in cells, on tall and wide scenes. */
function loopScene(
  cols: number,
  rows: number,
  focus: number,
  hollow = false,
  maxUnit = 280,
): Scene {
  const out = new Float32Array(cols * rows);
  const rock = backdrop(cols, rows, focus, 0.5);
  const unit = Math.min(rows, cols * 0.8, maxUnit);
  const cx = focus * cols;
  const cy = rows * 0.5;
  const cells: LoopCells = {
    cols,
    rows,
    ring: new Int8Array(cols * rows).fill(-1),
    shade: new Float32Array(cols * rows),
    along: new Float32Array(cols * rows),
    station: new Int8Array(cols * rows).fill(-1),
  };
  const { ring, shade, along, station } = cells;
  const rings: Track[] = [0, 1, 2, 3, 4].map((k) => ({
    a: unit * (0.62 + 0.34 * k),
    b: unit * (0.4 + 0.24 * k),
    th: Math.max(3, Math.round(unit * (0.055 - 0.008 * k))),
    depth: 1 - 0.19 * k,
  }));
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) paintTrackCell(cells, rings, rock, x, y, cx, cy, hollow);
  }
  // The four stations on the main track: stepped blocks at left, top, right and bottom.
  const R0 = rings[0]!;
  if (!hollow) {
    const size = Math.round(R0.th * 2.6);
    paintStation(cells, cx - R0.a, cy, size, 0);
    paintStation(cells, cx, cy - R0.b, size, 1);
    paintStation(cells, cx + R0.a, cy, size, 2);
    paintStation(cells, cx, cy + R0.b, size, 3);
  }
  const stationAt = [0, 0.25, 0.5, 0.75];

  const tone = (i: number, t: number) => {
    const k = ring[i]!;
    if (k === -2 || k === -3) return 0;
    // The missing track's outline: faint, flaring as a pulse passes.
    if (k === -4) return clamp01(0.36 + pulseGlow(along[i]!, t, 0.09, 0.03, 0.6));
    if (k < 0) return rock[i]!;
    // Two pulses on each track, the echoes slower and turning the other way.
    const s = station[i]!;
    const depth = rings[k]!.depth;
    const glow =
      s >= 0
        ? pulseGlow(stationAt[s]!, (k % 2 ? -1 : 1) * t, 0.09 - 0.012 * k, 0.03, 0.5, depth)
        : pulseGlow(along[i]!, (k % 2 ? -1 : 1) * t, 0.09 - 0.012 * k, 0.018, 0.45, depth);
    return clamp01(Math.max(rock[i]!, shade[i]! + glow));
  };
  return {
    frame: (t) => {
      for (let i = 0; i < out.length; i++) out[i] = tone(i, t);
      return out;
    },
  };
}

const scenes = {
  // The signature scene: the agent's loop (run, read, act, verify) around the product visual.
  loop: (cols, rows, focus) => loopScene(cols, rows, focus, false, 340),
  // The 404 page: the loop with its main track missing.
  'loop-hollow': (cols, rows, focus) => loopScene(cols, rows, focus, true),

  // Soft, slowly turning bands of light on black: a quiet backdrop for code and commands.
  flow: (cols, rows) => {
    const out = new Float32Array(cols * rows);
    const aspect = cols / rows;
    const warp = mistTexture(cols, rows, 2 * aspect, 2);
    return {
      frame: (t) => {
        const shift = Math.floor(t * 4) % cols;
        for (let y = 0; y < rows; y++) {
          const v = y / rows;
          const row = y * cols;
          for (let x = 0; x < cols; x++) {
            const u = x / cols;
            const w = warp[row + ((x + shift) % cols)]! * 3.2;
            const band =
              0.5 + 0.5 * Math.sin((u * 1.6 * aspect * 0.35 + v * 1.3) * Math.PI + w + t * 0.15);
            const edges = smooth(0, 0.3, u) * smooth(1, 0.7, u) * 0.4 + 0.6;
            // Capped just above the midtone, so the bands stay the dark accent mix with only a
            // few accent pixels at their crests: quiet enough to sit behind code.
            out[row + x] = smooth(0.35, 1, band) * edges * (1 - Math.abs(u - 0.5) * 0.6) * 0.55;
          }
        }
        return out;
      },
    };
  },
} satisfies Record<string, SceneBuilder>;

export type SceneName = keyof typeof scenes;

/** A canvas on the page, or one handed to the dither worker (dither.worker.ts). */
type Surface = HTMLCanvasElement | OffscreenCanvas;
type Painted = { key: string; scene: Scene; image: ImageData; px: Uint32Array; palette: number[] };
const cache = new WeakMap<Surface, Painted>();

/** Packs the three tones (background, a dark mix of the accent, the accent) as RGBA words. */
function palette(rgb: number[]) {
  const [r, g, b] = rgb as [number, number, number];
  const pack = (cr: number, cg: number, cb: number) =>
    (255 << 24) | (Math.round(cb) << 16) | (Math.round(cg) << 8) | Math.round(cr);
  const mix = (c: number) => 10 + (c - 10) * 0.3;
  return [pack(10, 10, 10), pack(mix(r), mix(g), mix(b)), pack(r, g, b)];
}

/**
 * Draws frame t of a scene onto a canvas sized one pixel per cell; CSS scales it up with
 * `image-rendering: pixelated`. The scene and the pixel buffer are kept per canvas and rebuilt
 * only when its size changes. Tones are ordered-dithered between neighbouring colours.
 */
export function drawDither(
  canvas: Surface,
  name: string,
  t: number,
  rgb: number[],
  cols: number,
  rows: number,
  focus: number,
) {
  // Only the scene table's own keys: a name like `constructor` must not reach Object.prototype.
  const build: SceneBuilder | undefined = Object.hasOwn(scenes, name)
    ? scenes[name as SceneName]
    : undefined;
  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!build || !ctx || cols < 2 || rows < 2) return;
  const key = `${name}:${cols}x${rows}:${focus}`;
  let entry = cache.get(canvas);
  if (!entry || entry.key !== key) {
    canvas.width = cols;
    canvas.height = rows;
    const image = ctx.createImageData(cols, rows);
    entry = {
      key,
      scene: build(cols, rows, focus),
      image,
      px: new Uint32Array(image.data.buffer),
      palette: palette(rgb),
    };
    cache.set(canvas, entry);
  }
  const tones = entry.scene.frame(t);
  const { px, palette: colours } = entry;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const scaled = tones[i]! * 2;
      const low = Math.min(1, Math.floor(scaled));
      const step = scaled - low > BAYER[(y & 3) * 4 + (x & 3)]! ? 1 : 0;
      px[i] = colours[low + step]!;
    }
  }
  ctx.putImageData(entry.image, 0, 0);
}

const FRAME_MS = 1000 / 12; // a deliberately low frame rate keeps the pixels reading as pixels

export type DitherOptions = {
  scene: string;
  focus: number;
  cell: number;
  rgb: number[];
  still: boolean;
};

/**
 * Animates a scene on a canvas at 12 frames a second while it is visible, or draws one still
 * frame under reduced motion. Runs the same in the dither worker and, as a fallback, on the
 * page; the caller reports the canvas's CSS size and whether it is on screen.
 */
export function animate(canvas: Surface, o: DitherOptions) {
  const start = performance.now() - Math.random() * 20000;
  let width = 0;
  let height = 0;
  let visible = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const draw = () => {
    const cols = Math.ceil(width / o.cell);
    const rows = Math.ceil(height / o.cell);
    // The still frame is taken nine seconds in.
    const t = o.still ? 9 : (performance.now() - start) / 1000;
    drawDither(canvas, o.scene, t, o.rgb, cols, rows, o.focus);
  };
  const loop = () => {
    timer = undefined;
    if (!visible || !width) return;
    draw();
    if (!o.still) timer = setTimeout(loop, FRAME_MS);
  };

  return {
    setSize(w: number, h: number) {
      width = w;
      height = h;
      if (visible && !timer) loop();
    },
    setVisible(on: boolean) {
      visible = on;
      if (on && !timer) loop();
      if (!on && timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
