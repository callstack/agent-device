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
// ADDING THE PRODUCT'S SIGNATURE SCENE
//
// Every product gets one scene of its own: a metaphor taken from the product itself (its name,
// what it does, the vocabulary of its docs), drawn in the stepped, dithered language of the
// family. It goes behind the hero visual, on the social card and the banner. `mark` (below) is
// only a fallback: a druse of the product's pixel mark. Appduct's `ducts` shows the method (six
// shaded tubes bundle into the point where the app sits, `focus`, with pulses sliding toward it:
// "calls flow through the duct into your app"), but its idea, like Rozenite's crystals, belongs
// to that product. Never reuse a sibling's idea.
//
// To add one:
//   1. Write a SceneBuilder: `(cols, rows, focus, mark) => ({ frame: (t) => tones })`.
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
type SceneBuilder = (cols: number, rows: number, focus: number, mark: readonly string[]) => Scene;

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

/** The shape the `mark` scene grows when the product has no mark: a plain stepped pillar. */
export const PILLAR = ['..#..', '.###.', '#####', '#####', '#####', '#####', '#####', '.###.'];

type Stone = {
  cx: number;
  base: number;
  step: number;
  depth: number;
  speed: number;
  phase: number;
  /** The missing one (404 page): only a dashed outline of its socket is drawn. */
  hollow?: boolean;
};

