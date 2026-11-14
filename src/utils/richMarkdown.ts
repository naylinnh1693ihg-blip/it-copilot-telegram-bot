/**
 * Helpers for Telegram rich messages (sendRichMessage with `markdown`).
 *
 * Rich Markdown is GitHub Flavored Markdown that also accepts HTML, including tags such as
 * <tg-button> (URL, callback and login buttons), <details> and <tg-map>, plus $formulas$,
 * ==marks==, ||spoilers|| and [^footnotes]. Any untrusted text (notes, document text, model
 * output) must therefore go through these helpers so it can't add links, buttons or formatting.
 */

/** Telegram's limits for one rich message. */
export const RICH_MAX_CHARS = 32_768;
export const RICH_MAX_TABLE_COLUMNS = 20;

// Every ASCII punctuation character. GFM defines a backslash escape for each one, which
// covers emphasis, links, images, code, headings, lists, tables, HTML tags (<), entities
// (&), formulas ($), marks (=), spoilers (|) and footnotes ([^).
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g;
/** Control characters other than tab and newline never belong in a message. */
function withoutControlCharacters(text: string): string {
  let result = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    if ((code < 0x20 && char !== "\n" && char !== "\t") || code === 0x7f) continue;
    result += char;
  }
  return result;
}

/** Escapes untrusted text so rich Markdown shows it literally. Line breaks are kept as they are. */
export function escapeRichMarkdown(text: string): string {
  return withoutControlCharacters(text).replace(ASCII_PUNCTUATION, "\\$&");
}

/** For one line: list items, headings, table cells. Line breaks become spaces. */
export function escapeRichInline(text: string): string {
  return escapeRichMarkdown(text.replace(/\s*\n\s*/g, " ").trim());
}

/**
 * For multi-line text. Each non-empty line becomes its own paragraph: in Markdown a single
 * newline is only a soft break, so lines would otherwise run together. Leading spaces are
 * dropped so four of them can't start a code block.
 */
export function escapeRichBlock(text: string): string {
  return text
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => escapeRichMarkdown(line))
    .join("\n\n");
}

export interface RichTable {
  markdown: string;
  /** Columns that had a value but were left out to stay within Telegram's column limit. */
  droppedColumns: number;
}

/**
 * A rich Markdown table. Columns that are empty in every row are dropped, then at most
 * `maxColumns` (Telegram allows 20) are kept, in header order. Null when nothing is left.
 */
export function richTable(headers: string[], rows: string[][], maxColumns = RICH_MAX_TABLE_COLUMNS): RichTable | null {
  const filled = headers
    .map((_header, index) => index)
    .filter((index) => rows.some((row) => (row[index] ?? "").trim() !== ""));
  if (filled.length === 0 || rows.length === 0) return null;
  const kept = filled.slice(0, Math.max(1, Math.min(maxColumns, RICH_MAX_TABLE_COLUMNS)));
  const cell = (value: string | undefined): string => escapeRichInline(value ?? "") || " ";
  const line = (cells: string[]): string => `| ${cells.join(" | ")} |`;
  const markdown = [
    line(kept.map((index) => cell(headers[index]))),
    line(kept.map(() => "---")),
    ...rows.map((row) => line(kept.map((index) => cell(row[index])))),
  ].join("\n");
  return { markdown, droppedColumns: filled.length - kept.length };
}
