// Geography helpers: distances, implied speed between two position reports, on-land test, region names.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let LAND; // [[ring...]...] polygons, lon/lat, Natural Earth 1:50m (public domain)
let BOXES; // bounding boxes per polygon

function land() {
  if (!LAND) {
    LAND = JSON.parse(readFileSync(join(ROOT, "assets", "land-50m.json"), "utf8"));
    BOXES = LAND.map((poly) => {
      let [x0, y0, x1, y1] = [180, 90, -180, -90];
      for (const [x, y] of poly[0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      return [x0, y0, x1, y1];
    });
  }
  return LAND;
}

const R_KM = 6371.0088;
const rad = (d) => (d * Math.PI) / 180;

export function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Knots needed to get from fix a to fix b in the time between them. null when the times are missing or equal.
export function impliedKnots(a, b) {
  const ta = Date.parse(a.at), tb = Date.parse(b.at);
  if (!Number.isFinite(ta) || !Number.isFinite(tb) || ta === tb) return null;
  const hours = Math.abs(tb - ta) / 3.6e6;
  return distanceKm(a, b) / 1.852 / hours;
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(x, y, poly) {
  if (!inRing(x, y, poly[0])) return false;
  for (let k = 1; k < poly.length; k++) if (inRing(x, y, poly[k])) return false; // holes (lakes, seas inside land)
  return true;
}

// Distance in km from a point to the nearest edge of a polygon's outer ring (flat approximation, fine at this scale).
function distanceToRingKm(lat, lon, ring) {
  const kx = 111.32 * Math.cos(rad(lat)), ky = 110.57;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = (ring[j][0] - lon) * kx, ay = (ring[j][1] - lat) * ky;
    const bx = (ring[i][0] - lon) * kx, by = (ring[i][1] - lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const t = dx || dy ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

// True only when the position is inside a land polygon AND more than `bufferKm` from its coastline.
// The buffer absorbs the coarse 1:50m coastline, ports, rivers and canals, so a ship at a quay is never flagged.
export function onLand({ lat, lon }, bufferKm = 50) {
  if (WATERWAYS.some(([a, b, c, d]) => lat >= a && lat <= c && lon >= b && lon <= d)) return false;
  const polys = land();
  for (let i = 0; i < polys.length; i++) {
    const [x0, y0, x1, y1] = BOXES[i];
    if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
    if (inPolygon(lon, lat, polys[i])) return distanceToRingKm(lat, lon, polys[i][0]) > bufferKm;
  }
  return false;
}

// Ship canals and big inland waterways that the coarse land map draws as land (lat0, lon0, lat1, lon1).
const WATERWAYS = [
  [29.8, 32.1, 31.5, 32.8], // Suez Canal
  [53.8, 9.0, 54.5, 10.3], // Kiel Canal
  [8.8, -80.1, 9.5, -79.4], // Panama Canal
  [44.5, -79.5, 49.5, -66.0], // St Lawrence Seaway
  [47.0, 38.5, 49.0, 44.8], // Volga-Don
  [50.5, 3.5, 52.5, 8.0], // Rhine and Scheldt (Rotterdam, Antwerp, Duisburg)
  [44.0, 22.0, 45.6, 29.8], // Lower Danube
];

// Named sea areas that conflict rumours usually mention (rough boxes: lat0, lon0, lat1, lon1).
const REGIONS = [
  ["Strait of Hormuz", 25.8, 55.6, 27.2, 57.2],
  ["Gulf of Oman", 22.3, 56.5, 25.8, 60.5],
  ["Persian Gulf", 24.0, 48.0, 30.5, 56.5],
  ["Bab el-Mandeb", 12.2, 42.8, 13.2, 43.8],
  ["Red Sea", 13.2, 32.2, 28.0, 43.5],
  ["Gulf of Aden", 10.5, 43.8, 15.0, 51.5],
  ["Suez Canal", 29.8, 32.2, 31.4, 32.7],
  ["Black Sea", 40.8, 27.3, 46.8, 41.8],
  ["Sea of Azov", 45.2, 34.8, 47.3, 39.3],
  ["Gulf of Finland", 59.2, 22.8, 60.8, 30.3],
  ["Baltic Sea", 53.8, 9.5, 66.0, 30.5],
  ["English Channel", 48.5, -5.8, 51.2, 1.8],
  ["Strait of Malacca", 1.0, 95.0, 6.5, 104.0],
  ["Taiwan Strait", 22.0, 117.5, 26.0, 121.0],
  ["South China Sea", 0.0, 105.0, 23.0, 121.0],
  ["Mediterranean", 30.0, -5.6, 46.0, 36.5],
  ["North Sea", 51.0, -4.0, 61.0, 9.5],
];

export function regionOf({ lat, lon }) {
  for (const [name, a, b, c, d] of REGIONS) if (lat >= a && lat <= c && lon >= b && lon <= d) return name;
  return null;
}

export function fmtCoord({ lat, lon }) {
  const ns = lat >= 0 ? "N" : "S", ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(3)}°${ns}, ${Math.abs(lon).toFixed(3)}°${ew}`;
}
