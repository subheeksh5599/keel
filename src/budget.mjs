// Spending limits enforced in code, before any payment is signed.
// Per-check cap and a daily cap (UTC day), persisted so a restart cannot reset them.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export class Budget {
  constructor({ file, dailyCapUsd = 2, now = () => new Date() } = {}) {
    if (!(Number.isFinite(dailyCapUsd) && dailyCapUsd > 0)) throw new Error(`daily cap must be a positive number of dollars, got ${dailyCapUsd}`);
    this.file = file;
    this.dailyCapUsd = dailyCapUsd;
    this.now = now;
    this.state = this.load();
  }

  day() {
    return this.now().toISOString().slice(0, 10);
  }

  load() {
    if (!this.file) return { day: this.day(), spentUsd: 0, totalUsd: 0 };
    let raw;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return { day: this.day(), spentUsd: 0, totalUsd: 0 }; // no file yet
    }
    let j = null;
    try { j = JSON.parse(raw); } catch {}
    // A damaged spend file must not reset the cap: treat today as fully spent until someone fixes it.
    if (!j || typeof j !== "object" || typeof j.day !== "string" || !Number.isFinite(j.spentUsd)) {
      console.error(`spend file ${this.file} is unreadable; payments are paused for today`);
      return { day: this.day(), spentUsd: this.dailyCapUsd, totalUsd: 0, damaged: true };
    }
    return { ...j, totalUsd: Number.isFinite(j.totalUsd) ? j.totalUsd : 0 };
  }

  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify(this.state));
    renameSync(this.file + ".tmp", this.file);
  }

  roll() {
    const d = this.day();
    if (this.state.day !== d) this.state = { ...this.state, day: d, spentUsd: 0 };
  }

  todayUsd() {
    this.roll();
    return round(this.state.spentUsd);
  }

  remainingUsd() {
    return round(Math.max(0, this.dailyCapUsd - this.todayUsd()));
  }

  // Counts the price before the payment is signed, so parallel asks cannot all pass the check.
  reserve(usd) {
    if (!(Number.isFinite(usd) && usd >= 0)) throw new BudgetError(`refused: price ${usd} is not a number`);
    this.roll();
    if (this.state.spentUsd + usd > this.dailyCapUsd + 1e-9) {
      throw new BudgetError(`daily cap reached ($${this.dailyCapUsd} test USDC). It resets at 00:00 UTC.`);
    }
    this.state.spentUsd = round(this.state.spentUsd + usd);
    this.state.totalUsd = round((this.state.totalUsd || 0) + usd);
    this.save();
  }

  // A payment that was not delivered is not billed by the node, so it comes back off the count.
  release(usd) {
    this.roll();
    this.state.spentUsd = round(Math.max(0, this.state.spentUsd - usd));
    this.state.totalUsd = round(Math.max(0, (this.state.totalUsd || 0) - usd));
    this.save();
  }
}

// A per-check allowance on top of the daily cap: one rumour cannot spend more than maxUsd.
export class CheckBudget {
  constructor(parent, maxUsd) {
    if (!(Number.isFinite(maxUsd) && maxUsd > 0)) throw new Error(`per-check cap must be a positive number of dollars, got ${maxUsd}`);
    this.parent = parent;
    this.maxUsd = maxUsd;
    this.usedUsd = 0;
  }
  reserve(usd) {
    if (this.usedUsd + usd > this.maxUsd + 1e-9) throw new BudgetError(`per-check cap reached ($${this.maxUsd})`);
    this.parent?.reserve(usd);
    this.usedUsd = round(this.usedUsd + usd);
  }
  release(usd) {
    this.parent?.release(usd);
    this.usedUsd = round(Math.max(0, this.usedUsd - usd));
  }
}

export class BudgetError extends Error {}

const round = (n) => Math.round(n * 1e6) / 1e6;