// Mark: a druse of the product's mark (generalised from Rozenite's crystals). Stepped stones
// with the mark's silhouette rise from the bottom edge and cluster around `focus` (0..1
// across), shaded as faceted stones on dark rock, with a glint sweeping across them and pulses
// climbing from base to tip. It reads as the logo, multiplied, rising into view.
function markScene(
  cols: number,
  rows: number,
  focus: number,
  bitmap: readonly string[],
  hollow = false,
): Scene {
  const shape = bitmap.length ? bitmap : PILLAR;
  const H = shape.length;
  const W = Math.max(...shape.map((r) => r.length));
  const filled = (c: number, r: number) => r >= 0 && r < H && shape[r]![c] === '#';
  // How far each row reaches from the centre line, in steps, for the outer-edge shading.
  const reach = shape.map((row) => {
    let m = 0;
    for (let c = 0; c < row.length; c++)
      if (row[c] === '#') m = Math.max(m, Math.abs(c + 0.5 - W / 2) + 0.5);
    return Math.max(m, 0.5);
  });

  const out = new Float32Array(cols * rows);
  const aspect = cols / rows;
  const owner = new Int16Array(cols * rows).fill(-1);
  const shade = new Float32Array(cols * rows);
  const height = new Float32Array(cols * rows); // 0 at the tip, 1 at the base
  const rock = new Float32Array(cols * rows);
  const diag = new Float32Array(cols * rows);

  // Dark rock: low noise in the bottom tones, a faint glow around the focus.
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const d = Math.hypot((x / cols - focus) * aspect, (y / rows - 0.62) * 1.2);
      const grain = fbm((x / cols) * 9 * aspect * 0.5, (y / rows) * 9, 4);
      rock[i] = 0.12 * smooth(0.52, 0.85, grain) + 0.12 * Math.exp(-d * d * 4.5);
      diag[i] = (x / cols) * aspect * 0.55 + y / rows;
    }
  }

  // Place the stones: a cluster around the focus, a bed along the bottom edge, and a few small
  // loose ones in the upper field. Sizes follow the shorter side, so a tall phone-width scene
  // doesn't get huge steps, and are capped (280 cells tall at most), so the steps keep reading
  // as pixels instead of a city skyline.
  const size = Math.min(rows, cols * 0.8);
  const unit = Math.min(size, 280) / H;
  const stones: Stone[] = [];
  const add = (u: number, baseFromBottom: number, h: number, depth: number, seed: number) =>
    stones.push({
      cx: Math.round(u * cols),
      base: Math.round(rows + baseFromBottom * size),
      step: Math.max(1, Math.round(h * unit)),
      depth,
      speed: 0.12 + 0.1 * hash(seed, 3),
      phase: hash(seed, 9) * 3,
    });
  // The bed: small and dim, everywhere along the bottom.
  const bed = Math.max(8, Math.round(aspect * 7));
  for (let k = 0; k < bed; k++) {
    const u = (k + 0.2 + 0.6 * hash(k, 1)) / bed;
    const near = Math.exp(-(((u - focus) / 0.28) ** 2));
    const h = 0.1 + 0.12 * hash(k, 2) + 0.12 * near;
    add(u, 0.04 + 0.06 * hash(k, 5), h, 0.42 + 0.3 * near, k + 10);
  }
  // Loose stones in the rock, small and faint.
  for (let k = 0; k < Math.round(aspect * 3); k++) {
    const u = hash(k, 21);
    if (Math.abs(u - focus) < 0.12) continue;
    add(u, -0.35 - 0.5 * hash(k, 22), 0.025 + 0.03 * hash(k, 23), 0.38, k + 40);
  }
  // The cluster: thirteen medium stones, tallest at the focus, falling off to either side.
  const n = 13;
  for (let k = 0; k < n; k++) {
    const o = (k / (n - 1) - 0.5) * 2 + (hash(k, 61) - 0.5) * 0.12; // -1..1 across the cluster
    const h = 0.5 * (1 - 0.6 * Math.abs(o) ** 1.2) * (0.78 + 0.3 * hash(k, 62));
    add(
      focus + (o * 0.8 * size) / cols,
      0.03 + 0.12 * hash(k, 63),
      h,
      0.62 + 0.38 * (1 - Math.abs(o)),
      k + 70,
    );
    // On the 404 page the middle, tallest stone is the one that is missing.
    if (hollow && k === (n - 1) / 2) {
      // Taller than the rest and uncapped: an outline does not turn into a skyline.
      const c = stones.at(-1)!;
      c.hollow = true;
      c.step = Math.max(2, Math.round((0.82 * size) / H));
      c.base = Math.round(rows + 0.04 * size);
    }
  }

  // Rasterise back to front: smaller (further) stones first, so the cluster sits in front.
  stones.sort((a, b) => a.depth - b.depth);
  stones.forEach((c, k) => {
    const s = c.step;
    const left = c.cx - Math.floor((W * s) / 2);
    const top = c.base - H * s;
    const mid = left + (W * s) / 2; // the centre line, where the facets meet
    const rim = Math.max(1, Math.round(s * 0.2));
    // A dark gap around the silhouette, so a stone in front reads against the ones behind.
    const gap = Math.max(1, Math.round(s * 0.18));
    for (let r = 0; r < H; r++) {
      for (let col = 0; col < W; col++) {
        if (!filled(col, r)) continue;
        for (let y = top + r * s - gap; y < top + (r + 1) * s + gap; y++) {
          if (y < 0 || y >= rows) continue;
          for (let x = left + col * s - gap; x < left + (col + 1) * s + gap; x++) {
            if (x < 0 || x >= cols) continue;
            const i = y * cols + x;
            if (owner[i]! >= 0) {
              owner[i] = -1;
              rock[i] = 0;
            }
          }
        }
      }
    }
    const inside = (x: number, y: number) =>
      x >= left && y >= top && filled(Math.floor((x - left) / s), Math.floor((y - top) / s));
    if (c.hollow) {
      // The empty socket: dark inside, a dashed line along the stepped outline.
      const w = Math.max(1, Math.round(s * 0.08));
      for (let y = Math.max(0, top); y < Math.min(rows, c.base); y++) {
        for (let x = Math.max(0, left); x < Math.min(cols, left + W * s); x++) {
          if (!inside(x, y)) continue;
          const i = y * cols + x;
          const edge =
            !inside(x - w, y) || !inside(x + w, y) || !inside(x, y - w) || !inside(x, y + w);
          owner[i] = edge && (x + y) % 8 < 4 ? -2 : -3;
          rock[i] = 0;
        }
      }
      return;
    }
    for (let y = Math.max(0, top); y < Math.min(rows, c.base); y++) {
      const r = Math.floor((y - top) / s);
      const v = (y - top) / (H * s);
      for (let x = Math.max(0, left); x < Math.min(cols, left + W * s); x++) {
        const col = Math.floor((x - left) / s);
        if (!filled(col, r)) continue;
        const i = y * cols + x;
        const u = (x - mid + 0.5) / (reach[r]! * s); // -1..1 across this row
        // Faceted: the left half lit, the right half darker, a facet line down the middle.
        let tone = u < 0 ? 0.86 : 0.58;
        if (Math.abs(x - mid + 0.5) < Math.max(0.6, s * 0.12)) tone = 0.5;
        // A bright rim on every step's top edge that is exposed (nothing filled above it).
        if (!filled(col, r - 1) && y - (top + r * s) < rim) tone = 1;
        // Darker toward the base, and toward the outer edge of the right facet.
        tone *= 1 - 0.42 * v;
        if (u > 0.6) tone *= 0.85;
        owner[i] = k;
        shade[i] = tone * c.depth;
        height[i] = v;
      }
    }
  });

  return {
    frame: (t) => {
      const sweep = ((t * 0.09) % 1.9) - 0.3; // the glint's position along the diagonal
      for (let i = 0; i < out.length; i++) {
        const k = owner[i]!;
        if (k === -2) {
          // The missing stone's outline: faint, flaring as the glint crosses it.
          const g = (diag[i]! - sweep * (1 + aspect * 0.55)) / 0.08;
          out[i] = clamp01(0.36 + Math.exp(-g * g) * 0.7);
          continue;
        }
        if (k < 0) {
          out[i] = rock[i]!;
          continue;
        }
        const c = stones[k]!;
        // A glint band sweeping diagonally across the facets.
        const g = (diag[i]! - sweep * (1 + aspect * 0.55)) / 0.06;
        const glint = Math.exp(-g * g) * 0.4 * c.depth;
        // A pulse climbing from base to tip, each stone at its own speed.
        const p = (t * c.speed + c.phase) % 1.6;
        const dv = (height[i]! - (1 - p)) / 0.05;
        const pulse = p < 1 ? Math.exp(-dv * dv) * 0.3 * c.depth : 0;
        out[i] = clamp01(Math.max(rock[i]!, shade[i]! + glint + pulse));
      }
      return out;
    },
  };
}

