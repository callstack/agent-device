// Type surface for the plain-Node Swift comment stripper (it must stay runnable by bare `node`).
// Keep it in step with the exports of `./strip-swift-comments.mjs`.
export function stripSwiftComments(
  source: string,
  filePath?: string,
): { contents: string; removedComments: number };
