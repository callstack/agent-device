// Seeded, deterministic PRNG for the concurrency torture lane (#1416).
//
// A seed alone cannot reproduce Node's Promise/event-loop interleavings, so the
// torture harness never reads `Math.random` or the wall clock: every random
// choice (client count, op programs, and — critically — which fiber the
// scheduler steps next) is drawn from this generator. Replaying a run is then
// exactly "construct the same seed and draw in the same order", which the
// scheduler guarantees by being the sole source of concurrency ordering.
//
// splitmix32: a small, well-distributed 32-bit generator. Chosen over a LCG so
// low-entropy seeds (0, 1, 2, …) still produce well-mixed streams — the lane
// enumerates seeds `0..runs`, so seed 0 must not degenerate.

export type Prng = {
  /** Next uint32 in the stream. */
  uint32(): number;
  /** Uniform integer in `[0, bound)`. `bound` must be a positive integer. */
  int(bound: number): number;
  /** Uniform element of `items`. Throws on an empty array. */
  pick<T>(items: readonly T[]): T;
  /** True with probability `p` (default 0.5). */
  bool(p?: number): boolean;
  /** In-place Fisher–Yates shuffle, returning the same array. */
  shuffle<T>(items: T[]): T[];
};

export function makePrng(seed: number): Prng {
  let state = seed >>> 0;

  const uint32 = (): number => {
    state = (state + 0x9e3779b9) | 0;
    let t = state ^ (state >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    return t >>> 0;
  };

  const int = (bound: number): number => {
    if (!Number.isInteger(bound) || bound <= 0) {
      throw new Error(`prng.int bound must be a positive integer, got ${String(bound)}`);
    }
    // Rejection sampling keeps the distribution uniform even when `bound` does
    // not divide 2^32; the stream stays deterministic because rejected draws
    // still advance the generator identically on replay.
    const limit = Math.floor(0x1_0000_0000 / bound) * bound;
    let value = uint32();
    while (value >= limit) value = uint32();
    return value % bound;
  };

  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error('prng.pick requires a non-empty array');
    return items[int(items.length)] as T;
  };

  const bool = (p = 0.5): boolean => uint32() / 0x1_0000_0000 < p;

  const shuffle = <T>(items: T[]): T[] => {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = int(i + 1);
      const tmp = items[i] as T;
      items[i] = items[j] as T;
      items[j] = tmp;
    }
    return items;
  };

  return { uint32, int, pick, bool, shuffle };
}
