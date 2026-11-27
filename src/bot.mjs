// Keel Telegram bot: long polling, no framework. Logs command names only — never message text or the token.
import { mkdirSync } from "node:fs";
import { Telegraph } from "./telegraph.mjs";
import { Budget } from "./budget.mjs";
import { OfacList } from "./ofac.mjs";
import { runCheck } from "./check.mjs";
import { formatCheck, HELP, ABOUT, formatNothing } from "./format.mjs";
import { CheckLog, JsonFile } from "./store.mjs";
import { Watcher } from "./watch.mjs";
import { extract } from "./extract.mjs";

const RATE = { perHour: 12 }; // rumour checks per chat per hour
const CACHE_MIN = 10; // the same rumour within 10 minutes reuses the last answer: no second payment

export class KeelBot {
  constructor({ token, telegraph, budget, ofac, dataDir = "data", maxCheckUsd = 0.3, verdictChatId = null, api = null, now = () => new Date() }) {
    this.token = token;
    this.api = api || ((method, body) => telegramApi(token, method, body));
    this.telegraph = telegraph;
    this.budget = budget;
    this.ofac = ofac;
    this.maxCheckUsd = maxCheckUsd;
    this.now = now;
    this.log = new CheckLog(`${dataDir}/checks.jsonl`);
    this.config = new JsonFile(`${dataDir}/config.json`, { verdictChatId, offset: 0 });
    if (verdictChatId) this.config.value.verdictChatId = verdictChatId;
    this.rate = new Map();
    this.cache = new Map();
    this.watcher = new Watcher({ file: `${dataDir}/watches.json`, telegraph, budget, now, send: (chatId, html) => this.send(chatId, html) });
    this.username = null;
  }

  async start() {
    const me = await this.api("getMe", {});
    this.username = me.username;
    console.log(`polling as @${this.username}`);
    await this.api("setMyCommands", { commands: [
      { command: "check", description: "Check a rumour (or reply to one with /check)" },
      { command: "watch", description: "Watch a ship: /watch NAME or IMO" },
      { command: "unwatch", description: "Stop watching a ship" },
      { command: "watches", description: "Ships you are watching" },
      { command: "receipts", description: "Your last checks and their receipts" },
      { command: "stats", description: "What Keel has checked so far" },
      { command: "help", description: "How Keel works" },
      { command: "about", description: "Method and source code" },
    ] }).catch(() => {});
    setInterval(() => this.watcher.tick().catch((e) => console.log("watch tick failed:", e.message)), 10 * 60 * 1000).unref();
    for (;;) {
      try {
        const updates = await this.api("getUpdates", { offset: this.config.value.offset || 0, timeout: 50, allowed_updates: ["message", "callback_query", "my_chat_member"] });
        for (const u of updates) {
          this.config.value.offset = u.update_id + 1;
          this.config.write();
          this.handle(u).catch((e) => console.log("handler error:", e.message));
        }
      } catch (e) {
        console.log("poll error:", e.message);
        await sleep(3000);
      }
    }
  }

