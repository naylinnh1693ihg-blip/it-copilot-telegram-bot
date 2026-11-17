import type { Response } from "express";
import { findForm } from "../forms/index.js";

const PAGES: Record<string, string> = {
  equipment: "equipment",
  contacts: "contact",
  links: "link",
};

export function formIdForAdminPage(page: string): string | null {
  return PAGES[page] ?? null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}

export const MINIAPP_CSP = [
  "default-src 'self'",
  "script-src 'self' https://telegram.org",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

export function renderFormDocument(options: { formId: string; surface: "admin" | "miniapp"; apiBase: string; title: string }): string {
  const formId = escapeHtml(options.formId);
  const apiBase = escapeHtml(options.apiBase);
  const title = escapeHtml(options.title);
  const surface = options.surface;
  const telegram = surface === "miniapp" ? '<script src="https://telegram.org/js/telegram-web-app.js"></script>' : "";
  const nav =
    surface === "admin"
      ? `<header class="top">
      <a class="brand" href="/admin">IT Copilot</a>
      <nav aria-label="Records">
        <a href="/admin/equipment"${options.formId === "equipment" ? ' aria-current="page"' : ""}>Equipment</a>
        <a href="/admin/contacts"${options.formId === "contact" ? ' aria-current="page"' : ""}>Contacts</a>
        <a href="/admin/links"${options.formId === "link" ? ' aria-current="page"' : ""}>Links</a>
      </nav>
    </header>`
      : `<header class="top"><p class="brand">${title}</p></header>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="referrer" content="no-referrer" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${title}</title>
    <link rel="stylesheet" href="/forms/forms.css" />
    ${telegram}
  </head>
  <body class="surface-${surface}">
    ${nav}
    <main id="app"></main>
    <script src="/forms/form.js" data-form="${formId}" data-api="${apiBase}" data-surface="${surface}" defer></script>
  </body>
</html>`;
}

export function sendFormDocument(res: Response, options: { formId: string; surface: "admin" | "miniapp"; apiBase: string }): void {
  const form = findForm(options.formId);
  if (!form) {
    res.status(404).type("text/plain").send("That form does not exist.");
    return;
  }
  if (options.surface === "miniapp") {
    res.setHeader("Content-Security-Policy", MINIAPP_CSP);
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
  }
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(renderFormDocument({ ...options, title: form.title }));
}
