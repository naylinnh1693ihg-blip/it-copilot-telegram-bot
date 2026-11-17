import { IPV4 } from "../utils/net.js";

const ISBN10 = /^\d{9}[\dX]$/;
const ISBN13 = /^\d{13}$/;

export function normalizeIsbn(value: string): string | null {
  const compact = value.replace(/[^0-9Xx]/g, "").toUpperCase();
  if (ISBN10.test(compact) && isbn10Ok(compact)) return compact;
  if (ISBN13.test(compact) && isbn13Ok(compact)) return compact;
  return null;
}

function isbn10Ok(value: string): boolean {
  let sum = 0;
  for (let index = 0; index < 10; index += 1) {
    const char = value[index] ?? "";
    const digit = char === "X" ? 10 : Number(char);
    sum += digit * (10 - index);
  }
  return sum % 11 === 0;
}

function isbn13Ok(value: string): boolean {
  let sum = 0;
  for (let index = 0; index < 13; index += 1) {
    const digit = Number(value[index]);
    sum += digit * (index % 2 === 0 ? 1 : 3);
  }
  return sum % 10 === 0;
}

export function normalizeMac(value: string): string | null {
  const hex = value.replace(/[^0-9a-fA-F]/g, "");
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) return null;
  return hex.toUpperCase().match(/.{2}/g)?.join(":") ?? null;
}

export function ipv4ToInt(ip: string): number | null {
  if (!IPV4.test(ip)) return null;
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return null;
  return (((parts[0] ?? 0) * 256 + (parts[1] ?? 0)) * 256 + (parts[2] ?? 0)) * 256 + (parts[3] ?? 0);
}

/** True when the IPv4 address is inside the CIDR, including the network and broadcast addresses. */
export function cidrContains(ip: string, cidr: string): boolean {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!match?.[1] || !match[2]) return false;
  const prefix = Number(match[2]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const base = ipv4ToInt(match[1]);
  const host = ipv4ToInt(ip);
  if (base == null || host == null) return false;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return (base >>> 0 & mask) === (host >>> 0 & mask);
}

export function parseCidr(value: string): string | null {
  const trimmed = value.trim();
  if (!cidrContains(trimmed.split("/")[0] ?? "", trimmed)) return null;
  const [address, prefix] = trimmed.split("/");
  const numbers = (address ?? "").split(".").map((part) => String(Number(part)));
  return `${numbers.join(".")}/${Number(prefix)}`;
}

export function isLeapYear(year: number): boolean {
  return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
}

export function daysInMonth(month: number, year: number | null): number {
  if (month === 2) return year == null || isLeapYear(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

/** Day and month are both set or both empty. 29 February is allowed when the year is empty or a leap year. */
export function birthdayPartsOk(day: number | null, month: number | null, year: number | null): boolean {
  if (day == null && month == null) return year == null;
  if (day == null || month == null) return false;
  if (month < 1 || month > 12 || day < 1) return false;
  if (year != null && (year < 1 || year > 9999)) return false;
  return day <= daysInMonth(month, year);
}

export function locationWouldLoop(
  rows: Array<{ id: string; parentId: string | null }>,
  id: string | null,
  parentId: string | null,
): boolean {
  if (!parentId) return false;
  if (id && parentId === id) return true;
  const seen = new Set<string>();
  let current: string | null = parentId;
  while (current) {
    if (id && current === id) return true;
    if (seen.has(current)) return true;
    seen.add(current);
    const parent: string | null = rows.find((row) => row.id === current)?.parentId ?? null;
    current = parent;
  }
  return false;
}