  async handle(u) {
    if (u.my_chat_member) return this.onMembership(u.my_chat_member);
    if (u.callback_query) return this.onButton(u.callback_query);
    const m = u.message;
    if (!m) return;
    const chat = m.chat;
    const text = m.text || m.caption || "";
    const isPrivate = chat.type === "private";
    if (!isPrivate) this.rememberGroup(chat);

    const cmd = parseCommand(text, this.username);
    if (cmd) console.log(`← ${chat.type} /${cmd.name}`);
    else if (isPrivate) console.log(`← private ${m.forward_origin || m.forward_date ? "forward" : "text"}`);

    if (cmd?.name === "start" || cmd?.name === "help") return this.send(chat.id, HELP);
    if (cmd?.name === "about") return this.send(chat.id, ABOUT);
    if (cmd?.name === "stats") return this.send(chat.id, this.statsText());
    if (cmd?.name === "receipts") return this.send(chat.id, this.receiptsText(chat.id));
    if (cmd?.name === "watches") return this.send(chat.id, this.watchesText(chat.id));
    if (cmd?.name === "watch") return this.onWatch(chat.id, cmd.args || m.reply_to_message?.text || "");
    if (cmd?.name === "unwatch") {
      const n = this.watcher.remove(chat.id, cmd.args || "");
      return this.send(chat.id, n ? `Stopped watching ${n} ship${n > 1 ? "s" : ""}.` : "Nothing to stop. /watches shows what you follow.");
    }
    if (cmd?.name === "check") {
      const target = cmd.args || m.reply_to_message?.text || m.reply_to_message?.caption || "";
      if (!target) return this.send(chat.id, "Reply to a message with /check, or write <code>/check tanker NAME hit near Hormuz</code>.", m.message_id);
      return this.onCheck(chat, target, m.message_id);
    }
    if (cmd) return isPrivate ? this.send(chat.id, HELP) : undefined;
    // Plain text or a forward: checked in private chats; in groups only when the bot is mentioned.
    if (isPrivate) return this.onCheck(chat, text, m.message_id);
    if (this.username && text.includes(`@${this.username}`)) return this.onCheck(chat, text.replace(`@${this.username}`, ""), m.message_id);
    // A forwarded post, or any message in the verdict group, that names a ship AND makes a claim is checked without a command.
    // Ordinary group chatter is never paid for.
    const forwarded = Boolean(m.forward_origin || m.forward_date);
    const inVerdictGroup = chat.id === this.config.value.verdictChatId;
    if (forwarded || inVerdictGroup) {
      const ex = extract(text);
      if ((ex.ships.length || ex.imos.length || ex.mmsis.length) && ex.claims.length) {
        console.log(`← ${chat.type} ${forwarded ? "forward" : "text"} (auto)`);
        return this.onCheck(chat, text, m.message_id);
      }
    }
  }

  async onCheck(chat, text, replyTo) {
    const started = Date.now();
    const ex = extract(text);
    if (!ex.ships.length && !ex.imos.length && !ex.mmsis.length && !ex.claims.length) return this.send(chat.id, formatNothing(), replyTo);
    if (!this.allow(chat.id)) return this.send(chat.id, `That's ${RATE.perHour} checks this hour from this chat. Each one is paid, so please wait a little.`, replyTo);

    const key = ex.text.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < CACHE_MIN * 60000) {
      return this.send(chat.id, `${hit.html}\n\n<i>Same rumour checked ${Math.round((this.now() - hit.at) / 60000)} min ago: answer reused, nothing paid again.</i>`, replyTo);
    }

    const what = ex.ships[0] || (ex.imos[0] ? `IMO ${ex.imos[0]}` : ex.mmsis[0]) || "the claim";
    const ack = await this.send(chat.id, `🔎 Checking <b>${esc(what)}</b>: buying live tracking, sanctions and a fact-check on Telegraph…`, replyTo);
    await this.api("sendChatAction", { chat_id: chat.id, action: "typing" }).catch(() => {});

