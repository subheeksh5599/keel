import { test } from "node:test";
import assert from "node:assert/strict";
import { extract, validImo, validMmsi } from "../src/extract.mjs";

const cases = [
  ["BREAKING: tanker ELISE hit by drone near Hormuz and sinking!! https://x.com/a/status/1", { ships: ["ELISE"], claims: ["sinking", "struck"], places: ["Strait of Hormuz"], media: 1 }],
  ["Reports say the Eagle S cut a cable in the Gulf of Finland, IMO 9329760", { ships: [], imos: ["9329760"], places: ["Gulf of Finland"] }],
  ['MV "Hulda Maersk" seized by IRGC in the Strait of Hormuz', { ships: ["HULDA MAERSK"], claims: ["seized"] }],
  ["Houthis claim missile strike on oil tanker ADRIAN DARYA 1 in the Red Sea", { ships: ["ADRIAN DARYA 1"], claims: ["struck"], places: ["Red Sea"] }],
  ["Iran says it closed Hormuz to all shipping", { ships: [], claims: ["blocked"] }],
  ["Video: LNG carrier Al Khor on fire off Fujairah https://t.me/x/12 MMSI 538001234", { ships: ["AL KHOR"], mmsis: ["538001234"], claims: ["fire"], places: ["Fujairah"], media: 1 }],
  ["URGENT UPDATE: container ship EVER GIVEN ran aground in the Suez Canal again", { ships: ["EVER GIVEN"], claims: ["aground"], places: ["Suez Canal"] }],
  ["Shadow fleet tanker went dark in the Baltic after leaving Primorsk", { ships: [], claims: ["dark"], places: ["Baltic Sea", "Primorsk"] }],
  ["the bulk carrier Rubymar sank in the Red Sea", { ships: ["RUBYMAR"], claims: ["sinking"] }],
  ["ferry VIKING GLORY diverted back to Turku", { ships: ["VIKING GLORY"], claims: ["diverted"] }],
  ["good morning everyone", { ships: [], claims: [] }],
  ["IMO 1234568 is not a valid number", { imos: [] }],
  ["NATO says UAE and US forces escorted the convoy", { ships: [] }],
  ["frigate HMS DIAMOND shot down a drone in the Red Sea", { claims: ["struck"], places: ["Red Sea"] }],
  ["Two tankers, FRONT ALTAIR and KOKUKA COURAGEOUS, attacked in the Gulf of Oman", { ships: ["FRONT ALTAIR", "KOKUKA COURAGEOUS"], places: ["Gulf of Oman"] }],
];

for (const [text, want] of cases) {
  test(`extract: ${text.slice(0, 50)}`, () => {
    const e = extract(text);
    if (want.ships) for (const s of want.ships) assert.ok(e.ships.includes(s), `ship ${s} in ${JSON.stringify(e.ships)}`);
    if (want.ships && want.ships.length === 0) assert.deepEqual(e.ships, []);
    if (want.imos) assert.deepEqual(e.imos, want.imos);
    if (want.mmsis) assert.deepEqual(e.mmsis, want.mmsis);
    if (want.claims) for (const c of want.claims) assert.ok(e.claims.includes(c), `claim ${c} in ${JSON.stringify(e.claims)}`);
    if (want.claims && want.claims.length === 0) assert.deepEqual(e.claims, []);
    if (want.places) for (const p of want.places) assert.ok(e.places.includes(p), `place ${p}`);
    if (want.media) assert.equal(e.media.length, want.media);
  });
}

test("IMO check digit", () => {
  assert.equal(validImo("9329760"), true); // EAGLE S
  assert.equal(validImo("9399363"), true); // HULDA MAERSK
  assert.equal(validImo("1234568"), false);
});

test("MMSI must start with a ship MID digit", () => {
  assert.equal(validMmsi("219278000"), true);
  assert.equal(validMmsi("111111111"), false);
});
