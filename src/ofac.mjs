// OFAC's own SDN list, read directly from treasury.gov (not bought on Telegraph).
// Used as a second, independent sanctions source next to Telegraph's SANCTIONS_SCREENING_MATCH answer,
// because a single screening miner can be down or wrong.
import { readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const OFAC_URL = "https://www.treasury.gov/ofac/downloads/sdn.csv";
const DAY_MS = 24 * 3600 * 1000;

// sdn.csv columns: ent_num, name, type, program, title, call_sign, vessel_type, tonnage, grt, flag, owner, remarks
export function parseSdnVessels(csv) {
  const out = [];
  for (const line of csv.split(/\r?\n/)) {
    if (!line.includes('"vessel"')) continue;
    const cols = splitCsv(line);
    if (cols[2] !== "vessel") continue;
    const remarks = cols[11] || "";
    const imo = (remarks.match(/IMO (\d{7})/) || [])[1] || null;
    const mmsi = (remarks.match(/MMSI (\d{9})/) || [])[1] || null;
    const aka = [...remarks.matchAll(/(?:f\.k\.a\.|a\.k\.a\.) '([^']+)'/g)].map((m) => m[1].toUpperCase());
    out.push({
      name: cols[1].toUpperCase(),
      aka,
      program: cols[3] || null,
      flag: clean(cols[9]),
      vesselType: clean(cols[6]),
      imo,
      mmsi,
    });
  }
  return out;
}

function clean(v) {
  return !v || v.trim() === "-0-" ? null : v.trim();
}

function splitCsv(line) {
  const cols = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === "," && !q) { cols.push(cur.trim()); cur = ""; }
    else cur += c;
  }
  cols.push(cur.trim());
  return cols.map((c) => c.replace(/^"|"$/g, ""));
}

export class OfacList {
  constructor({ file, fetchImpl = fetch } = {}) {
    this.file = file;
    this.fetch = fetchImpl;
    this.vessels = [];
    this.loadedAt = null;
  }

  async load() {
    let csv = null;
    try {
      if (this.file && Date.now() - statSync(this.file).mtimeMs < DAY_MS) csv = readFileSync(this.file, "utf8");
    } catch {}
    if (!csv) {
      try {
        const r = await this.fetch(OFAC_URL, { signal: AbortSignal.timeout(60_000) });
        if (r.ok) {
          csv = await r.text();
          if (this.file) { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file, csv); }
        }
      } catch {}
    }
    if (!csv && this.file) {
      try { csv = readFileSync(this.file, "utf8"); } catch {}
    }
    if (csv) {
      this.vessels = parseSdnVessels(csv);
      this.loadedAt = new Date().toISOString();
    }
    return this.vessels.length;
  }

  // Exact match on IMO or MMSI, else exact name / former name. No fuzzy matching: a near-miss name is not a listing.
  match({ name, imo, mmsi }) {
    if (!this.vessels.length) return { checked: false, matches: [] };
    const n = name ? name.toUpperCase().trim() : null;
    const matches = this.vessels.filter((v) =>
      (imo && v.imo === imo) || (mmsi && v.mmsi === mmsi) || (n && (v.name === n || v.aka.includes(n))));
    return { checked: true, matches, listSize: this.vessels.length };
  }
}
