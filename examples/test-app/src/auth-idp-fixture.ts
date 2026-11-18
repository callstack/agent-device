// The fixture identity provider for the sign-in sheet, and the single source of truth for the page
// the sheet shows. The content holds fixture values only: no credentials, no tokens, no client id.
// Submitting the form navigates to the app's own callback scheme, which is what ends the
// ASWebAuthenticationSession sheet and returns the app to the foreground.
//
// `scripts/serve-auth-idp.mjs` serves this page over loopback for a lane; the Maestro flow asserts
// against the same vocabulary. `delayMs` defers the real form, so a lane can observe the sheet while
// its page is still loading — the state #4593 reports from.

export const AUTH_IDP_DEFAULT_PORT = 4593;

export const AUTH_IDP_PATH = '/auth-idp';

export const AUTH_IDP_DEFAULT_URL = `http://127.0.0.1:${AUTH_IDP_DEFAULT_PORT}${AUTH_IDP_PATH}`;

// The callback the fixture sheet ends on. `agent-device-test-app` is the scheme app.config.js
// registers and the one the session is opened with, so ASWebAuthenticationSession intercepts this
// navigation itself, ends the sheet, and hands the URL to the app. No route needs to serve it.
export const AUTH_IDP_FIXTURE_REDIRECT =
  'agent-device-test-app://auth-callback?code=fixture-code&state=fixture-state';
// The words a lane asserts on. Keep the Maestro flow and this page changed together.
export const AUTH_IDP_TEXT = {
  loading: 'Loading sign-in',
  title: 'Fixture sign-in',
  email: 'Email',
  password: 'Password',
  submit: 'LOGIN',
} as const;

// The form submits natively to the callback scheme. ASWebAuthenticationSession intercepts a
// navigation to that scheme when the submit originates it, and ignores the same navigation when page
// script asks for it with `location.assign`, so a script-driven submit leaves the sheet open. Verified
// on iOS 27.0.
export function renderAuthIdpPage(options: { delayMs?: number } = {}): string {
  const delayMs = options.delayMs ?? 0;
  if (delayMs > 0) {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${AUTH_IDP_TEXT.loading}</title>
    <script>
      setTimeout(function () {
        location.replace(${JSON.stringify(AUTH_IDP_PATH)});
      }, ${delayMs});
    </script>
  </head>
  <body>
    <p>${AUTH_IDP_TEXT.loading}</p>
  </body>
</html>
`;
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${AUTH_IDP_TEXT.title}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 24px; }
      form { display: grid; gap: 16px; }
      label { display: grid; gap: 6px; }
      input, button { font: inherit; min-height: 44px; }
    </style>
  </head>
  <body>
    <h1>${AUTH_IDP_TEXT.title}</h1>
    <form method="get" action="${AUTH_IDP_FIXTURE_REDIRECT}">
      <label>
        ${AUTH_IDP_TEXT.email}
        <input name="email" type="email" autocomplete="off" />
      </label>
      <label>
        ${AUTH_IDP_TEXT.password}
        <input name="password" type="password" autocomplete="off" />
      </label>
      <button type="submit">${AUTH_IDP_TEXT.submit}</button>
    </form>
  </body>
</html>
`;
}
