// Type surface for the plain-Node publish asset preparer (it must stay runnable by bare `node`).
// Keep it in step with the exports of `./prepare-publish-assets.mjs`.
export function preparePublishAssets(options?: Readonly<{ root?: string }>): {
  root: string;
  version: string;
};
