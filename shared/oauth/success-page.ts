interface OAuthSuccessPageOptions {
  provider: string;
  nextHref?: string;
}

export function oauthSuccessPage(options: OAuthSuccessPageOptions): Response {
  const provider = escapeHtml(options.provider);
  const nextHref = options.nextHref ? escapeHtml(options.nextHref) : undefined;
  const nextLink = nextHref
    ? `<a class="button" href="${nextHref}">Continue</a>`
    : `<p class="hint">You can close this tab and return to your MCP client.</p>`;

  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${provider} connected</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
      main { width: min(560px, calc(100vw - 48px)); }
      h1 { margin: 0 0 12px; font-size: 28px; line-height: 1.2; letter-spacing: 0; }
      p { margin: 0 0 20px; line-height: 1.5; color: color-mix(in srgb, CanvasText 72%, Canvas 28%); }
      .button { display: inline-block; padding: 10px 14px; border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas 82%); border-radius: 6px; color: CanvasText; text-decoration: none; font-weight: 600; }
      .hint { margin-top: 8px; }
    </style>
  </head>
  <body>
    <main>
      <h1>${provider} connected</h1>
      <p>Authorization completed successfully.</p>
      ${nextLink}
    </main>
  </body>
</html>`,
    {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
