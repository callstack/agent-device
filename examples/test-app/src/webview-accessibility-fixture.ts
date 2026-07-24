export const WEBVIEW_ACCESSIBILITY_FIXTURE = `
<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>WebView semantic fixture</title>
    <style>
      body {
        color: #171717;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        line-height: 1.5;
        margin: 0;
        padding: 24px;
      }
      main {
        max-width: 640px;
      }
      form {
        display: grid;
        gap: 16px;
      }
      label {
        display: grid;
        gap: 6px;
      }
      input, select, button {
        font: inherit;
        min-height: 44px;
      }
      img {
        height: 48px;
        width: 48px;
      }
    </style>
  </head>
  <body>
    <header>
      <nav aria-label="Fixture navigation">
        <a href="#form">Jump to form</a>
      </nav>
    </header>
    <main>
      <h1>WebView semantic fixture</h1>
      <p>Ordinary paragraph text should not be categorized as other.</p>
      <h2>Account form</h2>
      <form id="form">
        <label>
          Email address
          <input name="email" type="email" autocomplete="email" />
        </label>
        <label>
          Plan
          <select name="plan">
            <option>Starter</option>
            <option>Pro</option>
          </select>
        </label>
        <label>
          <input name="updates" type="checkbox" />
          Send product updates
        </label>
        <button type="submit">Create account</button>
      </form>
      <h2>Media</h2>
      <img
        alt="Blue accessibility test square"
        src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48'%3E%3Crect width='48' height='48' fill='%230078d4'/%3E%3C/svg%3E"
      />
    </main>
    <footer>Fixture footer text</footer>
  </body>
</html>
`;
