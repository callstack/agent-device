export const AUTH_IDP_DEFAULT_PORT = 4593;

export const AUTH_IDP_PATH = '/auth-idp';

export const AUTH_IDP_DEFAULT_URL = `http://127.0.0.1:${AUTH_IDP_DEFAULT_PORT}${AUTH_IDP_PATH}`;

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

// On iOS 27.0 the sheet intercepts native form submission to the callback scheme.
// Redirecting from page script with `location.assign` leaves the sheet open.
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