    let c;
    try {
      c = await runCheck(text, { telegraph: this.telegraph, budget: this.budget, ofac: this.ofac, maxCheckUsd: this.maxCheckUsd, now: this.now });
    } catch (e) {
      console.log("check failed:", e.message);
      return this.edit(chat.id, ack?.message_id, "The check failed before it could finish. Nothing was charged for answers that did not arrive. Try again in a minute.");
    }
    const html = formatCheck(c, { budgetLeftUsd: this.budget.remainingUsd() });
    this.cache.set(key, { at: this.now(), html });
    this.log.add(chat.id, c);
    const buttons = c.shipQuery ? { inline_keyboard: [[{ text: "👁 Watch this ship", callback_data: `w:${c.shipQuery}`.slice(0, 60) }]] } : undefined;
    await this.edit(chat.id, ack?.message_id, html, buttons);
    if (c.result?.best && c.result.ageMin != null && c.result.ageMin <= 180) await this.api("sendLocation", { chat_id: chat.id, latitude: c.result.best.lat, longitude: c.result.best.lon, reply_to_message_id: ack?.message_id, disable_notification: true }).catch(() => {});
    await this.publish(c, chat.id);
    console.log(`→ ${chat.type} check ${c.result?.verdict?.key || c.kind} $${c.totalUsd} in ${Date.now() - started} ms`);
  }

  async onWatch(chatId, args) {
    const ex = extract(args);
    const q = ex.imos[0] ? `IMO ${ex.imos[0]}` : ex.mmsis[0] || ex.ships[0] || args.trim().toUpperCase();
    if (!q || q.length < 3) return this.send(chatId, "Which ship? <code>/watch EAGLE S</code> or <code>/watch IMO 9329760</code>");
    const sanctioned = this.ofac?.match({ name: ex.ships[0] || q, imo: ex.imos[0], mmsi: ex.mmsis[0] })?.matches?.length > 0;
    const r = this.watcher.add(chatId, q, { sanctioned });
    if (!r.ok) return this.send(chatId, r.reason);
    return this.send(chatId, `👁 Watching <b>${esc(q)}</b>${sanctioned ? " (🚩 on the OFAC SDN list)" : ""}. I'll check its position every ${this.watcher.limits.pollMinutes / 60} h and message you if it goes quiet for ${this.watcher.limits.quietHours}+ h, comes back, jumps somewhere it couldn't reach, or enters a new sea area. /unwatch ${esc(q)} to stop.`);
  }

  async onButton(q) {
    await this.api("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
    if (q.data?.startsWith("w:")) return this.onWatch(q.message.chat.id, q.data.slice(2));
  }

  onMembership(cm) {
    const chat = cm.chat;
    console.log(`membership ${chat.type} → ${cm.new_chat_member?.status}`);
    if (chat.type !== "private") this.rememberGroup(chat);
  }

  // The verdict group is found automatically the first time the bot sees it (title contains "verdict").
  rememberGroup(chat) {
    if (!this.config.value.verdictChatId && /verdict/i.test(chat.title || "")) {
      this.config.value.verdictChatId = chat.id;
      this.config.write();
      console.log("verdict group registered");
    }
  }

  async publish(c, fromChatId) {
    const id = this.config.value.verdictChatId;
    if (!id || c.kind === "nothing" || fromChatId === id) return; // already answered in the group itself
    const html = `${formatCheck(c)}\n\n<i>Checked via @${this.username}. Forward it any shipping rumour.</i>`;
    await this.send(id, html).catch(() => {});
  }

  allow(chatId) {
    const now = this.now().getTime();
    const list = (this.rate.get(chatId) || []).filter((t) => now - t < 3600_000);
    if (list.length >= RATE.perHour) return false;
    list.push(now);
    this.rate.set(chatId, list);
    return true;
  }

  statsText() {
    const s = this.log.stats();
    return [
      "<b>Keel so far</b>",
      `Checks: ${s.checks} on ${s.ships} ships, from ${s.chats} chats`,
      `⚠️ tracking disagreed: ${s.disagrees} · ✅ consistent: ${s.consistent} · ❓ can't verify: ${s.unverified}`,
      `🚩 sanctioned vessels found: ${s.sanctioned}`,
      `Telegraph answers bought: ${s.receipts}, total $${s.spentUsd.toFixed(2)} test USDC`,
      `Today's budget left: $${this.budget.remainingUsd().toFixed(2)}`,
      s.since ? `Since ${s.since.slice(0, 16).replace("T", " ")} UTC` : "",
    ].filter(Boolean).join("\n");
  }

  receiptsText(chatId) {
    const rows = this.log.recent(chatId, 5);
    if (!rows.length) return "No checks from this chat yet. Forward me a rumour.";
    return ["<b>Your last checks</b>", ...rows.map((r) => {
      const links = r.receipts.map((x, i) => `<a href="${esc(x.signal)}">${i + 1}</a>`).join(" ");
      return `${r.at.slice(5, 16).replace("T", " ")} · ${esc(r.ship || "claim")} · ${VERDICT_LABEL[r.verdict] || r.kind} ${r.confidence ?? ""} · $${r.costUsd.toFixed(2)} · receipts ${links || "—"}`;
    })].join("\n");
  }

  watchesText(chatId) {
    const ws = this.watcher.list(chatId);
    if (!ws.length) return "You're not watching any ships. <code>/watch NAME</code> or IMO.";
    return ["<b>Watching</b>", ...ws.map((w) => `👁 ${esc(w.query)}${w.sanctioned ? " 🚩" : ""} · last check ${w.lastCheckAt ? w.lastCheckAt.slice(11, 16) + " UTC" : "pending"}${w.quietAlerted ? " · 🌑 quiet" : ""}`)].join("\n");
  }

  async send(chatId, html, replyTo, markup) {
    try {
      return await this.api("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true, ...(replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {}), ...(markup ? { reply_markup: markup } : {}) });
    } catch (e) {
      console.log("send failed:", e.message);
      return null;
    }
  }

  async edit(chatId, messageId, html, markup) {
    if (!messageId) return this.send(chatId, html, undefined, markup);
    try {
      return await this.api("editMessageText", { chat_id: chatId, message_id: messageId, text: html, parse_mode: "HTML", disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });
    } catch (e) {
      console.log("edit failed:", e.message);
      return this.send(chatId, html, undefined, markup);
    }
  }
}

export function parseCommand(text, username) {
  const m = /^\/([a-z_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(String(text || "").trim());
  if (!m) return null;
  if (m[2] && username && m[2].toLowerCase() !== username.toLowerCase()) return null; // a command for another bot
  return { name: m[1].toLowerCase(), args: (m[3] || "").trim() };
}

// Telegram Bot API call. Errors carry Telegram's description only, never the URL (it contains the token).
export async function telegramApi(token, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(method === "getUpdates" ? 65_000 : 30_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`${method}: ${j.description || r.status}`);
  return j.result;
}

const VERDICT_LABEL = { DISAGREES: "⚠️ tracking disagrees", CONSISTENT: "✅ consistent", UNVERIFIED: "❓ can't verify" };
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Entry point: node --env-file=.env src/bot.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAPH_PRIVATE_KEY"]) if (!env[k]) { console.error(`${k} is not set`); process.exit(1); }
  const dataDir = env.KEEL_DATA_DIR || "data";
  mkdirSync(dataDir, { recursive: true });
  const money = (k, d) => { const v = Number(env[k] ?? d); if (!(Number.isFinite(v) && v > 0)) { console.error(`${k} must be a positive number of dollars`); process.exit(1); } return v; };
  const budget = new Budget({ file: `${dataDir}/spend.json`, dailyCapUsd: money("KEEL_DAILY_CAP_USD", 2) });
  const telegraph = new Telegraph({ privateKey: env.TELEGRAPH_PRIVATE_KEY });
  const ofac = new OfacList({ file: `${dataDir}/sdn.csv` });
  ofac.load().then((n) => console.log(`OFAC SDN vessels loaded: ${n}`));
  setInterval(() => ofac.load().catch(() => {}), 12 * 3600 * 1000).unref();
  const bot = new KeelBot({ token: env.TELEGRAM_BOT_TOKEN, telegraph, budget, ofac, dataDir, maxCheckUsd: money("KEEL_MAX_CHECK_USD", 0.3), verdictChatId: env.KEEL_VERDICT_CHAT_ID ? Number(env.KEEL_VERDICT_CHAT_ID) : null });
  console.log(`payer ${telegraph.account.address}`);
  bot.start();
}
