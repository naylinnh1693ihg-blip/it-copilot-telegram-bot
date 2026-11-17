import type { Response } from "express";
import { findForm } from "../forms/index.js";

const PAGES: Record<string, string> = {
  equipment: "equipment",
  "ip-addresses": "ip",
  locations: "location",
  contacts: "contact",
  birthdays: "birthdays",
  books: "book",
  links: "link",
};

const NAV: Array<{ href: string; formId: string; label: string }> = [
  { href: "/admin/equipment", formId: "equipment", label: "Equipment" },
  { href: "/admin/ip-addresses", formId: "ip", label: "IP addresses" },
  { href: "/admin/locations", formId: "location", label: "Locations" },
  { href: "/admin/contacts", formId: "contact", label: "User information" },
  { href: "/admin/birthdays", formId: "birthdays", label: "Birthdays" },
  { href: "/admin/books", formId: "book", label: "Books" },
  { href: "/admin/links", formId: "link", label: "Links" },
];

const HOME: Array<{ href: string; title: string; description: string; icon: string }> = [
  { href: "/miniapp/equipment", title: "Equipment", description: "Devices you look after", icon: "▣" },
  { href: "/miniapp/contact", title: "User information", description: "People you support", icon: "☺" },
  { href: "/miniapp/link", title: "Website link", description: "Guides and vendor pages", icon: "↗" },
  { href: "/miniapp/book", title: "Book", description: "Books on the shelf or on loan", icon: "▤" },
  { href: "/miniapp/location", title: "Location", description: "Sites, floors, and rooms", icon: "⌖" },
  { href: "/miniapp/ip", title: "IP address", description: "Addresses, VLANs, and devices", icon: "#" },
  { href: "/miniapp/birthdays", title: "Birthdays", description: "Who is next, in your timezone", icon: "✸" },
];

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
        ${NAV.map((item) => `<a href="${item.href}"${options.formId === item.formId ? ' aria-current="page"' : ""}>${item.label}</a>`).join("\n        ")}
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
    <script src="/forms/form.js" data-form="${formId}" data-api="${apiBase}" data-surface="${surface}"${formId === "birthdays" ? ' data-view="birthdays"' : ""} defer></script>
  </body>
</html>`;
}

export function renderHomeDocument(): string {
  const items = HOME.map(
    (item) => `<a class="home-link" href="${item.href}"><span class="home-icon" aria-hidden="true">${item.icon}</span><span><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.description)}</span></span></a>`,
  ).join("");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="referrer" content="no-referrer" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Forms</title>
    <link rel="stylesheet" href="/forms/forms.css" />
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
  </head>
  <body class="surface-miniapp">
    <header class="top"><p class="brand">Forms</p></header>
    <main><h1>What do you want to add?</h1><nav class="home-list" aria-label="Forms">${items}</nav></main>
    <script src="/forms/form.js" data-form="" data-api="/api" data-surface="miniapp" data-view="home" defer></script>
  </body>
</html>`;
}

function sendShell(res: Response, options: { formId: string; surface: "admin" | "miniapp"; apiBase: string }, title: string): void {
  if (options.surface === "miniapp") {
    res.setHeader("Content-Security-Policy", MINIAPP_CSP);
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
  }
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(renderFormDocument({ ...options, title }));
}

export function sendFormDocument(res: Response, options: { formId: string; surface: "admin" | "miniapp"; apiBase: string }): void {
  if (options.formId === "birthdays") {
    sendShell(res, options, "Birthdays");
    return;
  }
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
