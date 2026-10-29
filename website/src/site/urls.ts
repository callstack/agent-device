// Pages are built as files (`build.format: 'file'`) and served without `.html` (`cleanUrls` in
// vercel.json). Links the build writes as files go through here, so they point at the URL that
// is served instead of a redirect. No imports: the browser search uses it too.

/** `/docs/x.html#y` → `/docs/x#y`; any other href is returned unchanged. */
export const cleanHref = (href: string) => href.replace(/\.html(?=#|$)/, '');
