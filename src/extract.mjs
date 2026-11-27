// Pull what can be checked out of a rumour: ships, IMO/MMSI numbers, what is claimed, where, and media links.

const IMO_RE = /\bIMO[\s:#-]*(\d{7})\b/gi;
const MMSI_RE = /\bMMSI[\s:#-]*(\d{9})\b/gi;
const URL_RE = /\bhttps?:\/\/[^\s<>()]+/gi;
const MEDIA_EXT = /\.(jpe?g|png|gif|webp|mp4|mov|webm)(\?|$)/i;
const MEDIA_HOST = /(x\.com|twitter\.com|t\.me|youtube\.com|youtu\.be|instagram\.com|tiktok\.com|imgur\.com|pbs\.twimg\.com|video\.twimg\.com)/i;

// Vessel-type words that usually sit right before a ship's name.
const TYPE_WORDS = [
  "tanker", "oil tanker", "crude tanker", "product tanker", "lng carrier", "lpg carrier", "lng tanker",
  "container ship", "containership", "boxship", "cargo ship", "bulk carrier", "bulker", "freighter",
  "vessel", "ship", "ferry", "tug", "car carrier", "ro-ro", "warship", "frigate", "destroyer", "mv", "m/v", "mt", "m/t", "ss",
];

const CLAIMS = [
  { key: "sinking", re: /\b(sink|sinking|sank|sunk|capsiz\w*|going down)\b/i, label: "sinking" },
  { key: "struck", re: /\b(hit|struck|strike|attack\w*|missile|drone|torpedo\w*|explosion|exploded|blast|mine[ds]?)\b/i, label: "struck or attacked" },
  { key: "fire", re: /\b(fire|ablaze|burning|on fire|flames)\b/i, label: "on fire" },
  { key: "seized", re: /\b(seiz\w*|hijack\w*|board(ed|ing)|captur\w*|detain\w*|commandeer\w*)\b/i, label: "seized or boarded" },
  { key: "aground", re: /\b(aground|grounded|run aground|ran aground)\b/i, label: "aground" },
  { key: "dark", re: /\b(went dark|gone dark|going dark|ais off|switched off (its )?(ais|transponder)|disappeared|vanished|missing)\b/i, label: "gone dark" },
  { key: "diverted", re: /\b(divert\w*|u-turn\w*|turned (back|around)|rerout\w*|changed course)\b/i, label: "diverted" },
  { key: "blocked", re: /\b(block\w*|closed|closure|shut)\b/i, label: "route blocked" },
];

const PLACES = [
  ["Strait of Hormuz", /\bhormuz\b/i], ["Gulf of Oman", /\bgulf of oman\b/i], ["Persian Gulf", /\b(persian|arabian) gulf\b/i],
  ["Red Sea", /\bred sea\b/i], ["Bab el-Mandeb", /\bbab[\s-]?(el|al)[\s-]?mandeb\b/i], ["Gulf of Aden", /\bgulf of aden\b/i],
  ["Suez Canal", /\bsuez\b/i], ["Black Sea", /\bblack sea\b/i], ["Baltic Sea", /\bbaltic\b/i], ["Gulf of Finland", /\bgulf of finland\b/i],
  ["South China Sea", /\bsouth china sea\b/i], ["Taiwan Strait", /\btaiwan strait\b/i], ["Strait of Malacca", /\bmalacca\b/i],
  ["English Channel", /\benglish channel\b/i], ["Mediterranean", /\bmediterranean\b/i], ["Fujairah", /\bfujairah\b/i],
  ["Ras Tanura", /\bras tanura\b/i], ["Kharg Island", /\bkharg\b/i], ["Bandar Abbas", /\bbandar abbas\b/i], ["Hodeidah", /\bhodeidah\b/i],
  ["Odesa", /\bodess?a\b/i], ["Novorossiysk", /\bnovorossiysk\b/i], ["Primorsk", /\bprimorsk\b/i], ["Ust-Luga", /\bust[\s-]?luga\b/i],
];

// Words that look like ALL-CAPS names but are not ships.
const STOP = new Set([
  "BREAKING", "URGENT", "UPDATE", "ALERT", "NEWS", "JUST", "IN", "THE", "A", "AN", "AND", "OR", "OF", "AT", "ON", "TO", "IS", "IT",
  "US", "USA", "UK", "EU", "UN", "UAE", "IRGC", "NATO", "OFAC", "AIS", "IMO", "MMSI", "GPS", "LNG", "LPG", "VLCC", "ULCC", "ROV",
  "BBC", "CNN", "AP", "REUTERS", "UKMTO", "CENTCOM", "MARAD", "IDF", "RT", "PM", "AM", "UTC", "GMT", "NOW", "LIVE", "WAR", "OIL",
  "FAKE", "TRUE", "FALSE", "REPORTS", "REPORT", "SOURCES", "CONFIRMED", "UNCONFIRMED", "WATCH", "VIDEO", "PHOTO", "MV", "MT",
  "IRAN", "ISRAEL", "RUSSIA", "UKRAINE", "CHINA", "YEMEN", "HOUTHI", "HOUTHIS", "SAUDI", "QATAR", "OMAN", "INDIA", "TANKER", "SHIP",
]);

export function extract(text = "") {
  const t = String(text).replace(/\s+/g, " ").trim();
  const imos = unique([...t.matchAll(IMO_RE)].map((m) => m[1]).filter(validImo));
  const mmsis = unique([...t.matchAll(MMSI_RE)].map((m) => m[1]).filter(validMmsi));
  const urls = unique([...t.matchAll(URL_RE)].map((m) => m[0].replace(/[.,;!?]+$/, "")));
  const media = urls.filter((u) => MEDIA_EXT.test(u) || MEDIA_HOST.test(u));
  const claims = CLAIMS.filter((c) => c.re.test(t)).map((c) => c.key);
  const places = PLACES.filter(([, re]) => re.test(t)).map(([name]) => name);
  const ships = shipNames(t.replace(URL_RE, " "));
  return { text: t, ships, imos, mmsis, claims, places, media, urls };
}

export function claimLabel(key) {
  return CLAIMS.find((c) => c.key === key)?.label || key;
}

function shipNames(t) {
  const found = [];
  // 1. Quoted names: "ELISE", 'Eagle S', “Hulda Maersk”
  for (const m of t.matchAll(/["“”'‘’]([A-Za-z0-9][A-Za-z0-9 .\-]{1,30}[A-Za-z0-9])["“”'‘’]/g)) {
    if (looksLikeName(m[1])) found.push(m[1]);
  }
  // 2. After a vessel-type word: "tanker ELISE", "MV Eagle S", "the vessel Hulda Maersk".
  // The type word matches any case; the name is the run of following words that start with a capital or digit.
  const types = TYPE_WORDS.map((w) => w.replace(/[/.-]/g, (c) => `\\${c}`)).join("|");
  const afterType = new RegExp(`\\b(?:${types})\\s+(?:named\\s+|called\\s+)?`, "gi");
  for (const m of t.matchAll(afterType)) {
    const words = [];
    for (const w of t.slice(m.index + m[0].length).split(/\s+/)) {
      const clean = w.replace(/[,.;:!?)]+$/, "");
      if (!/^[A-Z0-9][A-Za-z0-9.\-]*$/.test(clean) || VERBS.test(clean) || words.length === 4) break;
      words.push(clean);
      if (clean !== w) break; // punctuation ends the name
    }
    const name = trimName(words.join(" "));
    if (name && looksLikeName(name)) found.push(name);
  }
  // 3. ALL-CAPS runs of 1-4 words (common in shipping posts): ELISE, EAGLE S, ADRIAN DARYA 1
  for (const m of t.matchAll(/\b([A-Z][A-Z0-9\-]{2,}(?:\s+(?:[A-Z0-9][A-Z0-9\-]*)){0,3})\b/g)) {
    const name = trimName(m[1]);
    if (name && looksLikeName(name)) found.push(name);
  }
  // A shorter name contained in a longer one found from the same text is the same ship ("ELISE" vs "TANKER ELISE").
  const names = unique(found.map(normName)).filter((n) => !STOP.has(n));
  return names.filter((n) => !names.some((o) => o !== n && o.startsWith(n + " ") && !/\d$/.test(o))).slice(0, 3);
}

const VERBS = /^(was|is|has|had|hit|struck|sinking|sank|sunk|seized|reported|near|in|off|after|with|and|by|on|at|from|to|has|been|being|caught|burning|ablaze|attacked|boarded)$/i;

function trimName(s) {
  const words = s.split(/\s+/);
  // drop trailing words that are verbs or stop-words ("ELISE hit", "EAGLE S was")
  while (words.length && (STOP.has(words.at(-1).toUpperCase()) || /^(was|is|has|had|hit|struck|sinking|sank|seized|reported|near|in|off|after|with|and|by)$/i.test(words.at(-1)))) words.pop();
  while (words.length && STOP.has(words[0].toUpperCase())) words.shift();
  return words.join(" ");
}

function looksLikeName(s) {
  const n = normName(s);
  if (n.length < 3 || n.length > 32) return false;
  if (/^\d+$/.test(n)) return false;
  return !n.split(" ").every((w) => STOP.has(w));
}

const normName = (s) => s.toUpperCase().replace(/\s+/g, " ").trim();
const unique = (a) => [...new Set(a)];

// IMO check digit: the 7th digit equals sum(digit_i * (7-i)) mod 10 over the first six.
export function validImo(s) {
  if (!/^\d{7}$/.test(s)) return false;
  const d = s.split("").map(Number);
  const sum = d.slice(0, 6).reduce((acc, v, i) => acc + v * (7 - i), 0);
  return sum % 10 === d[6];
}

// MMSI for a ship starts with a Maritime Identification Digit block 2-7.
export function validMmsi(s) {
  return /^[2-7]\d{8}$/.test(s);
}
