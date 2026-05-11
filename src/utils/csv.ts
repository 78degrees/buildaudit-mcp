/**
 * csv.ts — CSV parser with fuzzy header matching for Job + Expense schemas.
 *
 * Construction software exports use wildly different column names for the
 * same field — "Job Name" vs "Project" vs "Work Order" all mean the same
 * thing. Rather than force the user to remap, we accept the raw CSV and
 * map each column to a canonical schema field via an alias dictionary.
 *
 * The parser handles:
 *   - Quoted fields with embedded commas and escaped quotes ("a, ""b"", c")
 *   - CRLF and LF line endings
 *   - Currency-formatted numbers ($1,234.56, (5,000) for negatives)
 *   - Boolean coercion (yes/no/y/n/true/false/1/0)
 *   - PO-number columns where "non-empty" implies hasPurchaseOrder=true
 *   - Date normalization to ISO YYYY-MM-DD (accepts MM/DD/YYYY, M/D/YY, etc.)
 *
 * Rows that fail required-field validation are silently skipped; the caller
 * sees an array of clean records. (For MVP — error reporting can come later.)
 */

import type { Job } from "../types/job.js";
import type { Expense } from "../types/expense.js";
import { InvalidInputError } from "./errors.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseJobsCsv(text: string): Job[] {
  const { headerMap, rows } = parseAndMatch(text, JOB_ALIASES);

  const out: Job[] = [];
  for (const row of rows) {
    const rec = projectRow(row, headerMap);

    const jobName = (rec.jobName ?? "").trim();
    if (!jobName) continue;

    const estimatedRevenue = coerceMoney(rec.estimatedRevenue);
    const actualRevenue    = coerceMoney(rec.actualRevenue);
    const estimatedCosts   = coerceMoney(rec.estimatedCosts);
    const actualCosts      = coerceMoney(rec.actualCosts);
    const status           = (rec.status ?? "").trim() || "active";
    const startDate        = coerceDate(rec.startDate) ?? today();
    const endDate          = coerceDate(rec.endDate);

    out.push({
      jobName,
      estimatedRevenue: estimatedRevenue ?? 0,
      actualRevenue:    actualRevenue    ?? 0,
      estimatedCosts:   estimatedCosts   ?? 0,
      actualCosts:      actualCosts      ?? 0,
      status,
      startDate,
      endDate,
    });
  }
  return out;
}

