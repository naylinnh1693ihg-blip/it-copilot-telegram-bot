const TABLE_HEADERS = new Set([
  "printer",
  "location",
  "ip",
  "ipaddress",
  "scannerip",
  "terminalid",
  "slaveterminalid",
  "enforcedmodel",
  "assetnumber",
  "contact",
  "purchasedate",
  "model",
  "serial",
  "serialnumber",
  "mac",
  "macaddress",
  "bwprint",
  "colorprint",
  "hostname",
  "name",
  "pc",
  "pcname",
  "computer",
  "extension",
  "ext",
  "user",
  "username",
]);

const GENERIC_QUERY = new Set([
  "about",
  "did",
  "employee",
  "have",
  "info",
  "information",
  "informations",
  "list",
  "my",
  "name",
  "note",
  "notes",
  "old",
  "printer",
  "printers",
  "position",
  "saved",
  "show",
  "the",
  "what",
  "for",
  "who",
  "where",
  "which",
  "extension",
  "extensions",
  "ext",
  "user",
  "pc",
]);

interface ParsedTable {
  headers: string[];
  rows: string[][];
}

/** One labeled printer per passage, grouped until the chunk budget is full. */
export function chunkInventory(text: string, maxChars: number): string[] | null {
  const table = parseSemicolonTable(text);
  if (!table || table.rows.length === 0) return null;
  const chunks: string[] = [];
  let current = "";
  for (const row of table.rows) {
    const block = formatTableRow(table.headers, row);
    if (!block) continue;
    const next = current ? `${current}\n\n${block}` : block;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    current = block.length <= maxChars ? block : `${block.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : null;
}

/** A semicolon inventory is one row, or a name list. Never the raw table. */
export function focusTabularRecord(content: string, question: string): string | null {
  const table = parseSemicolonTable(content);
  if (!table) return null;
  const tokens = queryTokens(question);
  const matched = table.rows.filter((row) => rowMatches(row.join(" "), tokens));
  if (tokens.length === 0 || matched.length === 0) {
    const names = table.rows.map((row) => row[0]?.trim() ?? "").filter(Boolean);
    if (names.length === 0) return null;
    const shown = names.slice(0, 12).map((name) => `• ${name}`);
    const more = names.length > shown.length ? "\n• …" : "";
    const kind = recordKind(table.headers[0] ?? "");
    return `${kind} in this note:\n${shown.join("\n")}${more}`;
  }
  const cards = matched
    .slice(0, 3)
    .map((row) => formatTableRow(table.headers, row))
    .filter(Boolean);
  return cards.length > 0 ? cards.join("\n\n") : null;
}

const HOST = String.raw`HADX[A-Za-z0-9-]{4,}`;
const EXTENSION = String.raw`\d{3,5}(?:[/\\]\d+)?`;

/** A PC directory saved as spaces, or "Name - 6722", is one matching row. */
export function focusDirectoryRecord(content: string, question: string): string | null {
  const tokens = queryTokens(question);
  if (tokens.length === 0) return null;
  const flat = content.replace(/;/g, " ").replace(/\s+/g, " ").trim();
  const hits: string[] = [];

  const rowPattern = new RegExp(`\\b(${HOST})\\s+(${EXTENSION})\\s+(.{1,80}?)(?=\\s+${HOST}\\b|$)`, "gi");
  for (const match of flat.matchAll(rowPattern)) {
    const pc = match[1]?.trim() ?? "";
    const extension = match[2]?.trim() ?? "";
    const user = match[3]?.trim() ?? "";
    const blob = `${pc} ${extension} ${user}`;
    if (!pc || !extension || !user || !rowMatches(blob, tokens)) continue;
    hits.push(`PC name: ${pc}\nExtension: ${extension}\nUser: ${user}`);
  }

  for (const token of tokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const dash = new RegExp(`(?:^|\\s)(${escaped})\\s*[-–—]\\s*(${EXTENSION})\\b`, "gi");
    for (const match of flat.matchAll(dash)) {
      const name = match[1]?.trim() ?? "";
      const extension = match[2]?.trim() ?? "";
      if (name && extension) hits.push(`${name} — ${extension}`);
    }
  }

  const unique = [...new Set(hits)];
  return unique.length > 0 ? unique.slice(0, 3).join("\n\n") : null;
}

function parseSemicolonTable(content: string): ParsedTable | null {
  const lines = content
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => (index === 0 ? peelHeaderPrefix(line) : line));
  if (!lines.some((line) => (line.match(/;/g) ?? []).length >= 2)) return null;

  const first = splitCells(lines[0] ?? "");
  const headers = takeHeaders(first);
  if (headers.length < 3) return null;
  const rows = [
    ...chunkRows(first.slice(headers.length), headers.length),
    ...lines.slice(1).flatMap((line) => {
      const cells = splitCells(line);
      return cells.length > headers.length ? chunkRows(cells, headers.length) : [cells];
    }),
  ];
  return { headers, rows: rows.filter((row) => row.some((cell) => cell.trim()) && !isHeaderRow(headers, row)) };
}

function peelHeaderPrefix(line: string): string {
  const cells = line.split(";");
  const first = cells[0]?.trim() ?? "";
  const labeled = first.match(/^[^:]{1,80}:\s*(.+)$/);
  if (labeled?.[1] && labeled[1].trim().length <= 40) cells[0] = labeled[1].trim();
  return cells.join(";");
}

function splitCells(line: string): string[] {
  const cells: string[] = [];
  for (const raw of line.split(";")) {
    const cell = raw.trim();
    if (!cell) {
      cells.push("");
      continue;
    }
    cells.push(...expandCell(cell));
  }
  return cells;
}

function expandCell(cell: string): string[] {
  const glued = cell.match(new RegExp(`^([A-Za-z][A-Za-z #]{0,30}?)\\s+(${HOST}\\b.*)$`, "i"));
  if (glued?.[1] && glued[2] && TABLE_HEADERS.has(headerKey(glued[1]))) {
    return [glued[1].trim(), ...splitCells(glued[2])];
  }
  const parts = cell.split(new RegExp(`\\s+(?=${HOST}\\b)`, "i")).map((part) => part.trim());
  return parts.length > 1 ? parts.filter(Boolean) : [cell];
}

function takeHeaders(cells: string[]): string[] {
  const headers: string[] = [];
  for (const cell of cells) {
    if (!TABLE_HEADERS.has(headerKey(cell))) break;
    headers.push(cell);
  }
  return headers;
}

function chunkRows(cells: string[], width: number): string[][] {
  const rows: string[][] = [];
  for (let index = 0; index < cells.length; index += width) {
    const row = cells.slice(index, index + width);
    if (row.some((cell) => cell.trim())) rows.push(row);
  }
  return rows;
}

function formatTableRow(headers: string[], row: string[]): string {
  return headers
    .map((header, index) => {
      const value = row[index]?.trim() ?? "";
      if (!value) return "";
      return `${header}: ${value}`;
    })
    .filter(Boolean)
    .join("\n");
}

function rowMatches(text: string, tokens: string[]): boolean {
  return tokens.every((token) => {
    if (/^\d/.test(token) || token.includes(".")) return text.toLowerCase().includes(token);
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(text);
  });
}

function queryTokens(question: string): string[] {
  const ips = question.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? [];
  const words = (question.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length > 2 && !GENERIC_QUERY.has(word));
  return [...new Set([...ips.map((ip) => ip.toLowerCase()), ...words])];
}

function headerKey(cell: string): string {
  return cell.toLowerCase().replace(/&/g, "").replace(/[^a-z0-9]/g, "");
}

function recordKind(header: string): string {
  const key = headerKey(header);
  if (key.includes("print")) return "Printers";
  if (key.includes("pc") || key === "hostname" || key === "computer") return "PCs";
  return "Records";
}

function isHeaderRow(headers: string[], row: string[]): boolean {
  return headers.every((header, index) => headerKey(row[index] ?? "") === headerKey(header));
}