/** Dark rock with a faint glow around the focus: the texture behind every agent-device scene. */
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

// Loop: the agent closing its own loop on a running app. A stepped track circles the focus,
// with four stations on it (run, read, act, verify), and fainter echoes of the track around
// it. Pulses travel round the track and each station lights as a pulse reaches it. On the 404
// page (`hollow`) the main track and its stations are missing: a dashed outline marks where the
// track should be, and flares as the pulses pass along it.
function loopScene(cols: number, rows: number, focus: number, hollow = false): Scene {
  const out = new Float32Array(cols * rows);
  const rock = backdrop(cols, rows, focus, 0.5);
  const unit = Math.min(rows, cols * 0.8, 280);
  const cx = focus * cols;
  const cy = rows * 0.5;
  const ring = new Int8Array(cols * rows).fill(-1);
  const shade = new Float32Array(cols * rows);
  const along = new Float32Array(cols * rows); // 0..1 round the track, clockwise from the left
  const station = new Int8Array(cols * rows).fill(-1);
  const rings = [0, 1, 2, 3, 4].map((k) => ({
    a: unit * (0.62 + 0.34 * k),
    b: unit * (0.4 + 0.24 * k),
    th: Math.max(3, Math.round(unit * (0.055 - 0.008 * k))),
    depth: 1 - 0.19 * k,
  }));
  const q = Math.max(2, Math.round(rings[0]!.th / 2)); // the step every corner is cut on

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      // Quantise to the step grid, so the corners come out stepped.
      const dx = Math.round((x - cx) / q) * q;
      const dy = Math.round((y - cy) / q) * q;
      const fade = smooth(0, 0.12, x / cols) * smooth(1, 0.88, x / cols);
      for (let k = 0; k < rings.length; k++) {
        const R = rings[k]!;
        const r = R.b * 0.45;
        const qx = Math.abs(dx) - (R.a - r);
        const qy = Math.abs(dy) - (R.b - r);
        const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
        if (Math.abs(d) > R.th / 2) continue;
        along[i] = (Math.atan2(y - cy, x - cx) + Math.PI) / (2 * Math.PI);
        if (hollow && k === 0) {
          const edge = Math.abs(d) > R.th / 2 - 1.2;
          ring[i] = edge && (x + y) % 8 < 4 ? -4 : -3;
          rock[i] = 0;
          break;
        }
        ring[i] = k;
        // Lit from the top left: the upper and left runs bright, the lower and right shaded.
        let tone = dy < 0 || (dx < 0 && dy <= R.b * 0.5) ? 0.84 : 0.54;
        if (d > R.th / 2 - 1.5 && dy < 0) tone = 1; // the outer rim on the upper run
        if (d < -R.th / 2 + 1.5) tone *= 0.75; // the inner edge, in shadow
        shade[i] = tone * R.depth * fade;
        break;
      }
    }
  }
  // The four stations on the main track: stepped blocks at left, top, right and bottom.
  const R0 = rings[0]!;
  const st = Math.round(R0.th * 2.6);
  const spots: [number, number][] = [
    [cx - R0.a, cy],
    [cx, cy - R0.b],
    [cx + R0.a, cy],
    [cx, cy + R0.b],
  ];
  if (!hollow)
    spots.forEach(([sx, sy], k) => {
      for (let y = Math.round(sy - st / 2) - 1; y < Math.round(sy + st / 2) + 1; y++) {
        for (let x = Math.round(sx - st / 2) - 1; x < Math.round(sx + st / 2) + 1; x++) {
          if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
          const i = y * cols + x;
          const edge =
            y < Math.round(sy - st / 2) ||
            y >= Math.round(sy + st / 2) ||
            x < Math.round(sx - st / 2) ||
            x >= Math.round(sx + st / 2);
          if (edge) {
            shade[i] = 0; // a dark gap around the block
            ring[i] = -2;
            continue;
          }
          station[i] = k;
          ring[i] = 0;
          const top = y - Math.round(sy - st / 2) < 2;
          shade[i] = top ? 1 : x < sx ? 0.8 : 0.56;
        }
      }
    });
  const stationAt = [0, 0.25, 0.5, 0.75];

  return {
    frame: (t) => {
      for (let i = 0; i < out.length; i++) {
        const k = ring[i]!;
        if (k === -2 || k === -3) {
          out[i] = 0;
          continue;
        }
        if (k === -4) {
          // The missing track's outline: faint, flaring as a pulse passes.
          let flare = 0;
          for (let p = 0; p < 2; p++) {
            const pos = (((t * 0.09 + p / 2) % 1) + 1) % 1;
            let dd = Math.abs(along[i]! - pos);
            dd = Math.min(dd, 1 - dd);
            flare += Math.exp(-((dd / 0.03) ** 2)) * 0.6;
          }
          out[i] = clamp01(0.36 + flare);
          continue;
        }
        if (k < 0) {
          out[i] = rock[i]!;
          continue;
        }
        const R = rings[k]!;
        const dir = k % 2 ? -1 : 1;
        let glow = 0;
        // Two pulses on each track, the echoes slower and turning the other way.
        for (let p = 0; p < 2; p++) {
          const pos = (((dir * t * (0.09 - 0.012 * k) + p / 2) % 1) + 1) % 1;
          const s = station[i]!;
          let dd = Math.abs((s >= 0 ? stationAt[s]! : along[i]!) - pos);
          dd = Math.min(dd, 1 - dd);
          glow +=
            Math.exp(-((dd / (s >= 0 ? 0.03 : 0.018)) ** 2)) * (s >= 0 ? 0.5 : 0.45) * R.depth;
        }
        out[i] = clamp01(Math.max(rock[i]!, shade[i]! + glow));
      }
      return out;
    },
  };
}

const scenes = {
  // The signature scene: the agent's loop (run, read, act, verify) around the product visual.
  loop: (cols, rows, focus) => loopScene(cols, rows, focus),
  // The 404 page: the loop with its main track missing.
  'loop-hollow': (cols, rows, focus) => loopScene(cols, rows, focus, true),

  // The default signature: the product's mark as a druse of stones around the focus.
  mark: (cols, rows, focus, mark) => markScene(cols, rows, focus, mark),

  // Hollow: the same druse with its tallest stone missing, for the 404 page. A dashed outline
  // marks the empty socket, and the glint flares along it as it passes.
  hollow: (cols, rows, focus, mark) => markScene(cols, rows, focus, mark, true),

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
  mark: readonly string[] = [],
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
      scene: build(cols, rows, focus, mark),
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
  /** The product's mark (content.ts), for the `mark` and `hollow` scenes. */
  mark: string[];
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
    // The still frame is taken nine seconds in, when the glint is on the cluster.
    const t = o.still ? 9 : (performance.now() - start) / 1000;
    drawDither(canvas, o.scene, t, o.rgb, cols, rows, o.focus, o.mark);
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
