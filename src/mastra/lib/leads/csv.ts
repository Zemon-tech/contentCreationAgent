import { sha256 } from "./hash";
import type { RejectedRow, SeedRow } from "../../schemas/lead";

/**
 * CSV input for the lead pipeline (PRD §3).
 * RFC 4180 parser (quotes, escaped quotes, embedded commas/newlines), BOM
 * and CRLF tolerant. Rejects the FILE only when `company name` is missing;
 * bad rows are skipped and reported.
 */

export class CsvFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvFileError";
  }
}

/** Parse raw CSV text into records (array of fields). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field.trim() === "") {
      inQuotes = true;
      field = "";
      i++;
      continue;
    }
    if (ch === ",") {
      record.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      if (ch === "\r" && src[i + 1] === "\n") i++;
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (inQuotes) throw new CsvFileError("CSV has an unterminated quoted field");
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

export function normalizeHeader(h: string): string {
  return h
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/^"|"$/g, "")
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const COLUMN_MAP: Record<string, keyof SeedRow> = {
  "company name": "company_name",
  sector: "sector",
  profile: "profile",
  "contact person": "contact_person",
  designation: "designation",
  mobile: "mobile",
  email: "email",
  website: "website_raw",
  address: "address",
  "source file": "source_file",
  "source line": "source_line",
};

/** Bare, lowercase domain from a messy website value; null when not plausible. */
export function normalizeDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  let s = website.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.replace(/^www\d?\./, "");
  s = s.split(/[/?#\s]/)[0] ?? "";
  s = s.replace(/:\d+$/, "").replace(/\.$/, "");
  if (s.includes("@")) s = s.split("@").pop() ?? "";
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return null;
  if (!/[a-z]/.test(s.split(".").pop() ?? "")) return null;
  return s;
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(private|pvt|limited|ltd|llp|inc|llc|technologies|technology|solutions)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function computeRowId(input: {
  sourceFile: string | null;
  sourceLine: string | null;
  companyName: string;
  domain: string | null;
}): string {
  if (input.sourceFile && input.sourceLine) {
    return `r_${sha256(`${input.sourceFile.trim()}|${input.sourceLine.trim()}`).slice(0, 20)}`;
  }
  return `r_${sha256(`${normalizeName(input.companyName)}|${input.domain ?? ""}`).slice(0, 20)}`;
}

export interface ParsedLeadCsv {
  rows: SeedRow[];
  rejected: RejectedRow[];
  totalRows: number;
  unknownHeaders: string[];
}

const clean = (v: string | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

export function parseLeadCsv(text: string): ParsedLeadCsv {
  if (!text || !text.trim()) throw new CsvFileError("CSV is empty");
  const records = parseCsv(text).filter((r) => r.some((f) => f.trim() !== ""));
  if (records.length === 0) throw new CsvFileError("CSV has no header row");

  const headers = records[0]!.map(normalizeHeader);
  const colIndex = new Map<keyof SeedRow, number>();
  const unknownHeaders: string[] = [];
  headers.forEach((h, idx) => {
    const key = COLUMN_MAP[h];
    if (key && !colIndex.has(key)) colIndex.set(key, idx);
    else if (!key && h) unknownHeaders.push(h);
  });
  if (!colIndex.has("company_name")) {
    throw new CsvFileError(`CSV is missing the required "company name" column (found: ${headers.join(", ") || "none"})`);
  }

  const rows: SeedRow[] = [];
  const rejected: RejectedRow[] = [];
  const seen = new Map<string, number>();
  const dataRecords = records.slice(1);

  dataRecords.forEach((rec, i) => {
    const rowNumber = i + 1;
    const get = (k: keyof SeedRow) => {
      const idx = colIndex.get(k);
      return idx === undefined ? null : clean(rec[idx]);
    };
    const companyName = get("company_name");
    if (!companyName) {
      rejected.push({ row_number: rowNumber, reason: "missing company name", company_name: null });
      return;
    }
    const websiteRaw = get("website_raw");
    const domain = normalizeDomain(websiteRaw);
    const sourceFile = get("source_file");
    const sourceLine = get("source_line");
    const rowId = computeRowId({ sourceFile, sourceLine, companyName, domain });
    const dupOf = seen.get(rowId);
    if (dupOf !== undefined) {
      rejected.push({
        row_number: rowNumber,
        reason: `duplicate of row ${dupOf} (same source file/line or same name+domain)`,
        company_name: companyName,
      });
      return;
    }
    seen.set(rowId, rowNumber);
    rows.push({
      row_id: rowId,
      row_number: rowNumber,
      company_name: companyName,
      sector: get("sector"),
      profile: get("profile"),
      contact_person: get("contact_person"),
      designation: get("designation"),
      mobile: get("mobile"),
      email: get("email"),
      website_raw: websiteRaw,
      website_domain: domain,
      address: get("address"),
      source_file: sourceFile,
      source_line: sourceLine,
    });
  });

  return { rows, rejected, totalRows: dataRecords.length, unknownHeaders };
}

// ---------- writing ----------

/** Escape a CSV cell; neutralises spreadsheet formula injection (=, +, -, @, tab, CR). */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) lines.push(headers.map((h) => csvCell(r[h])).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