export function parseExpensesCsv(text: string): Expense[] {
  const { headerMap, rows } = parseAndMatch(text, EXPENSE_ALIASES);

  const out: Expense[] = [];
  for (const row of rows) {
    const rec = projectRow(row, headerMap);

    const vendor = (rec.vendor ?? "").trim();
    if (!vendor) continue;

    const amount = coerceMoney(rec.amount);
    if (amount === null) continue;

    const date = coerceDate(rec.date);
    if (!date) continue;

    // hasPurchaseOrder may be a boolean column OR a PO-number column.
    // If the raw value is a recognized boolean, use that. Otherwise:
    // non-empty + non-"none"/"n/a"/"-" implies a PO is on file.
    const hasPoRaw = (rec.hasPurchaseOrder ?? "").trim();
    let hasPurchaseOrder: boolean;
    const boolVal = coerceBool(hasPoRaw);
    if (boolVal !== null) {
      hasPurchaseOrder = boolVal;
    } else {
      const norm = hasPoRaw.toLowerCase();
      hasPurchaseOrder = hasPoRaw.length > 0 && !["none", "n/a", "na", "-", "—"].includes(norm);
    }

    const jobNameRaw = (rec.jobName ?? "").trim();
    const costCodeRaw = (rec.costCode ?? "").trim();

    out.push({
      vendor,
      amount,
      date,
      jobName:          jobNameRaw ? jobNameRaw : null,
      hasPurchaseOrder,
      costCode:         costCodeRaw ? costCodeRaw : null,
      description:      (rec.description ?? "").trim(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Alias dictionaries — canonical field → list of header variants seen in the wild
// ---------------------------------------------------------------------------

type AliasMap = Record<string, string[]>;

const JOB_ALIASES: AliasMap = {
  jobName: [
    "job name", "job", "project", "project name", "project number", "project #",
    "work order", "wo", "wo number", "wo #", "name", "site", "contract", "contract name",
  ],
  estimatedRevenue: [
    "estimated revenue", "est revenue", "estimate revenue", "budgeted revenue",
    "budget revenue", "quoted revenue", "quoted price", "contract value",
    "contract amount", "estimate", "budget",
  ],
  actualRevenue: [
    "actual revenue", "revenue", "invoiced", "billed", "billed to date", "actual",
    "collected", "received",
  ],
  estimatedCosts: [
    "estimated costs", "estimated cost", "est costs", "est cost", "budgeted costs",
    "budgeted cost", "budget costs", "budget cost", "estimate cost",
  ],
  actualCosts: [
    "actual costs", "actual cost", "total cost", "total costs",
    "job cost", "job costs", "costs", "cost", "spent", "spent to date",
    "incurred", "incurred costs", "actuals", "true cost", "final cost",
  ],
  status: ["status", "state", "phase", "stage", "job status", "project status"],
  startDate: [
    "start date", "start", "begin date", "begin", "started", "kickoff", "kick off",
    "commencement",
  ],
  endDate: [
    "end date", "end", "completion date", "completed", "finished", "due date",
    "expected completion", "target completion",
  ],
};

const EXPENSE_ALIASES: AliasMap = {
  vendor: ["vendor", "supplier", "merchant", "payee", "company", "from", "vendor name"],
  amount: [
    "amount", "total", "cost", "price", "value", "dollar amount", "dollars",
    "subtotal", "grand total",
  ],
  date: [
    "date", "transaction date", "invoice date", "expense date", "purchased",
    "purchase date", "posted", "posted date", "txn date",
  ],
  jobName: [
    "job", "job name", "project", "project name", "job code", "wo", "work order",
    "assigned job", "site",
  ],
  hasPurchaseOrder: [
    "po", "purchase order", "has po", "has purchase order", "po number", "po #",
    "po/contract", "po status",
  ],
  costCode: [
    "cost code", "code", "gl code", "gl", "gl account", "account", "category",
    "expense category", "class",
  ],
  description: [
    "description", "memo", "note", "notes", "details", "item", "line item",
    "particulars",
  ],
};

// ---------------------------------------------------------------------------
// Header matching
// ---------------------------------------------------------------------------

/** Normalize a header for comparison: lowercase, collapse spaces, strip punctuation. */
function normalizeHeader(s: string): string {
  return s
    .toLowerCase()
    .replace(/[_\-/\\.()#]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * For each raw header in the CSV, return the canonical schema field it maps to.
 * If a header has no alias match, it's omitted from the output map.
 * If multiple headers map to the same canonical field, the *first* one wins
 * (so an earlier "Project" column takes precedence over a later "Job Code").
 */
function matchHeaders(
  rawHeaders: string[],
  aliases: AliasMap
): Map<number, string> {
  // canonical → normalized variants (one-time precompute)
  const canonByNorm = new Map<string, string>();
  for (const [canonical, variants] of Object.entries(aliases)) {
    // Also accept the canonical name itself in any of its casings.
    canonByNorm.set(normalizeHeader(canonical), canonical);
    for (const v of variants) {
      canonByNorm.set(normalizeHeader(v), canonical);
    }
  }

  const result = new Map<number, string>();
  const claimedCanonicals = new Set<string>();

  for (let i = 0; i < rawHeaders.length; i++) {
    const norm = normalizeHeader(rawHeaders[i]);
    if (!norm) continue;
    const canonical = canonByNorm.get(norm);
    if (canonical && !claimedCanonicals.has(canonical)) {
      result.set(i, canonical);
      claimedCanonicals.add(canonical);
    }
  }

  return result;
}

/** Parse CSV + match headers in one shot. */
function parseAndMatch(text: string, aliases: AliasMap): {
  headerMap: Map<number, string>;
  rows: string[][];
} {
  const parsed = parseCsv(text);
  if (parsed.length === 0) {
    throw new InvalidInputError("csv_text", "CSV is empty");
  }
  const [header, ...rows] = parsed;
  if (!header || header.length === 0) {
    throw new InvalidInputError("csv_text", "CSV has no header row");
  }
  const headerMap = matchHeaders(header, aliases);
  if (headerMap.size === 0) {
    throw new InvalidInputError(
      "csv_text",
      `No CSV columns matched the expected schema. Saw headers: ${header.join(", ")}`
    );
  }
  return { headerMap, rows };
}

/** Project a single row into a partial record keyed by canonical field names. */
function projectRow(row: string[], headerMap: Map<number, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [idx, canonical] of headerMap) {
    out[canonical] = idx < row.length ? row[idx] : "";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Low-level CSV tokenizer (RFC 4180-ish, lenient)
// ---------------------------------------------------------------------------

/**
 * Parse CSV text into a 2D array of cells. Handles:
 *   - Quoted fields:      `"hello, world"` → `hello, world`
 *   - Escaped quotes:     `"she said ""hi"""` → `she said "hi"`
 *   - CRLF and LF endings
 *   - Trailing newline (ignored)
 *   - Empty cells (preserved as `""`)
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          // Escaped quote → literal "
          cell += '"';
          i += 2;
          continue;
        }
        // Closing quote
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }

    // Not in quotes
    if (ch === '"' && cell === "") {
      // Opening quote — only valid at start of cell
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      cur.push(cell);
      cell = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      // Eat CR; the LF (or end) will commit the row.
      i++;
      continue;
    }
    if (ch === "\n") {
      cur.push(cell);
      rows.push(cur);
      cur = [];
      cell = "";
      i++;
      continue;
    }
    cell += ch;
    i++;
  }

  // Commit trailing cell + row (unless completely empty)
  if (cell !== "" || cur.length > 0) {
    cur.push(cell);
    rows.push(cur);
  }

  // Strip a single trailing empty row (common when CSV ends with newline).
  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === "") {
      rows.pop();
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

/**
 * Coerce a money string to a number.
 *   "$1,234.56"   → 1234.56
 *   "(5,000.00)"  → -5000   (accounting parens)
 *   "-$50"        → -50
 *   ""            → null
 *   "n/a"         → null
 */
export function coerceMoney(s: string | undefined): number | null {
  if (s === undefined) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (["n/a", "na", "-", "—", "null"].includes(trimmed.toLowerCase())) return null;

  let v = trimmed;
  let sign = 1;
  if (v.startsWith("(") && v.endsWith(")")) {
    sign = -1;
    v = v.slice(1, -1);
  }
  v = v.replace(/[$,\s]/g, "");
  if (v.startsWith("-")) {
    sign *= -1;
    v = v.slice(1);
  }
  const n = parseFloat(v);
  if (!isFinite(n)) return null;
  return sign * n;
}

/** Recognize common boolean strings; returns null if unrecognized. */
export function coerceBool(s: string): boolean | null {
  const v = s.trim().toLowerCase();
  if (["true", "yes", "y", "1", "t"].includes(v)) return true;
  if (["false", "no", "n", "0", "f"].includes(v)) return false;
  return null;
}

/**
 * Coerce a date string to ISO YYYY-MM-DD. Returns null on failure.
 * Accepts:
 *   2026-01-05, 2026/01/05, 01/05/2026, 1/5/26, 1/5/2026,
 *   2026-01-05T10:30:00Z (takes date part)
 */
export function coerceDate(s: string | undefined): string | null {
  if (s === undefined) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;

  // Already ISO?
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(trimmed);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // YYYY/MM/DD
  const ymd = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(trimmed);
  if (ymd) return `${ymd[1]}-${pad2(ymd[2])}-${pad2(ymd[3])}`;

  // MM/DD/YYYY or M/D/YYYY or M/D/YY
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(trimmed);
  if (mdy) {
    const m = parseInt(mdy[1], 10);
    const d = parseInt(mdy[2], 10);
    let y = parseInt(mdy[3], 10);
    if (mdy[3].length === 2) {
      // Two-digit year: 00-69 → 2000s, 70-99 → 1900s (Excel convention)
      y = y < 70 ? 2000 + y : 1900 + y;
    }
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${pad2(m)}-${pad2(d)}`;
    }
  }

  return null;
}

function pad2(n: number | string): string {
  const v = typeof n === "number" ? n.toString() : n;
  return v.length === 1 ? `0${v}` : v;
}

function today(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
