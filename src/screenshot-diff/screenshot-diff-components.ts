type ConnectedMaskComponentHooks<TComponent> = {
  create(pixelIndex: number): TComponent;
  visit(component: TComponent, pixelIndex: number): void;
};

const NEIGHBOR_OFFSETS = [
  { x: -1, y: -1 },
  { x: 0, y: -1 },
  { x: 1, y: -1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: -1, y: 1 },
  { x: 0, y: 1 },
  { x: 1, y: 1 },
] as const;

export function findConnectedMaskComponents<TComponent>(params: {
  mask: Uint8Array;
  width: number;
  height: number;
  hooks: ConnectedMaskComponentHooks<TComponent>;
}): TComponent[] {
  const { mask, width, height, hooks } = params;
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components: TComponent[] = [];

  for (let pixelIndex = 0; pixelIndex < mask.length; pixelIndex += 1) {
    if (!isUnvisitedMaskPixel(mask, visited, pixelIndex)) continue;

    let queueStart = 0;
    let queueEnd = enqueuePixel(queue, visited, 0, pixelIndex);
    const component = hooks.create(pixelIndex);

    while (queueStart < queueEnd) {
      const currentPixelIndex = queue[queueStart]!;
      queueStart += 1;
      hooks.visit(component, currentPixelIndex);
      queueEnd = enqueueMaskNeighbors({
        mask,
        visited,
        queue,
        queueEnd,
        width,
        height,
        pixelIndex: currentPixelIndex,
      });
    }

    components.push(component);
  }

  return components;
}

function enqueueMaskNeighbors(params: {
  mask: Uint8Array;
  visited: Uint8Array;
  queue: Int32Array;
  queueEnd: number;
  width: number;
  height: number;
  pixelIndex: number;
}): number {
  const { mask, visited, queue, width, height, pixelIndex } = params;
  const x = pixelIndex % width;
  const y = Math.floor(pixelIndex / width);
  let queueEnd = params.queueEnd;

  for (const offset of NEIGHBOR_OFFSETS) {
    const neighborX = x + offset.x;
    const neighborY = y + offset.y;
    if (!isInBounds(neighborX, neighborY, width, height)) continue;
    const neighborIndex = neighborY * width + neighborX;
    if (!isUnvisitedMaskPixel(mask, visited, neighborIndex)) continue;
    queueEnd = enqueuePixel(queue, visited, queueEnd, neighborIndex);
  }

  return queueEnd;
}

function enqueuePixel(
  queue: Int32Array,
  visited: Uint8Array,
  queueEnd: number,
  pixelIndex: number,
): number {
  visited[pixelIndex] = 1;
  queue[queueEnd] = pixelIndex;
  return queueEnd + 1;
}

function isUnvisitedMaskPixel(mask: Uint8Array, visited: Uint8Array, pixelIndex: number): boolean {
  return mask[pixelIndex] === 1 && visited[pixelIndex] !== 1;
}

function isInBounds(x: number, y: number, width: number, height: number): boolean {
  return x >= 0 && x < width && y >= 0 && y < height;
}
