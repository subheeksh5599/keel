// Small JSON-file stores. No database: the bot writes a few records an hour at most.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

export const chatKey = (chatId) => createHash("sha256").update(String(chatId)).digest("hex").slice(0, 12);

export class JsonFile {
  constructor(file, fallback) {
    this.file = file;
    this.fallback = fallback;
    this.value = this.read();
  }
  read() {
    try { return JSON.parse(readFileSync(this.file, "utf8")); } catch { return structuredClone(this.fallback); }
  }
  write() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify(this.value, null, 1));
    writeFileSync(this.file, readFileSync(this.file + ".tmp"));
  }
}

// One line per check. Holds the verdict, the ship, the cost and the receipts — never who asked (a hashed chat key only).
export class CheckLog {
  constructor(file) {
    this.file = file;
  }
  add(chatId, c) {
    const rec = {
      at: c.checkedAt || new Date().toISOString(),
      chat: chatKey(chatId),
      kind: c.kind,
      ship: c.shipName || c.shipQuery || null,
      claims: c.extracted?.claims || [],
      verdict: c.result?.verdict?.key || null,
      confidence: c.result?.confidence ?? null,
      sanctions: c.result?.sanctions || null,
      costUsd: c.totalUsd || 0,
      receipts: (c.purchases || []).filter((p) => p.signalUrl).map((p) => ({ label: p.label, miner: p.miner, ok: p.ok, costUsd: p.costUsd, signal: p.signalUrl })),
    };
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(rec) + "\n");
    return rec;
  }
  all() {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  recent(chatId, n = 5) {
    const k = chatKey(chatId);
    return this.all().filter((r) => r.chat === k).slice(-n).reverse();
  }
  stats() {
    const all = this.all();
    const by = (k) => all.filter((r) => r.verdict === k).length;
    return {
      checks: all.length,
      ships: new Set(all.map((r) => r.ship).filter(Boolean)).size,
      disagrees: by("DISAGREES"),
      consistent: by("CONSISTENT"),
      unverified: by("UNVERIFIED"),
      sanctioned: all.filter((r) => r.sanctions === "listed").length,
      receipts: all.reduce((s, r) => s + r.receipts.length, 0),
      spentUsd: Math.round(all.reduce((s, r) => s + (r.costUsd || 0), 0) * 100) / 100,
      chats: new Set(all.map((r) => r.chat)).size,
      since: all[0]?.at || null,
    };
  }
}
