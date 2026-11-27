import { test } from "node:test";
import assert from "node:assert/strict";
import { onLand, regionOf, impliedKnots, distanceKm } from "../src/geo.mjs";

test("ships at quays, canals and anchorages are never on land", () => {
  for (const [lat, lon] of [[51.9356, 4.06], [30.6, 32.33], [25.15, 56.42], [60.08, 20.94], [1.26, 103.84], [54.2, 9.6]]) {
    assert.equal(onLand({ lat, lon }), false, `${lat},${lon}`);
  }
});

test("positions deep inland are flagged", () => {
  assert.equal(onLand({ lat: 23, lon: 13 }), true); // Sahara
  assert.equal(onLand({ lat: 48.85, lon: 2.35 }), true); // Paris
  assert.equal(onLand({ lat: 32.0, lon: 54.0 }), true); // central Iran
});

test("region names", () => {
  assert.equal(regionOf({ lat: 26.5, lon: 56.3 }), "Strait of Hormuz");
  assert.equal(regionOf({ lat: 12.6, lon: 43.3 }), "Bab el-Mandeb");
  assert.equal(regionOf({ lat: 0, lon: -30 }), null);
});

test("implied speed between two reports", () => {
  const k = impliedKnots({ lat: 60.08184, lon: 20.9398, at: "2026-11-27T09:26:28Z" }, { lat: 60.0853, lon: 20.80349, at: "2026-11-27T09:40:03Z" });
  assert.ok(k > 15 && k < 22, String(k));
  assert.equal(impliedKnots({ lat: 0, lon: 0, at: "x" }, { lat: 1, lon: 1, at: "y" }), null);
  assert.ok(Math.abs(distanceKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 111.2) < 0.5);
});
