// /watch: follow a ship and message the chat when it goes quiet, comes back, or jumps somewhere it couldn't reach.
// Polling is paid, so it is sparse (every 2 h), asks the second tracker only when the first has nothing,
// and stops while the daily budget is low so that rumour checks always have money left.
import { distanceKm, impliedKnots, regionOf, fmtCoord } from "./geo.mjs";
import { fmtAge } from "./assess.mjs";
import { TRACKERS, INTENTS } from "./check.mjs";
import { JsonFile } from "./store.mjs";

export const WATCH_LIMITS = { perChat: 2, total: 10, pollMinutes: 120, quietHours: 3, reserveUsd: 0.5 };

export class Watcher {
  constructor({ file, telegraph, budget, send, now = () => new Date(), limits = WATCH_LIMITS, trackers = TRACKERS }) {
    this.store = new JsonFile(file, { watches: [] });
    this.telegraph = telegraph;
    this.budget = budget;
    this.send = send; // async (chatId, html) => void
    this.now = now;
    this.limits = limits;
    this.trackers = trackers;
  }

  list(chatId) {
    return this.store.value.watches.filter((w) => w.chatId === chatId);
  }

  add(chatId, query, extra = {}) {
    const q = query.trim().toUpperCase();
    const all = this.store.value.watches;
    if (all.some((w) => w.chatId === chatId && w.query === q)) return { ok: false, reason: `Already watching ${q}.` };
    if (this.list(chatId).length >= this.limits.perChat) return { ok: false, reason: `You can watch ${this.limits.perChat} ships at a time. /unwatch one first.` };
    if (all.length >= this.limits.total) return { ok: false, reason: "The watch list is full right now. Try again later." };
    all.push({ chatId, query: q, addedAt: this.now().toISOString(), lastCheckAt: null, lastFix: null, quietAlerted: false, ...extra });
    this.store.write();
    return { ok: true };
  }

  remove(chatId, query) {
    const q = query.trim().toUpperCase();
    const before = this.store.value.watches.length;
    this.store.value.watches = this.store.value.watches.filter((w) => !(w.chatId === chatId && (w.query === q || !q)));
    this.store.write();
    return before - this.store.value.watches.length;
  }

  due(w) {
    if (!w.lastCheckAt) return true;
    return this.now() - Date.parse(w.lastCheckAt) >= this.limits.pollMinutes * 60000;
  }

  // One pass over every watch that is due. Returns the alerts sent (for tests and logs).
  async tick() {
    const alerts = [];
    for (const w of this.store.value.watches) {
      if (!this.due(w)) continue;
      if (this.budget && this.budget.remainingUsd() < this.limits.reserveUsd) break; // keep money for rumour checks
      const fix = await this.locate(w.query);
      w.lastCheckAt = this.now().toISOString();
      const msgs = this.compare(w, fix);
      if (fix) w.lastFix = fix;
      for (const m of msgs) {
        alerts.push({ chatId: w.chatId, text: m });
        try { await this.send(w.chatId, m); } catch {}
      }
    }
    this.store.write();
    return alerts;
  }

  async locate(query) {
    for (const t of this.trackers) {
      let r;
      try {
        r = await this.telegraph.ask({ intent: INTENTS.vessel, params: { vessel: query }, miner: t.id, budget: this.budget });
      } catch { continue; }
      const a = r.answer || {};
      if (r.ok && a.latitude != null && a.longitude != null) {
        return { lat: Number(a.latitude), lon: Number(a.longitude), speed: a.speed_knots ?? null, at: a.observed_at || null, source: t.source, signalUrl: r.signalUrl };
      }
    }
    return null;
  }

  // Pure: compare the new fix with what we knew. Returns alert messages (HTML).
  compare(w, fix) {
    const out = [];
    const name = `<b>${esc(w.query)}</b>`;
    const now = this.now();
    const newest = fix?.at ? Date.parse(fix.at) : null;
    const quietMin = newest ? (now - newest) / 60000 : null;
    const quiet = !fix || quietMin > this.limits.quietHours * 60;

    if (quiet && !w.quietAlerted) {
      const since = fix?.at || w.lastFix?.at;
      out.push(`🌑 ${name} has gone quiet: no position report for ${since ? fmtAge((now - Date.parse(since)) / 60000) : "a while"}.${w.lastFix ? ` Last seen ${esc(fmtCoord(w.lastFix))}${regionOf(w.lastFix) ? `, ${esc(regionOf(w.lastFix))}` : ""}.` : ""}${w.sanctioned ? " It is a sanctioned vessel, and sanctioned ships often switch off tracking before a transfer." : ""}`);
      w.quietAlerted = true;
    } else if (!quiet && w.quietAlerted) {
      out.push(`📡 ${name} is transmitting again: ${esc(fmtCoord(fix))}${regionOf(fix) ? `, ${esc(regionOf(fix))}` : ""}.${fix.signalUrl ? ` <a href="${esc(fix.signalUrl)}">receipt</a>` : ""}`);
      w.quietAlerted = false;
    }

    if (fix && w.lastFix && !quiet) {
      const km = distanceKm(w.lastFix, fix);
      const need = impliedKnots(w.lastFix, fix);
      if (need !== null && need > 45 && km > 50) {
        out.push(`⚠️ ${name} jumped ${Math.round(km)} km between reports, which would need ${Math.round(need)} knots. One of the position reports is wrong or spoofed.`);
      }
      const r0 = regionOf(w.lastFix), r1 = regionOf(fix);
      if (r1 && r0 !== r1) out.push(`➡️ ${name} moved into ${esc(r1)}${r0 ? ` from ${esc(r0)}` : ""}.`);
    }
    return out;
  }
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
