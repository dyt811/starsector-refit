"use strict";
/*
 * Starsector Refit Viewer — vanilla JS, no dependencies.
 *
 * Data: data.json (ships/weapons/hullmods/wings in game coordinates) + lazily
 * fetched sprite shards sprites/ships/<hullId>.json,
 * sprites/weapons/<weaponId>.json and sprites/hullmods/<hullmodId>.json,
 * each {"sprite"|"turret"|"hardpoint"|"icon": "data:image/png;base64,..."}.
 * All fetches fail soft: no sprite -> schematic rendering.
 *
 * Coordinate mapping (verified against the game data):
 *   slots are stored in game coords: x = forward axis, y = lateral axis,
 *   relative to the ship center. Sprite pixels use the same units.
 *     img_x = center_x + slot.y
 *     img_y = (spriteHeight - center_y) - slot.x      (center is bottom-left based)
 * Arc convention (derived empirically, see README): the screen direction of a
 * slot angle a (degrees) is (sin a, -cos a) — compass-style, clockwise on
 * screen, 0 = bow (top of sprite).
 */

// ---------------------------------------------------------------- constants
const TYPE_COLORS = {
  BALLISTIC: "#e8a33d", ENERGY: "#39c2d7", MISSILE: "#7dd069",
  HYBRID: "#d9c05a", COMPOSITE: "#b5cc5e", SYNERGY: "#4fd8c0",
  UNIVERSAL: "#cfd8e3", DECORATIVE: "#5a6a76", BUILT_IN: "#9a6ee8",
  SYSTEM: "#5a6a76", LAUNCH_BAY: "#3f9e58", STATION_MODULE: "#5a6a76",
};
const SIZE_RANK = { SMALL: 1, MEDIUM: 2, LARGE: 3 };
const SIZE_LETTER = { SMALL: "S", MEDIUM: "M", LARGE: "L" };
// Empty-slot glyph radius in world units (1 unit = 1 sprite pixel, the game's
// own scale). Weapon sprites are drawn at native scale — no size bucketing.
const GLYPH_R = { SMALL: 4, MEDIUM: 6, LARGE: 9 };
const DMG_COLORS = {
  KINETIC: "#e8e3d5", HIGH_EXPLOSIVE: "#e8833d", ENERGY: "#39c2d7",
  FRAGMENTATION: "#b8c94e", EMP: "#7d9fe8",
};
const SLOT_FIT = {  // slot type -> weapon mountTypes it accepts
  BALLISTIC: ["BALLISTIC"], ENERGY: ["ENERGY"], MISSILE: ["MISSILE"],
  HYBRID: ["BALLISTIC", "ENERGY"], COMPOSITE: ["BALLISTIC", "MISSILE"],
  SYNERGY: ["ENERGY", "MISSILE"], UNIVERSAL: ["BALLISTIC", "ENERGY", "MISSILE"],
};
const SIZE_ORDER = { CAPITAL_SHIP: 0, CRUISER: 1, DESTROYER: 2, FRIGATE: 3, FIGHTER: 4 };
const LS_BUILDS = "ss-refit-builds";
const LS_CURRENT = "ss-refit-current";

// ---------------------------------------------------------------- state
const S = {
  data: null,
  shipId: null,
  build: null,            // {hullId, name, weapons:{slotId:weaponId}, vents, caps, hullMods:[], wings:[wingId|null per bay]}
  selectedSlot: null,     // slot id string
  pickerOpen: false,      // weapon picker overlay visibility (V5 game flow)
  activeMember: null,     // index into fleet.members for a save-opened ship
  hoverSlot: null,
  sizeFilter: "ALL",
  techFilter: "ALL",
  shipSearch: "",
  weaponSearch: "",
  weaponSort: "op",
  weaponSizeFilter: "ALL",   // weapon picker size chips (ALL/SMALL/MEDIUM/LARGE)
  fleet: null,               // parsed save fleet — session only, never persisted
  flight: null,              // test-flight sandbox state (null unless flying)
  show: { ranges: "selected", sprites: true, labels: false },
  cam: { z: 1, px: 0, py: 0 },   // zoom/pan over the fit transform
  shipImg: null,          // HTMLImageElement | null
  weaponImgs: {},         // `${weaponId}|${mount}` -> HTMLImageElement
  shardCache: {},         // shard path -> Promise<object|null>
  slotScreen: [],         // [{slot, sx, sy}] rebuilt every draw (device px)
  view: null,             // last fit transform {scale, ox, oy, effW, effH}
};

// ---------------------------------------------------------------- helpers
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v))
  ? "—" : Number(v).toLocaleString("en-US", { maximumFractionDigits: d });
const dirVec = (deg) => { const r = deg * Math.PI / 180; return [Math.sin(r), -Math.cos(r)]; };
// Design type ("tech/manufacturer" in the game data). `tech` is the field
// build_data.py emits from the CSV; `manufacturer` is the legacy twin kept
// as a fallback for older data.json files.
const shipTech = (s) => s.tech || s.manufacturer || null;
const techClass = (t) => (t === "Low Tech" ? "low" : t === "Midline" ? "mid"
  : t === "High Tech" ? "high" : "other");

function fetchJSON(path) {
  if (!S.shardCache[path]) {
    S.shardCache[path] = fetch(path)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return S.shardCache[path];
}
function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// ---------------------------------------------------------------- data load
async function init() {
  let data = null;
  try {
    const r = await fetch("data.json");
    if (r.ok) data = await r.json();
  } catch (e) { /* file:// — fall through to picker */ }
  if (!data) {
    $("load-error").hidden = false;
    $("data-file-picker").addEventListener("change", async (ev) => {
      const f = ev.target.files[0];
      if (!f) return;
      try {
        start(JSON.parse(await f.text()));
        $("load-error").hidden = true;
      } catch (e) { alert("That file is not valid JSON."); }
    });
    return;
  }
  start(data);
}

function start(data) {
  S.data = data;
  $("data-version").textContent = "data: " + (data.version || "?");
  $("footer-version").textContent = "· Data version " + (data.version || "?");

  // restore autosave if possible
  let restored = null;
  try { restored = JSON.parse(localStorage.getItem(LS_CURRENT) || "null"); } catch (e) { /* ignore */ }
  let initial = null;
  if (restored && data.ships[restored.shipId]) initial = restored.shipId;
  else if (data.ships["onslaught_xiv"]) initial = "onslaught_xiv";
  else {
    const caps = Object.values(data.ships).filter((s) => s.hullSize === "CAPITAL_SHIP");
    initial = (caps[0] || Object.values(data.ships)[0] || {}).id;
  }
  buildTechChips();
  buildShipList();
  if (initial) {
    selectShip(initial, restored && restored.shipId === initial ? restored.build : null);
  }
  wireUI();
  resizeCanvas();
}

// ---------------------------------------------------------------- ship list
// Sprite thumbnails load lazily as rows scroll into view (268 ships — the
// shards are never all fetched up front).
const thumbObserver = ("IntersectionObserver" in window)
  ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        thumbObserver.unobserve(e.target);
        const key = e.target.dataset.thumb;
        fetchJSON(`sprites/${key}.json`).then((shard) => {
          if (shard && shard.sprite && e.target.isConnected) e.target.src = shard.sprite;
          else if (e.target.isConnected) e.target.style.display = "none";
        });
      }
    }, { root: document.getElementById("ship-list"), rootMargin: "120px" })
  : null;

// Design-type filter chips, derived from the distinct tech values actually
// present in the data (Low Tech / Midline / High Tech pinned first, the rest
// by fleet frequency). Composes with the size filter and the search box.
function buildTechChips() {
  const counts = {};
  for (const s of Object.values(S.data.ships)) {
    const t = shipTech(s);
    if (t) counts[t] = (counts[t] || 0) + 1;
  }
  const pin = ["Low Tech", "Midline", "High Tech"];
  const values = Object.keys(counts).sort((a, b) =>
    (pin.indexOf(a) === -1 ? 99 : pin.indexOf(a)) - (pin.indexOf(b) === -1 ? 99 : pin.indexOf(b))
    || counts[b] - counts[a] || a.localeCompare(b));
  const chip = (v, label) => `<button data-tech="${esc(v)}" class="chip ${S.techFilter === v ? "active" : ""}">${esc(label)}</button>`;
  $("tech-chips").innerHTML = chip("ALL", "All tech") + values.map((v) => chip(v, v)).join("");
  for (const c of $("tech-chips").querySelectorAll(".chip")) {
    c.addEventListener("click", () => {
      S.techFilter = c.dataset.tech;
      for (const o of $("tech-chips").querySelectorAll(".chip")) o.classList.remove("active");
      c.classList.add("active");
      buildShipList();
    });
  }
}

function buildShipList() {
  const q = S.shipSearch.trim().toLowerCase();
  const ships = Object.values(S.data.ships)
    .filter((s) => S.sizeFilter === "ALL" || s.hullSize === S.sizeFilter)
    .filter((s) => S.techFilter === "ALL" || shipTech(s) === S.techFilter)
    .filter((s) => !q || s.name.toLowerCase().includes(q) || s.id.includes(q)
      || (shipTech(s) || "").toLowerCase().includes(q))
    .sort((a, b) => (SIZE_ORDER[a.hullSize] ?? 9) - (SIZE_ORDER[b.hullSize] ?? 9)
      || a.name.localeCompare(b.name));
  $("ship-list").innerHTML = ships.map((s) => { const t = shipTech(s); return `
    <div class="ship-item ${s.id === S.shipId ? "selected" : ""}" data-ship="${esc(s.id)}">
      ${s.sprite ? `<img class="ship-thumb" data-thumb="${esc(s.sprite)}" alt="" loading="lazy">` : ""}
      <span class="nm">${esc(s.name)}</span>
      <span class="sub">${esc(s.designation || (s.hullSize || "").replace("_SHIP", ""))}</span>
      ${t ? `<span class="sub tech-line tech-${techClass(t)}">${esc(t)}</span>` : ""}
      <span class="sub mono">${esc((s.hullSize || "").replace("_SHIP", ""))} · DP ${fmt(s.dp)} · OP ${fmt(s.op)}</span>
    </div>`; }).join("");
  for (const el of $("ship-list").querySelectorAll(".ship-item")) {
    el.addEventListener("click", () => selectShip(el.dataset.ship));
  }
  if (thumbObserver) {
    for (const img of $("ship-list").querySelectorAll("img[data-thumb]")) thumbObserver.observe(img);
  }
}

// ---------------------------------------------------------------- build state
function bayCount(sh) {
  const slotBays = (sh.slots || []).filter((s) => s.type === "LAUNCH_BAY").length;
  return Math.max(slotBays, sh.fighterBays || 0);
}
function wingBayLocked(sh, i) { return i < (sh.builtInWings || []).length; }

function freshBuild(ship) {
  return {
    hullId: ship.id, name: "",
    weapons: { ...ship.builtInWeapons },   // built-ins pre-fitted & locked
    vents: 0, caps: 0, hullMods: [...(ship.builtInMods || [])], smods: [],
    wings: Array.from({ length: bayCount(ship) }, (_, i) => (ship.builtInWings || [])[i] || null),
  };
}
function selectShip(shipId, savedBuild) {
  const ship = S.data.ships[shipId];
  if (!ship) return;
  S.shipId = shipId;
  S.selectedSlot = null;
  S.pickerOpen = false;
  S.activeMember = null;
  S.hoverSlot = null;
  S.weaponSearch = "";
  S.weaponSizeFilter = "ALL";
  resetCam();
  S.shipImg = null;
  S.build = savedBuild && savedBuild.hullId === shipId
    ? { name: "", vents: 0, caps: 0, hullMods: [], smods: [], ...savedBuild }
    : freshBuild(ship);
  // normalize fighter wings against this hull's bays: built-in bays are
  // forced to the built-in wing (locked); other bays keep valid saved picks
  const bw = ship.builtInWings || [];
  const savedWings = Array.isArray(S.build.wings) ? S.build.wings : [];
  S.build.wings = Array.from({ length: bayCount(ship) }, (_, i) =>
    wingBayLocked(ship, i) ? bw[i]
      : (savedWings[i] && S.data.wings && S.data.wings[savedWings[i]] ? savedWings[i] : null));
  buildShipList();
  renderPanel();
  draw();
  renderFleetStrip();
  persistCurrent();
  if (ship.sprite) {
    fetchJSON(`sprites/${ship.sprite}.json`).then(async (shard) => {
      if (S.shipId !== shipId) return;
      if (shard && shard.sprite) {
        S.shipImg = await loadImage(shard.sprite);
        if (S.shipId === shipId) draw();
      }
    });
  }
  // warm weapon images for pre-fitted weapons (with their slot, so
  // hardpoints pick the hardpoint art)
  for (const slot of ship.slots) {
    const wid = S.build.weapons[slot.id];
    if (wid) ensureWeaponImage(wid, slot);
  }
  // switching hulls mid-flight restarts the sandbox on the new hull
  if (S.flight && S.flight.active) resetFlight();
}
function persistCurrent() {
  try {
    localStorage.setItem(LS_CURRENT, JSON.stringify({ shipId: S.shipId, build: S.build }));
  } catch (e) { /* storage full/blocked — non-fatal */ }
}
function ship() { return S.data.ships[S.shipId]; }
function isLocked(slotId) {
  return Object.prototype.hasOwnProperty.call(ship().builtInWeapons || {}, slotId);
}
function fittedWeapon(slot) { return S.data.weapons[S.build.weapons[slot.id]] || null; }

async function ensureWeaponImage(weaponId, slot) {
  const w = S.data.weapons[weaponId];
  if (!w) return;
  const mount = slot && slot.mount === "HARDPOINT" ? "hardpoint" : "turret";
  const key = `${weaponId}|${mount}`;
  if (S.weaponImgs[key]) return;
  const shard = await fetchJSON(`sprites/${w.turretSprite}.json`);
  if (!shard) return;
  const src = shard[mount] || shard.turret || shard.hardpoint;
  if (!src) return;
  const img = await loadImage(src);
  if (img) { S.weaponImgs[key] = img; draw(); }
}

// ---------------------------------------------------------------- OP / flux
// Parameterized so the save-import fleet view can cost out a member's real
// build without loading it into the editor. S-mods (build.smods, from a
// variant's permaMods) cost no OP, like built-ins.
function opBreakdownFor(sh, b) {
  const lockedSlots = sh.builtInWeapons || {};
  let weapons = 0;
  for (const slot of sh.slots) {
    const wid = (b.weapons || {})[slot.id];
    if (wid && !(slot.id in lockedSlots)) weapons += (S.data.weapons[wid] || {}).op || 0;
  }
  let hullmods = 0;
  const smods = new Set(b.smods || []);
  for (const mid of b.hullMods || []) {
    if ((sh.builtInMods || []).includes(mid) || smods.has(mid)) continue;
    const hm = (S.data.hullmods || {})[mid];
    if (!hm) continue;
    const costs = hm.costs || hm.opCost || {};
    hullmods += costs[sh.hullSize] ?? costs.default ?? 0;
  }
  let fighters = 0;
  (b.wings || []).forEach((wid, i) => {
    if (wid && !wingBayLocked(sh, i)) fighters += ((S.data.wings || {})[wid] || {}).op || 0;
  });
  const vents = b.vents || 0, caps = b.caps || 0;
  return {
    weapons, hullmods, fighters, vents, caps,
    total: weapons + hullmods + fighters + vents + caps,
    budget: sh.op || 0,
  };
}
function opBreakdown() { return opBreakdownFor(ship(), S.build); }
function fluxStats() {
  const sh = ship();
  const agg = computeModAgg();
  let perSec = 0, perShotOnly = 0;
  for (const slot of sh.slots) {
    const w = fittedWeapon(slot);
    if (!w) continue;
    if (w.fluxPerSecond) perSec += w.fluxPerSecond;
    else if (w.fluxPerShot) perShotOnly += w.fluxPerShot;
  }
  return {
    weaponPerSec: perSec,
    burstPerShot: perShotOnly,
    // vents/capacitors are flat modifiers of these same stats in the game, so
    // hullmod percent/mult effects (e.g. Safety Overrides x2) scale them too
    dissipation: applyModAgg((sh.fluxDissipation || 0) + 10 * S.build.vents, agg.fluxDissipation),
    capacity: applyModAgg((sh.fluxCapacity || 0) + 100 * S.build.caps, agg.fluxCapacity),
  };
}

// ------------------------------------------------------- hullmod effects
// data.json carries hullmods[id].effects, parsed by build_data.py from the
// game's own hullmod scripts: per stat {flat, percent, mult}, each a number
// or {"bySize": {...}}. Composition follows the stats API semantics:
// (base + flat) * (1 + percent/100) * mult, with the flat/percent/mult
// components of every applicable bonus group summed into one application.
function resolveSpec(spec, hullSize) {
  if (spec === null || spec === undefined) return null;
  if (typeof spec === "number") return spec;
  if (spec.bySize) {
    const v = spec.bySize[hullSize];
    return v === undefined ? null : v;
  }
  return null;
}

function computeModAgg() {
  const sh = ship();
  const agg = { range: {} };
  const addTo = (target, stat) => {
    for (const [kind, spec] of Object.entries(stat)) {
      const v = resolveSpec(spec, sh.hullSize);
      if (v === null) continue;
      if (kind === "mult") target.mult = (target.mult ?? 1) * v;
      else target[kind] = (target[kind] || 0) + v;
    }
  };
  for (const mid of S.build.hullMods) {
    const hm = (S.data.hullmods || {})[mid];
    if (!hm || !hm.effects) continue;
    for (const [key, val] of Object.entries(hm.effects)) {
      if (key === "range") {
        for (const [group, stat] of Object.entries(val)) addTo(agg.range[group] ||= {}, stat);
      } else {
        addTo(agg[key] ||= {}, val);
      }
    }
  }
  return agg;
}

function applyModAgg(base, a) {
  if (base === null || base === undefined || !a) return base;
  return (base + (a.flat || 0)) * (1 + (a.percent || 0) / 100) * (a.mult ?? 1);
}

function effShipStat(key, agg) {
  return applyModAgg(ship()[key], (agg || computeModAgg())[key]);
}

const RANGE_CLASS = { BALLISTIC: "ballistic", ENERGY: "energy", MISSILE: "missile" };
function hasLargeBallisticSlot() {
  return ship().slots.some((s) => s.type === "BALLISTIC" && s.size === "LARGE");
}

// Effective range of a weapon in a specific slot under the installed hullmods.
// Slot context matters: Ballistic Rangefinder only boosts weapons sitting in
// ballistic slots. Returns null for weapons without a range stat.
function effectiveRange(w, slot, agg) {
  if (!w || w.range === null || w.range === undefined) return null;
  agg = agg || computeModAgg();
  const mods = S.build.hullMods;
  const allMods = S.data.hullmods || {};
  let r = w.range;
  // Ballistic Rangefinder: raises BASE range before percent/mult bonuses.
  if (allMods.ballistic_rangefinder && allMods.ballistic_rangefinder.special === "ballistic_rangefinder"
      && mods.includes("ballistic_rangefinder") && slot && slot.type === "BALLISTIC" && !w.pd) {
    if (hasLargeBallisticSlot()) {
      const bonus = slot.size === "SMALL" ? 200 : slot.size === "MEDIUM" ? 100 : 0;
      if (bonus) r = Math.min(r + bonus, 900);
    } else if (slot.size === "SMALL") {
      r = Math.min(r + 100, 800);
    }
  }
  // High Scatter Amplifier: compresses beam BASE range before other bonuses.
  if (allMods.high_scatter_amp && allMods.high_scatter_amp.special === "high_scatter_amp"
      && mods.includes("high_scatter_amp") && w.beam && r > 200) {
    r = 200 + (r - 200) * 0.5;
  }
  const groups = [];
  const ck = RANGE_CLASS[w.mountType];
  if (ck && agg.range[ck]) groups.push(agg.range[ck]);
  if (w.beam && agg.range.beam) groups.push(agg.range.beam);
  if (w.pd) {
    const pk = w.beam ? "pdBeam" : "pdNonBeam";
    if (agg.range[pk]) groups.push(agg.range[pk]);
  }
  if (groups.length) {
    let flat = 0, pct = 0, mult = 1;
    for (const g of groups) {
      flat += g.flat || 0; pct += g.percent || 0; mult *= g.mult ?? 1;
    }
    r = (r + flat) * (1 + pct / 100) * mult;
  }
  // Safety Overrides: range past the threshold counts at multPastThreshold.
  const th = agg.range.threshold, mp = agg.range.multPastThreshold;
  if (th && th.flat !== undefined && r > th.flat) {
    r = th.flat + (r - th.flat) * (mp && mp.mult !== undefined ? mp.mult : 1);
  }
  return r;
}

// ---------------------------------------------------------------- legality
function legalWeapons(slot) {
  const accepts = SLOT_FIT[slot.type];
  if (!accepts) return [];
  const maxRank = SIZE_RANK[slot.size] || 0;
  const list = Object.values(S.data.weapons)
    .filter((w) => w.mountType && accepts.includes(w.mountType)
      && (SIZE_RANK[w.size] || 99) <= maxRank);
  const by = {
    op: (a, b) => (a.op - b.op) || a.name.localeCompare(b.name),
    dps: (a, b) => ((b.damagePerSecond ?? -1) - (a.damagePerSecond ?? -1)) || (a.op - b.op),
    range: (a, b) => ((b.range ?? -1) - (a.range ?? -1)) || (a.op - b.op),
    name: (a, b) => a.name.localeCompare(b.name),
  };
  return list.sort(by[S.weaponSort] || by.op);
}

// ---------------------------------------------------------------- canvas
function resizeCanvas() {
  const cv = $("canvas");
  const r = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(50, Math.round(r.width * dpr));
  cv.height = Math.max(50, Math.round(r.height * dpr));
  draw();
}

function draw() {
  const cv = $("canvas");
  if (!cv || !S.data || !S.shipId) return;
  if (S.flight && S.flight.active) { drawFlight(); return; }
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, W, H);
  const sh = ship();
  const agg = computeModAgg();

  // effective sprite dims: loaded image wins, else .ship width/height, else collision circle
  const effW = S.shipImg ? S.shipImg.naturalWidth : (sh.width || (sh.collisionRadius || 100) * 2);
  const effH = S.shipImg ? S.shipImg.naturalHeight : (sh.height || (sh.collisionRadius || 100) * 2);
  const fitScale = Math.min((W - 30) / effW, (H - 30) / effH);
  const fitOx = W / 2 - (effW / 2) * fitScale;
  const fitOy = H / 2 - (effH / 2) * fitScale;
  S.view = { scale: fitScale, ox: fitOx, oy: fitOy, effW, effH };

  // camera (wheel zoom / drag pan) applied over the fit transform
  const { z, px, py } = S.cam;
  const scale = fitScale * z;                  // device px per world unit
  const ox = (fitOx - W / 2) * z + W / 2 + px; // screen pos of sprite top-left
  const oy = (fitOy - H / 2) * z + H / 2 + py;

  const slotXY = (slot) => {
    const wx = sh.center[0] + slot.y;
    const wy = (effH - sh.center[1]) - slot.x;
    return [ox + wx * scale, oy + wy * scale];
  };
  const centerXY = [ox + sh.center[0] * scale, oy + (effH - sh.center[1]) * scale];

  // ---- blueprint grid (the game's refit stage sits on one)
  const step = 50 * scale;
  if (step > 9) {
    ctx.save();
    ctx.strokeStyle = "rgba(120,170,200,.07)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = centerXY[0] % step; x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = centerXY[1] % step; y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    ctx.restore();
  }

  // ---- hull: sprite or schematic
  if (S.shipImg) {
    ctx.drawImage(S.shipImg, ox, oy, effW * scale, effH * scale);
  } else {
    // schematic: tapered hull silhouette + collision circle, bow up
    const cx = ox + (effW / 2) * scale, cy = oy + (effH / 2) * scale;
    ctx.save();
    ctx.strokeStyle = "rgba(57,194,215,.35)";
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.arc(cx, cy, (sh.collisionRadius || effW / 2) * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(38,57,74,.55)";
    ctx.strokeStyle = "#39c2d7";
    const hw = (effW / 2) * scale, hh = (effH / 2) * scale;
    ctx.beginPath();
    ctx.moveTo(cx, cy - hh);                       // bow
    ctx.lineTo(cx + hw * 0.82, cy - hh * 0.35);
    ctx.lineTo(cx + hw, cy + hh * 0.55);
    ctx.lineTo(cx + hw * 0.72, cy + hh);
    ctx.lineTo(cx - hw * 0.72, cy + hh);
    ctx.lineTo(cx - hw, cy + hh * 0.55);
    ctx.lineTo(cx - hw * 0.82, cy - hh * 0.35);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = "rgba(201,214,223,.7)";
    ctx.font = `${Math.max(10, 11 * dpr)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("schematic — sprite not in local data pull", cx, cy + hh + 16);
    ctx.restore();
  }

  S.slotScreen = sh.slots.map((slot) => {
    const [sx, sy] = slotXY(slot);
    return { slot, sx, sy };
  });

  // ---- range wedges at EFFECTIVE range (live with hullmods), under sprites
  const wedge = (sx, sy, slot, rangeWorld, color, alpha, ring) => {
    const R = rangeWorld * scale;
    const a0 = (slot.angle - slot.arc / 2) * Math.PI / 180;
    const a1 = (slot.angle + slot.arc / 2) * Math.PI / 180;
    // canvas arc angles: atan2 of dirVec = atan2(-cos, sin)
    const c0 = Math.atan2(-Math.cos(a0), Math.sin(a0));
    const c1 = Math.atan2(-Math.cos(a1), Math.sin(a1));
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.arc(sx, sy, R, c0, c1, false);
    ctx.closePath();
    ctx.fillStyle = color; ctx.globalAlpha = alpha; ctx.fill(); ctx.globalAlpha = 1;
    if (ring) {
      ctx.beginPath();
      ctx.arc(sx, sy, R, c0, c1, false);
      ctx.strokeStyle = color; ctx.globalAlpha = 0.85;
      ctx.lineWidth = Math.max(1.2, dpr); ctx.stroke(); ctx.globalAlpha = 1;
    }
  };
  const mode = S.show.ranges;
  if (mode !== "off") {
    for (const { slot, sx, sy } of S.slotScreen) {
      if (slot.type === "DECORATIVE" || slot.type === "SYSTEM" || slot.type === "LAUNCH_BAY") continue;
      const isSel = S.selectedSlot === slot.id;
      if (mode === "selected" && !isSel) continue;
      const w = fittedWeapon(slot);
      const col = TYPE_COLORS[slot.type] || "#888";
      if (w) {
        const r = effectiveRange(w, slot, agg);
        if (r === null) continue;
        if (isSel) {
          wedge(sx, sy, slot, r, col, 0.15, true);
          const [dx, dy] = dirVec(slot.angle);
          const tx = sx + dx * r * scale, ty = sy + dy * r * scale;
          const label = fmt(Math.round(r));
          ctx.font = `${Math.round(11 * dpr)}px ui-monospace, monospace`;
          ctx.textAlign = "center";
          const tw = ctx.measureText(label).width + 9 * dpr;
          ctx.fillStyle = "rgba(6,12,18,.78)";
          ctx.fillRect(tx - tw / 2, ty - 8 * dpr, tw, 16 * dpr);
          ctx.fillStyle = "#e8f4f8";
          ctx.fillText(label, tx, ty + 4 * dpr);
        } else {
          wedge(sx, sy, slot, r, col, 0.06, false);
        }
      } else if (isSel) {
        // unfitted selected slot: nominal wedge to show facing/arc
        wedge(sx, sy, slot, Math.max(30, 0.4 * (sh.collisionRadius || 100)), col, 0.12, false);
      }
    }
  }

  // ---- weapon sprites at NATIVE scale (1 sprite px = 1 world unit) and
  // ---- game-style glyphs for empty slots
  for (const { slot, sx, sy } of S.slotScreen) {
    const w = fittedWeapon(slot);
    const isSel = S.selectedSlot === slot.id;
    const isHover = S.hoverSlot === slot.id;
    const col = TYPE_COLORS[w ? w.mountType : slot.type] || TYPE_COLORS[slot.type] || "#888";
    let drewSprite = false;
    if (w && S.show.sprites) {
      const img = S.weaponImgs[`${w.id}|${slot.mount === "HARDPOINT" ? "hardpoint" : "turret"}`];
      if (img) {
        const pw = img.naturalWidth * scale, ph = img.naturalHeight * scale;
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(slot.angle * Math.PI / 180);
        ctx.drawImage(img, -pw / 2, -ph / 2, pw, ph);
        ctx.restore();
        // thin square outline around the fitted weapon, as on the game's stage
        const side = Math.max(pw, ph) + 3 * dpr;
        ctx.save();
        ctx.strokeStyle = isSel ? "#ffffff" : col;
        ctx.globalAlpha = isSel ? 0.95 : isHover ? 0.8 : 0.4;
        ctx.lineWidth = Math.max(1, dpr * (isSel ? 1.5 : 1));
        ctx.strokeRect(sx - side / 2, sy - side / 2, side, side);
        ctx.restore();
        drewSprite = true;
      }
    }
    if (!drewSprite) {
      const r = Math.max((GLYPH_R[slot.size] || 5) * scale, 2.2 * dpr);
      drawSlotGlyph(ctx, slot, sx, sy, r, col,
        { fitted: !!w, selected: isSel, hover: isHover, dpr });
    }
    if (S.show.labels) {
      ctx.fillStyle = "rgba(220,235,242,.85)";
      ctx.font = `${Math.round(10 * dpr)}px sans-serif`;
      ctx.textAlign = "left";
      ctx.fillText(slot.id, sx + 10 * dpr, sy + 3 * dpr);
    }
  }
}

// Game-style empty-slot glyphs, colored by slot type, sized by slot size:
// turret = ring + center dot; hardpoint = directional trapezoid along the
// slot facing; launch bay = rounded-rectangle outline; decorative = faint dot.
function drawSlotGlyph(ctx, slot, sx, sy, r, color, o) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.1, o.dpr * 1.1);
  ctx.globalAlpha = o.selected ? 1 : o.hover ? 0.95 : o.fitted ? 0.9 : 0.68;
  if (slot.type === "DECORATIVE") {
    ctx.globalAlpha *= 0.5;
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(r * 0.35, 1.2), 0, Math.PI * 2);
    ctx.fill();
  } else if (slot.type === "LAUNCH_BAY") {
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(slot.angle * Math.PI / 180);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(-r * 1.5, -r, r * 3, r * 2, Math.min(3 * o.dpr, r * 0.45));
    else ctx.rect(-r * 1.5, -r, r * 3, r * 2);
    ctx.stroke();
    ctx.restore();
  } else if (slot.mount === "HARDPOINT") {
    const [dx, dy] = dirVec(slot.angle);
    const qx = -dy, qy = dx;   // perpendicular
    const fx = sx + dx * r * 1.2, fy = sy + dy * r * 1.2;   // muzzle end
    const bx = sx - dx * r * 1.2, by = sy - dy * r * 1.2;   // breech end
    ctx.beginPath();
    ctx.moveTo(bx + qx * r * 0.85, by + qy * r * 0.85);
    ctx.lineTo(fx + qx * r * 0.4, fy + qy * r * 0.4);
    ctx.lineTo(fx - qx * r * 0.4, fy - qy * r * 0.4);
    ctx.lineTo(bx - qx * r * 0.85, by - qy * r * 0.85);
    ctx.closePath();
    ctx.globalAlpha *= 0.4; ctx.fill();
    ctx.globalAlpha = o.selected ? 1 : o.hover ? 0.95 : o.fitted ? 0.9 : 0.68;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(r * 0.2, 1), 0, Math.PI * 2);
    ctx.fill();
  } else {
    // turret (and built-in/system/station slots): ring + center dot
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(r * 0.28, 1.1), 0, Math.PI * 2);
    ctx.fill();
  }
  if (o.selected) {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.max(1.4, o.dpr * 1.4);
    ctx.beginPath();
    ctx.arc(sx, sy, r + 3.5 * o.dpr, 0, Math.PI * 2);
    ctx.stroke();
  } else if (o.hover) {
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.max(1, o.dpr);
    ctx.beginPath();
    ctx.arc(sx, sy, r + 3 * o.dpr, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function slotAt(mx, my) {
  const scale = S.view ? S.view.scale * S.cam.z : 1;
  let best = null, bestD = Infinity;
  for (const s of S.slotScreen) {
    const d = Math.hypot(s.sx - mx, s.sy - my);
    const hit = Math.max(16, (GLYPH_R[s.slot.size] || 5) * scale + 6);
    if (d < hit && d < bestD) { bestD = d; best = s.slot; }
  }
  return best;
}

// ---------------------------------------------------------------- camera
function resetCam() { S.cam = { z: 1, px: 0, py: 0 }; }
function zoomAt(cxCss, cyCss, factor) {
  const cv = $("canvas");
  const dpr = window.devicePixelRatio || 1;
  const W = cv.width, H = cv.height;
  const cx = cxCss * dpr, cy = cyCss * dpr;
  const z2 = Math.min(5, Math.max(0.08, S.cam.z * factor));
  if (z2 === S.cam.z) return;
  // keep the world point under the cursor fixed on screen
  const fx = (cx - S.cam.px - W / 2) / S.cam.z + W / 2;
  const fy = (cy - S.cam.py - H / 2) / S.cam.z + H / 2;
  S.cam.px = cx - (fx - W / 2) * z2 - W / 2;
  S.cam.py = cy - (fy - H / 2) * z2 - H / 2;
  S.cam.z = z2;
  draw();
}
function fitRange() {
  const cv = $("canvas");
  if (!cv || !S.view) return;
  const sh = ship();
  const agg = computeModAgg();
  let maxR = 0;
  for (const slot of sh.slots) {
    const w = fittedWeapon(slot);
    if (w) maxR = Math.max(maxR, effectiveRange(w, slot, agg) || 0);
  }
  if (!maxR) {
    const sel = sh.slots.find((s) => s.id === S.selectedSlot);
    const w = sel && fittedWeapon(sel);
    if (w) maxR = effectiveRange(w, sel, agg) || 0;
  }
  if (!maxR) { resetCam(); draw(); return; }
  const W = cv.width, H = cv.height;
  const dpr = window.devicePixelRatio || 1;
  const rPx = maxR * S.view.scale;
  const z = Math.min(1, Math.max(0.08, (Math.min(W, H) / 2 - 26 * dpr) / rPx));
  // center the ship's center on screen at this zoom; pan mirrors draw():
  // screen = (fit - C) * z + C + pan, so pan = C - ((fitPt - C) * z + C) + C
  const scx = S.view.ox + sh.center[0] * S.view.scale;
  const scy = S.view.oy + (S.view.effH - sh.center[1]) * S.view.scale;
  S.cam = {
    z,
    px: W / 2 - ((scx - W / 2) * z + W / 2),
    py: H / 2 - ((scy - H / 2) * z + H / 2),
  };
  draw();
}

// ---------------------------------------------------------------- panel
// Game-style weapon spec card: sprite (correct art for the slot's mount),
// size/type pips, and a two-column stat grid like the game's weapon card.
// Range shows base -> effective when hullmods modify it for this slot.
function weaponCard(w, slot, agg, isFitted) {
  const effR = effectiveRange(w, slot, agg);
  const rangeCell = (effR !== null && w.range !== null && w.range !== undefined
      && Math.abs(effR - w.range) > 0.5)
    ? `${fmt(w.range)} → <b>${fmt(Math.round(effR))}</b>` : fmt(w.range);
  const rows = [];
  const row = (k, v) => { if (v !== null && v !== undefined && v !== "") rows.push(`<span class="k">${k}</span><span class="v">${v}</span>`); };
  row("Range", rangeCell);
  row("Damage", w.damagePerShot
    ? `${fmt(w.damagePerShot)}${w.damagePerSecond ? ` (${fmt(w.damagePerSecond)}/s)` : ""}`
    : (w.damagePerSecond ? `${fmt(w.damagePerSecond)}/s` : null));
  row("Damage type", w.damageType
    ? `<span style="color:${DMG_COLORS[w.damageType] || "#cfe3ec"}">${esc(w.damageType.replace(/_/g, " "))}</span>` : null);
  if (w.empDamage) row("EMP damage", fmt(w.empDamage));
  row("Flux/shot", w.fluxPerShot ? fmt(w.fluxPerShot) : null);
  row("Flux/sec", w.fluxPerSecond ? fmt(w.fluxPerSecond) : null);
  if (w.ammo) row("Ammo", fmt(w.ammo));
  if (w.burstSize && w.burstSize > 1)
    row("Burst", `${fmt(w.burstSize)}${w.burstDelay ? ` · ${fmt(w.burstDelay, 2)}s apart` : ""}`);
  row("Projectile", w.beam ? "beam" : (w.projSpeed ? fmt(w.projSpeed) : null));
  if (w.turnRate) row("Turn rate", `${fmt(w.turnRate)}°/s`);
  return `
    <div class="weapon-card ${isFitted ? "fitted" : ""}" data-fit="${esc(w.id)}" ${isFitted ? "" : 'title="Click to fit"'}>
      <div class="wc-head">
        <img class="wc-img" data-wimg="${esc(w.id)}" alt="">
        <div class="wc-title">
          <span class="wc-name">${esc(w.name)}</span>
          <span class="pips">
            <span class="pip size">${esc(SIZE_LETTER[w.size] || "?")}</span><span class="pip type" style="background:${TYPE_COLORS[w.mountType] || "#888"}">${esc(w.mountType || "")}</span>${w.pd ? '<span class="pip pd">PD</span>' : ""}${w.beam ? '<span class="pip beam">BEAM</span>' : ""}
          </span>
          ${w.role ? `<span class="wc-role">${esc(w.role)}</span>` : ""}
        </div>
        <span class="wc-op">${fmt(w.op)} OP</span>
      </div>
      <div class="wc-grid">${rows.join("")}</div>
      ${w.desc ? `<div class="wc-desc">${esc(w.desc)}</div>` : ""}
    </div>`;
}

function hydrateWeaponCards(slot) {
  const mount = slot && slot.mount === "HARDPOINT" ? "hardpoint" : "turret";
  for (const img of document.querySelectorAll("img[data-wimg]")) {
    const w = S.data.weapons[img.dataset.wimg];
    if (!w) { img.remove(); continue; }
    fetchJSON(`sprites/${w.turretSprite}.json`).then((shard) => {
      const src = shard && (shard[mount] || shard.turret || shard.hardpoint);
      if (src && img.isConnected) img.src = src;
      else if (img.isConnected) img.style.display = "none";
    });
  }
}

// Why a hullmod cannot be installed right now (game rules from its script's
// isApplicableToShip: size limits and mutual exclusions), or null.
function hullmodBlockReason(hm, sh) {
  if (hm.onlySizes && !hm.onlySizes.includes(sh.hullSize))
    return `Only for ${hm.onlySizes.map((s) => s.replace("_SHIP", "").toLowerCase()).join(" / ")} ships`;
  if ((hm.blockedSizes || []).includes(sh.hullSize))
    return `Not available on ${sh.hullSize.replace("_SHIP", "").toLowerCase()} ships`;
  if (!S.build.hullMods.includes(hm.id)) {
    const conflicts = (hm.incompatibleWith || [])
      .filter((x) => x !== hm.id && S.build.hullMods.includes(x));
    if (conflicts.length) {
      const names = conflicts.map((x) => (S.data.hullmods[x] || {}).name || x).join(", ");
      return `Incompatible with ${names}`;
    }
  }
  return null;
}

const RANGE_GROUP_LABELS = {
  ballistic: "Ballistic range", energy: "Energy range", missile: "Missile range",
  beam: "Beam range", pdNonBeam: "PD range", pdBeam: "PD beam range",
};
const STAT_LABELS = {
  fluxCapacity: "Flux capacity", fluxDissipation: "Flux dissipation", armor: "Armor",
  maxSpeed: "Max speed", acceleration: "Acceleration", deceleration: "Deceleration",
  maxTurnRate: "Turn rate", turnAcceleration: "Turn accel",
};
function effectsSummary(hm, hullSize) {
  const parts = [];
  if (hm.effects) {
    const statBits = (stat) => {
      const bits = [];
      for (const kind of ["flat", "percent", "mult"]) {
        if (stat[kind] === undefined) continue;
        const v = resolveSpec(stat[kind], hullSize);
        if (v === null) continue;
        bits.push(kind === "flat" ? `${v > 0 ? "+" : ""}${fmt(v)}`
          : kind === "percent" ? `${v > 0 ? "+" : ""}${fmt(v)}%` : `×${fmt(v, 2)}`);
      }
      return bits.join(" ");
    };
    for (const [key, val] of Object.entries(hm.effects)) {
      if (key === "range") {
        for (const [g, stat] of Object.entries(val)) {
          if (g === "threshold") {
            const v = resolveSpec(stat.flat, hullSize);
            if (v !== null && v !== undefined) parts.push(`Range threshold ${fmt(v)}`);
          } else if (g === "multPastThreshold") {
            const v = resolveSpec(stat.mult, hullSize);
            if (v !== null && v !== undefined) parts.push(`×${fmt(v, 2)} past threshold`);
          } else {
            const b = statBits(stat);
            if (b) parts.push(`${RANGE_GROUP_LABELS[g] || g} ${b}`);
          }
        }
      } else {
        const b = statBits(val);
        if (b) parts.push(`${STAT_LABELS[key] || key} ${b}`);
      }
    }
  }
  if (hm.special === "ballistic_rangefinder")
    parts.push("Ballistic-slot weapons: small/medium base range up");
  if (hm.special === "high_scatter_amp")
    parts.push("Beam base range compressed toward 200");
  return parts.slice(0, 4).join(" · ");
}

// ---------------------------------------------------------------- picker
// The weapon picker is an overlay that slides in over the stage when a
// slot is clicked (the game's flow): the slot's current weapon is pinned
// at the top as a full spec card, legal weapons are compact rows, and
// hovering or keyboard-focusing a row floats its full spec card beside
// it, game-tooltip style. Fitting a weapon closes the picker; Esc or a
// click on empty stage closes it without changes.
function weaponRow(w, slot, isFitted) {
  const bits = [];
  if (w.range !== null && w.range !== undefined) bits.push(`Rng ${fmt(w.range)}`);
  if (w.damagePerSecond) bits.push(`DPS ${fmt(w.damagePerSecond)}`);
  else if (w.damagePerShot) bits.push(`${fmt(w.damagePerShot)}/shot`);
  return `
    <div class="weapon-row2 ${isFitted ? "fitted" : ""}" data-fit="${esc(w.id)}" tabindex="0" role="button"
         aria-label="Fit ${esc(w.name)}">
      <img class="wr-img" data-wimg="${esc(w.id)}" alt="">
      <span class="wr-main">
        <span class="wr-name">${esc(w.name)}</span>
        <span class="wr-sub">${esc(SIZE_LETTER[w.size] || "?")} · ${esc(w.mountType || "")}${w.pd ? " · PD" : ""}${w.beam ? " · BEAM" : ""}${bits.length ? " · " + esc(bits.join(" · ")) : ""}</span>
      </span>
      <span class="wr-op">${fmt(w.op)} OP</span>
    </div>`;
}

function showSpecFloat(w, slot, anchorEl) {
  const fl = $("spec-float");
  if (!fl || !w || !anchorEl) return;
  fl.innerHTML = weaponCard(w, slot, computeModAgg(), S.build.weapons[slot.id] === w.id);
  hydrateWeaponCards(slot);
  fl.hidden = false;
  const r = anchorEl.getBoundingClientRect();
  const fw = fl.offsetWidth, fh = fl.offsetHeight;
  let left = r.left - fw - 10;
  if (left < 8) left = Math.min(r.right + 10, window.innerWidth - fw - 8);
  let top = r.top;
  if (top + fh > window.innerHeight - 8) top = window.innerHeight - fh - 8;
  fl.style.left = Math.max(8, left) + "px";
  fl.style.top = Math.max(8, top) + "px";
}
function hideSpecFloat() {
  const fl = $("spec-float");
  if (fl) fl.hidden = true;
}

function closePicker() { S.pickerOpen = false; hideSpecFloat(); }
function fitFromPicker(slotId, weaponId) {
  // game behavior adapted: choosing a weapon fits it and closes the list
  closePicker();
  fitWeapon(slotId, weaponId);
}

function renderPicker() {
  const pk = $("picker");
  const head = $("picker-head"), pinned = $("picker-pinned");
  const controls = $("picker-controls"), list = $("picker-list");
  const sh = ship();
  const sel = sh ? sh.slots.find((s) => s.id === S.selectedSlot) || null : null;
  if (!S.pickerOpen || !sel) {
    pk.classList.remove("open");
    head.innerHTML = ""; pinned.innerHTML = ""; controls.innerHTML = ""; list.innerHTML = "";
    hideSpecFloat();
    return;
  }
  pk.classList.add("open");
  const agg = computeModAgg();
  const locked = isLocked(sel.id);
  const w = fittedWeapon(sel);
  head.innerHTML = `
    <div>
      <div class="pk-title">Weapon slot</div>
      <div class="slot-head"><b>${esc(sel.id)}</b> — ${esc(sel.type)} / ${esc(sel.size || "")} / ${esc(sel.mount || "")}
        · arc ${fmt(sel.arc)}° @ ${fmt(sel.angle)}° ${locked ? '<span class="locked">[built-in, locked]</span>' : ""}</div>
    </div>
    <button id="picker-close" title="Close (Esc)">✕</button>`;
  pinned.innerHTML = (w ? weaponCard(w, sel, agg, true) : "")
    + (locked
      ? `<div class="note">Built-in weapon — cannot be changed.</div>`
      : w
        ? `<div class="build-row"><button data-action="empty-slot">Remove weapon</button>
             <span class="note">…or right-click the slot on the ship, or this card, to clear it.</span></div>`
        : `<div class="note">Empty slot — pick a weapon below.</div>`);
  if (locked || !SLOT_FIT[sel.type]) {
    controls.innerHTML = "";
    list.innerHTML = locked ? ""
      : `<div class="note picker-note">${esc(sel.type)} slots cannot be fitted with weapons.</div>`;
    return;
  }
  const legal = legalWeapons(sel)
    .filter((x) => S.weaponSizeFilter === "ALL" || x.size === S.weaponSizeFilter)
    .filter((x) => !S.weaponSearch
      || x.name.toLowerCase().includes(S.weaponSearch.toLowerCase())
      || x.id.includes(S.weaponSearch.toLowerCase()));
  const sortOpt = (v, label) =>
    `<option value="${v}" ${S.weaponSort === v ? "selected" : ""}>${label}</option>`;
  // size chips reflect the slot's capacity: sizes too big for the slot are
  // hidden entirely (a SMALL slot offers only All + Small)
  const maxRank = SIZE_RANK[sel.size] || 3;
  const chipSizes = ["ALL", ...["SMALL", "MEDIUM", "LARGE"].filter((s) => SIZE_RANK[s] <= maxRank)];
  if (!chipSizes.includes(S.weaponSizeFilter)) S.weaponSizeFilter = "ALL";
  controls.innerHTML = `
    <div class="weapon-controls">
      <input class="weapon-search" id="weapon-search" type="search" placeholder="Search weapons..."
             value="${esc(S.weaponSearch)}" autocomplete="off">
      <select id="weapon-sort" title="Sort weapons">
        ${sortOpt("op", "Sort: OP")}${sortOpt("dps", "Sort: DPS")}
        ${sortOpt("range", "Sort: Range")}${sortOpt("name", "Sort: Name")}
      </select>
    </div>
    <div class="weapon-size-chips">
      ${chipSizes.map((s) => `<button class="chip ${S.weaponSizeFilter === s ? "active" : ""}" data-wsize="${s}">${s === "ALL" ? "All" : s.charAt(0) + s.slice(1).toLowerCase()}</button>`).join("")}
    </div>`;
  list.innerHTML = legal.map((x) => weaponRow(x, sel, !!(w && w.id === x.id))).join("")
    || '<div class="note" style="padding:6px">No legal weapons match.</div>';
}

// ---------------------------------------------------------------- panels
// Left column (game order): identity, OP bar, primary stats, stat grid,
// logistics, flux with the Capacitors/Vents steppers inline.
function renderInfo() {
  const sh = ship();
  if (!sh) return;
  const op = opBreakdown();
  const fx = fluxStats();
  const agg = computeModAgg();
  const over = op.total > op.budget;
  const statRow = (label, base, eff, d = 0) => {
    if (base === null || base === undefined)
      return `<span class="k">${label}</span><span class="v">—</span>`;
    if (eff === null || eff === undefined || Math.abs(eff - base) < 0.05)
      return `<span class="k">${label}</span><span class="v">${fmt(base, d)}</span>`;
    const delta = eff - base;
    return `<span class="k">${label}</span><span class="v eff">${fmt(Math.round(eff * 10) / 10, d)} `
      + `<span class="delta ${delta > 0 ? "pos" : "neg"}">(${delta > 0 ? "+" : ""}${fmt(Math.round(delta * 10) / 10, d)})</span></span>`;
  };
  const primaryCard = (label, base, eff, cls) => {
    if (base === null || base === undefined)
      return `<div class="pstat ${cls}"><span class="pk">${label}</span><span class="pv">—</span></div>`;
    if (eff === null || eff === undefined || Math.abs(eff - base) < 0.05)
      return `<div class="pstat ${cls}"><span class="pk">${label}</span><span class="pv">${fmt(Math.round(base * 10) / 10)}</span></div>`;
    const delta = eff - base;
    return `<div class="pstat ${cls}"><span class="pk">${label}</span><span class="pv">${fmt(Math.round(eff * 10) / 10)} `
      + `<span class="delta ${delta > 0 ? "pos" : "neg"}">${delta > 0 ? "+" : ""}${fmt(Math.round(delta * 10) / 10)}</span></span></div>`;
  };
  const lv = (v, suffix = "", d = 0) =>
    (v === null || v === undefined ? "—" : fmt(v, d) + suffix);
  const tech = shipTech(sh);

  $("info-content").innerHTML = `
    <h2>${esc(sh.name)}${tech ? ` <span class="tech-badge tech-${techClass(tech)}">${esc(tech)}</span>` : ""}</h2>
    <div class="ship-sub">${esc(sh.designation || "")}${sh.designation && sh.manufacturer ? " · " : ""}${esc(sh.manufacturer || "")}
      · ${esc((sh.hullSize || "").replace(/_/g, " "))}${sh.isSkin ? ` · skin of ${esc(sh.baseHullId)}` : ""}</div>

    <h3>Ordnance Points</h3>
    <div class="opbar ${over ? "over" : ""}">
      <div class="opfill" style="width:${Math.min(100, (op.total / Math.max(op.budget, 1)) * 100)}%"></div>
      <span class="optext">${op.total} / ${op.budget} OP</span>
    </div>
    <div class="op-legend ${over ? "over-text" : ""}">weapons <b>${op.weapons}</b>
      · hullmods <b>${op.hullmods}</b> · fighters <b>${op.fighters}</b>
      · vents <b>${op.vents}</b> · caps <b>${op.caps}</b>${over ? " · OVER BUDGET" : ""}</div>

    <div class="primary-stats">
      ${primaryCard("Max speed", sh.maxSpeed, effShipStat("maxSpeed", agg), "a-spd")}
      ${primaryCard("Flux capacity", sh.fluxCapacity, fx.capacity, "a-cap")}
      ${primaryCard("Flux dissipation", sh.fluxDissipation, fx.dissipation, "a-diss")}
    </div>
    <div class="stats-grid">
      <span class="k">Deployment pts</span><span class="v">${fmt(sh.dp)}</span>
      <span class="k">Ordnance pts</span><span class="v">${fmt(sh.op)}</span>
      <span class="k">Hitpoints</span><span class="v">${fmt(sh.hitpoints)}</span>
      ${statRow("Armor", sh.armor, effShipStat("armor", agg))}
      ${statRow("Acceleration", sh.acceleration, effShipStat("acceleration", agg))}
      ${statRow("Deceleration", sh.deceleration, effShipStat("deceleration", agg))}
      ${statRow("Max turn rate", sh.maxTurnRate, effShipStat("maxTurnRate", agg), 1)}
      ${statRow("Turn acceleration", sh.turnAcceleration, effShipStat("turnAcceleration", agg), 1)}
      ${sh.shieldType === "PHASE"
        ? `<span class="k">Phase cost</span><span class="v">${fmt(sh.phaseCost, 3)}</span>`
        : `<span class="k">Shield</span><span class="v">${esc(sh.shieldType || "NONE")}${sh.shieldArc ? ` ${fmt(sh.shieldArc)}°` : ""}${sh.shieldEfficiency ? ` · eff ${fmt(sh.shieldEfficiency, 2)}` : ""}</span>`}
      <span class="k">System</span><span class="v">${esc(sh.systemId || "—")}</span>
      <span class="k">Base value</span><span class="v">${fmt(sh.baseValue)} cr</span>
    </div>

    <h3>Flux</h3>
    <div class="stats-grid">
      <span class="k">Weapon flux/s</span><span class="v">${fmt(fx.weaponPerSec)}</span>
      <span class="k">Dissipation</span><span class="v">${fmt(fx.dissipation)}</span>
      <span class="k">Capacity</span><span class="v">${fmt(fx.capacity)}</span>
    </div>
    <div class="note">${fx.weaponPerSec <= fx.dissipation
      ? '<span class="flux-ok">● Flux-neutral on weapons</span>'
      : `<span class="flux-bad">● Over-fluxing by ${fmt(fx.weaponPerSec - fx.dissipation)}/s</span>`}
      ${fx.burstPerShot ? `<br>≈ plus ${fmt(fx.burstPerShot)} flux/shot from burst weapons (not counted in flux/s — their CSV flux/s is blank)` : ""}
    </div>
    <div class="build-row" style="align-items:center; margin-top:8px">
      <span class="stepper">Vents
        <button data-step="vents|-1">−</button><span class="val">${S.build.vents}</span><button data-step="vents|1">+</button>
      </span>
      <span class="stepper">Capacitors
        <button data-step="caps|-1">−</button><span class="val">${S.build.caps}</span><button data-step="caps|1">+</button>
      </span>
    </div>
    <div class="note">1 OP each. +10 dissipation per vent, +100 capacity per capacitor. (Real saves run past 50 vents on capitals; the editor allows up to 99.)</div>

    <h3>Logistics</h3>
    <div class="stats-grid">
      <span class="k">Fuel capacity</span><span class="v">${lv(sh.fuelCapacity)}</span>
      <span class="k">Fuel / ly</span><span class="v">${lv(sh.fuelPerLy, "", 1)}</span>
      ${statRow("Max burn", sh.maxBurn, effShipStat("maxBurn", agg))}
      <span class="k">Cargo</span><span class="v">${lv(sh.cargo)}</span>
      <span class="k">Crew</span><span class="v">${sh.minCrew === null || sh.minCrew === undefined ? "—" : `${fmt(sh.minCrew)} – ${fmt(sh.maxCrew)}`}</span>
      <span class="k">Upkeep</span><span class="v">${lv(sh.suppliesPerMonth, "/mo")}</span>
      <span class="k">Supplies to recover</span><span class="v">${lv(sh.suppliesRec)}</span>
      <span class="k">CR to deploy</span><span class="v">${lv(sh.crToDeploy, "%")}</span>
      <span class="k">CR per day</span><span class="v">${lv(sh.crPerDay, "%")}</span>
      <span class="k">Peak CR time</span><span class="v">${lv(sh.peakCrSec, " s")}</span>
    </div>
  `;
}

// Right column: "Hull features & mods" (built-ins first, greyed/locked),
// then installed/available mods, then the launch-bay fighter pickers.
function renderMods() {
  const sh = ship();
  if (!sh) return;
  let html = `<h3>Hull features &amp; mods</h3>`;
  const allMods = S.data.hullmods || {};
  if (!Object.keys(allMods).length) {
    html += `<div class="note">Hullmod data pending — arrives with the next data pull.</div>`;
    if (S.build.hullMods.length) {
      html += `<div class="note">Installed (built-in): ${S.build.hullMods.map(esc).join(", ")}</div>`;
    }
  } else {
    // picker rules: hiddenEverywhere mods are excluded; hidden mods appear
    // only when built into (or already installed on) this hull; built-ins are
    // pre-checked, locked, and cost no OP
    const builtIns = sh.builtInMods || [];
    const visible = Object.values(allMods)
      .filter((hm) => builtIns.includes(hm.id) || S.build.hullMods.includes(hm.id)
        || (!hm.hidden && !hm.hiddenEverywhere))
      .sort((a, b) =>
        (builtIns.includes(b.id) ? 1 : 0) - (builtIns.includes(a.id) ? 1 : 0)
        || a.name.localeCompare(b.name));
    html += `<div class="hullmod-list">` + visible.map((hm) => {
      const cost = (hm.costs || {})[sh.hullSize] ?? 0;
      const builtIn = builtIns.includes(hm.id);
      // s-mods (from a save/variant's permaMods) are locked like built-ins
      // and cost no OP; they render with an S badge
      const isSmod = !builtIn && (S.build.smods || []).includes(hm.id);
      const block = builtIn || isSmod ? null : hullmodBlockReason(hm, sh);
      const tip = hm.desc && !hm.desc.startsWith("<Tooltip") ? hm.desc : (hm.short || "");
      const effSum = effectsSummary(hm, sh.hullSize);
      return `<label class="hullmod-row ${block ? "blocked" : ""} ${isSmod ? "smod" : ""}"><input type="checkbox" data-hullmod="${esc(hm.id)}"
        ${S.build.hullMods.includes(hm.id) ? "checked" : ""} ${builtIn || isSmod || block ? "disabled" : ""}>
        ${hm.icon ? `<img class="hm-icon" data-hmicon="${esc(hm.id)}" alt="">` : `<span class="hm-icon"></span>`}
        <span class="hm-name"${tip ? ` title="${esc(tip)}"` : ""}>${isSmod ? '<span class="smod-badge">S</span>' : ""}${esc(hm.name)}${effSum ? `<span class="hm-effects">${esc(effSum)}</span>` : ""}${block ? `<span class="hm-block">${esc(block)}</span>` : ""}</span>
        <span class="${builtIn || isSmod ? "hm-cost free" : "hm-cost"}">${builtIn ? "built-in" : isSmod ? "s-mod · 0 OP" : `${cost} OP`}</span></label>`;
    }).join("")
      + builtIns.filter((mid) => !allMods[mid]).map((mid) =>
        `<div class="hullmod-row"><span class="hm-icon"></span><span class="hm-name">${esc(mid)}</span>
          <span class="hm-cost free">built-in</span></div>`).join("")
      + `</div>`;
  }

  // ---- launch bays / fighters
  const nb = bayCount(sh);
  if (nb > 0) {
    html += `<h3>Launch Bays</h3>`;
    const wingsData = S.data.wings || {};
    if (!Object.keys(wingsData).length) {
      html += `<div class="note">Fighter bays: ${nb}. Fighter selection pending wing data.</div>`;
    } else {
      const wingOpts = Object.values(wingsData)
        .sort((a, b) => (a.op - b.op) || a.name.localeCompare(b.name));
      for (let i = 0; i < nb; i++) {
        const cur = (S.build.wings || [])[i] || "";
        if (wingBayLocked(sh, i)) {
          const w = wingsData[cur];
          html += `<div class="wing-row"><span class="wing-bay">Bay ${i + 1}</span>
            <span class="wing-locked">${esc(w ? w.name : cur)} <span class="locked">[built-in, locked]</span></span></div>`;
        } else {
          html += `<div class="wing-row"><span class="wing-bay">Bay ${i + 1}</span>
            <select data-wing-bay="${i}">
              <option value="">— Empty —</option>
              ${wingOpts.map((w) => `<option value="${esc(w.id)}" ${w.id === cur ? "selected" : ""}>${esc(w.name)} · ${w.op} OP${w.numFighters ? ` · ${w.numFighters} fighters` : ""}${w.role ? ` · ${esc(w.role)}` : ""}</option>`).join("")}
            </select></div>`;
        }
      }
      html += `<div class="note">Fitted wings cost OP; built-in wings are free and locked.</div>`;
    }
  }
  $("mods-content").innerHTML = html;
}

// Bottom action strip: named builds + .variant export/import, game buttons.
function renderBuildBar(saved) {
  const names = Object.keys(saved).sort();
  $("buildbar").innerHTML = `
    <span class="bb-label">Build</span>
    <input type="text" id="build-name" placeholder="Build name" value="${esc(S.build.name || "")}">
    <button data-action="save-build">Save</button>
    <span class="bb-builds">
      ${names.map((name, i) => `
        <span class="bb-chipwrap"><button class="bb-load" data-load="${i}" title="Load this build">${esc(name)} <span class="bb-meta">${esc(saved[name].hullId || "")}</span></button><button class="bb-x" data-del="${i}" title="Delete build">✕</button></span>`).join("")}
    </span>
    <span class="bb-spacer"></span>
    <span class="note">Builds are stored only in this browser.</span>
    <button data-action="export">Export .variant</button>
    <button data-action="copy">Copy variant</button>
    <button data-action="export-battle">Export for Spawn battle</button>
    <button data-action="import">Import .variant</button>`;
}

function renderPanel() {
  const sh = ship();
  if (!sh) return;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS_BUILDS) || "{}"); } catch (e) { /* ignore */ }
  renderInfo();
  renderMods();
  renderBuildBar(saved);
  renderPicker();
  wirePanel(saved);
  hydrateHullmodIcons();
  hydrateWeaponCards(sh.slots.find((s) => s.id === S.selectedSlot) || null);
}

function hydrateHullmodIcons() {
  for (const img of document.querySelectorAll("img[data-hmicon]")) {
    const hm = (S.data.hullmods || {})[img.dataset.hmicon];
    if (!hm || !hm.icon) { img.remove(); continue; }
    fetchJSON(`sprites/${hm.icon}.json`).then((shard) => {
      if (shard && shard.icon && img.isConnected) img.src = shard.icon;
      else if (img.isConnected) img.remove();
    });
  }
}

function refreshPicker() {
  renderPicker();
  wirePicker();
  const sel = ship() ? ship().slots.find((s) => s.id === S.selectedSlot) || null : null;
  hydrateWeaponCards(sel);
}

function wirePicker() {
  const pk = $("picker");
  if (!pk) return;
  const close = $("picker-close");
  if (close) close.addEventListener("click", () => { closePicker(); renderPicker(); });
  const emptyBtn = pk.querySelector("[data-action='empty-slot']");
  if (emptyBtn) emptyBtn.addEventListener("click", () => fitWeapon(S.selectedSlot, null));
  const sel = ship() ? ship().slots.find((s) => s.id === S.selectedSlot) || null : null;
  for (const row of pk.querySelectorAll("#picker-list [data-fit]")) {
    const wid = row.dataset.fit;
    const w = S.data.weapons[wid];
    row.addEventListener("click", () => fitFromPicker(S.selectedSlot, wid));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fitFromPicker(S.selectedSlot, wid); }
    });
    if (w && sel) {
      row.addEventListener("mouseenter", () => showSpecFloat(w, sel, row));
      row.addEventListener("focus", () => showSpecFloat(w, sel, row));
      row.addEventListener("mouseleave", hideSpecFloat);
      row.addEventListener("blur", hideSpecFloat);
    }
  }
  for (const b of pk.querySelectorAll("[data-wsize]")) {
    b.addEventListener("click", () => { S.weaponSizeFilter = b.dataset.wsize; refreshPicker(); });
  }
  const ws = $("weapon-search");
  if (ws) {
    ws.addEventListener("input", () => {
      S.weaponSearch = ws.value;
      const pos = ws.selectionStart;
      refreshPicker();
      const el = $("weapon-search");
      if (el) { el.focus(); el.setSelectionRange(pos, pos); }
    });
  }
  const wsort = $("weapon-sort");
  if (wsort) wsort.addEventListener("change", () => { S.weaponSort = wsort.value; refreshPicker(); });
}

function wirePanel(saved) {
  for (const b of $("info-content").querySelectorAll("[data-step]")) {
    b.addEventListener("click", () => {
      const [field, d] = b.dataset.step.split("|");
      S.build[field] = Math.max(0, Math.min(99, S.build[field] + Number(d)));
      afterBuildChange();
    });
  }
  for (const b of $("mods-content").querySelectorAll("[data-hullmod]")) {
    b.addEventListener("change", () => {
      const mid = b.dataset.hullmod;
      if (b.checked) S.build.hullMods.push(mid);
      else S.build.hullMods = S.build.hullMods.filter((m) => m !== mid);
      afterBuildChange();
    });
  }
  for (const selEl of $("mods-content").querySelectorAll("[data-wing-bay]")) {
    selEl.addEventListener("change", () => {
      const i = Number(selEl.dataset.wingBay);
      if (!Array.isArray(S.build.wings)) S.build.wings = [];
      S.build.wings[i] = selEl.value || null;
      afterBuildChange();
    });
  }
  // ---- build bar
  const bar = $("buildbar");
  const bn = $("build-name");
  if (bn) bn.addEventListener("input", () => { S.build.name = bn.value; persistCurrent(); });
  const names = Object.keys(saved).sort();
  for (const b of bar.querySelectorAll("[data-load]")) {
    b.addEventListener("click", () => {
      const name = names[Number(b.dataset.load)];
      const build = saved[name];
      if (!build) return;
      S.build.name = name;
      selectShip(build.hullId, build);
    });
  }
  for (const b of bar.querySelectorAll("[data-del]")) {
    b.addEventListener("click", () => {
      const name = names[Number(b.dataset.del)];
      const all = JSON.parse(localStorage.getItem(LS_BUILDS) || "{}");
      delete all[name];
      localStorage.setItem(LS_BUILDS, JSON.stringify(all));
      renderPanel();
    });
  }
  const act = (name) => bar.querySelector(`[data-action='${name}']`);
  if (act("save-build")) act("save-build").addEventListener("click", saveBuild);
  if (act("export")) act("export").addEventListener("click", exportVariant);
  if (act("export-battle")) act("export-battle").addEventListener("click", exportBattleVariant);
  if (act("copy")) act("copy").addEventListener("click", copyVariant);
  if (act("import")) act("import").addEventListener("click", () => $("import-picker").click());
  wirePicker();
}
function afterBuildChange() { persistCurrent(); renderPanel(); draw(); }

function fitWeapon(slotId, weaponId) {
  if (!slotId || isLocked(slotId)) return;
  if (weaponId) {
    S.build.weapons[slotId] = weaponId;
    const slot = ship().slots.find((s) => s.id === slotId);
    ensureWeaponImage(weaponId, slot);
  } else {
    delete S.build.weapons[slotId];
  }
  afterBuildChange();
}

function saveBuild() {
  const name = (S.build.name || "").trim() || `${ship().name} build`;
  S.build.name = name;
  const all = JSON.parse(localStorage.getItem(LS_BUILDS) || "{}");
  all[name] = JSON.parse(JSON.stringify(S.build));
  localStorage.setItem(LS_BUILDS, JSON.stringify(all));
  renderPanel();
}

// ---------------------------------------------------------------- variant I/O
function toVariant() {
  const weapons = {};
  for (const slot of ship().slots) {
    const wid = S.build.weapons[slot.id];
    if (wid && !isLocked(slot.id)) weapons[slot.id] = wid;
  }
  const variant = {
    hullId: S.shipId,
    displayName: S.build.name || ship().name,
    fluxVents: S.build.vents,
    fluxCapacitors: S.build.caps,
    hullMods: S.build.hullMods.filter((m) => !(ship().builtInMods || []).includes(m)),
    weaponGroups: [{ autofire: false, mode: "LINKED", weapons }],
    // all fitted wings in bay order, built-ins included: keeps bay alignment
    // on a round trip, and the game forces built-in wings from the hull anyway
    wings: (S.build.wings || []).filter(Boolean),
  };
  // s-mods survive the round trip (loaded from a save or variant)
  if ((S.build.smods || []).length) {
    variant.permaMods = [...S.build.smods];
    variant.smods = [...S.build.smods];
  }
  return variant;
}
function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function exportVariant() {
  const safe = (S.build.name || ship().name).replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_");
  download(`${S.shipId}_${safe || "build"}.variant`, JSON.stringify(toVariant(), null, 2));
}
function exportBattleVariant() {
  // The Spawn battle sim's variant format (scripts/refit.js in the world
  // repo): a flat build the sim validates and derives stats from.
  // Re-imports here unchanged through Import .variant.
  const v = {
    hullId: S.shipId, name: S.build.name || "",
    weapons: { ...S.build.weapons },
    vents: S.build.vents || 0, caps: S.build.caps || 0,
    hullMods: [...(S.build.hullMods || [])], smods: [...(S.build.smods || [])],
    wings: [...(S.build.wings || [])],
  };
  const safe = (S.build.name || ship().name).replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_");
  download(`${S.shipId}_${safe || "build"}.battle-variant.json`, JSON.stringify(v, null, 2));
}
async function copyVariant() {
  try { await navigator.clipboard.writeText(JSON.stringify(toVariant(), null, 2)); }
  catch (e) { download(`${S.shipId}_build.variant`, JSON.stringify(toVariant(), null, 2)); }
}
function applyVariant(v) {
  const hullId = v.hullId || v.shipId;
  if (!hullId || !S.data.ships[hullId]) { alert("Variant references an unknown hull: " + hullId); return; }
  const weapons = {};
  if (Array.isArray(v.weaponGroups)) {
    for (const g of v.weaponGroups) Object.assign(weapons, g.weapons || {});
  }
  Object.assign(weapons, v.weapons || {});   // web exports / flat shapes
  const target = S.data.ships[hullId];
  const build = {
    hullId,
    name: v.displayName || v.name || "",
    weapons: { ...target.builtInWeapons },
    vents: Math.max(0, Math.min(99, v.fluxVents ?? v.vents ?? 0)),
    caps: Math.max(0, Math.min(99, v.fluxCapacitors ?? v.caps ?? 0)),
    hullMods: [...(target.builtInMods || [])],
    smods: [],
    // wings map positionally onto bays; unknown ids dropped, and selectShip
    // re-forces built-in wings into their locked bays afterwards
    wings: (() => {
      const arr = new Array(bayCount(target)).fill(null);
      (Array.isArray(v.wings) ? v.wings : []).forEach((wid, i) => {
        if (i < arr.length && S.data.wings && S.data.wings[wid]) arr[i] = wid;
      });
      return arr;
    })(),
  };
  const slotIds = new Set(target.slots.map((s) => s.id));
  const targetLocked = target.builtInWeapons || {};
  for (const [sid, wid] of Object.entries(weapons)) {
    if (slotIds.has(sid) && S.data.weapons[wid] && !(sid in targetLocked)) build.weapons[sid] = wid;
  }
  for (const m of v.hullMods || v.hullmods || []) {
    if (!build.hullMods.includes(m)) build.hullMods.push(m);
  }
  // permaMods/smods: permanent mods at 0 OP, locked like built-ins
  // (built-ins themselves are handled via the hull, not as s-mods)
  const perma = [...(v.permaMods || []), ...(v.smods || [])];
  build.smods = [...new Set(perma.filter((m) => !(target.builtInMods || []).includes(m)))];
  for (const m of build.smods) if (!build.hullMods.includes(m)) build.hullMods.push(m);
  selectShip(hullId, build);
}

// ---------------------------------------------------------------- save import
// Starsector campaign.xml is an XStream object serialization, not semantic
// XML: elements are field names, sets are <string> lists, maps are
// <entry><string>key</string><string>value</string></entry> pairs, and
// repeated objects are often replaced by reference="relative/xpath" stubs
// (XStream relative paths: ".." = parent, name[n] = 1-based n-th child).
// Tags below are matched by LOCAL name (after the last ".") so both
// field-name tags (playerFleet) and fully-qualified class tags
// (com.fs.starfarer.api.campaign.CampaignFleet) resolve the same way.
const localName = (el) => el.tagName.split(".").pop();
function childNamed(el, name) {
  if (!el || !el.children) return null;
  for (const c of el.children) if (localName(c) === name) return c;
  return null;
}
function childrenNamed(el, name) {
  if (!el || !el.children) return [];
  return [...el.children].filter((c) => localName(c) === name);
}
function textOf(el) { return el ? el.textContent.trim() : ""; }
function numOf(el) { const n = parseFloat(textOf(el)); return Number.isFinite(n) ? n : 0; }
// Walk an XStream relative path from an element: "..", "name", "name[n]".
function resolveXPath(el, path) {
  if (!el || !path) return null;
  let cur = el;
  for (const seg of path.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { cur = cur.parentElement; if (!cur) return null; continue; }
    const m = seg.match(/^(.*)\[(\d+)\]$/);
    const name = m ? m[1] : seg;
    const idx = m ? parseInt(m[2], 10) : 1;
    const kids = childrenNamed(cur, name);
    if (!kids.length || idx < 1 || idx > kids.length) return null;
    cur = kids[idx - 1];
  }
  return cur;
}
// Resolve a node that may be a reference stub into the real element.
// Bare-id fallbacks (a <variant id="…"> lookup by its variantId text) are
// handled by the caller via the variant registry.
function deref(el) {
  if (!el) return null;
  const ref = el.getAttribute && el.getAttribute("reference");
  if (ref) {
    const r = resolveXPath(el, ref);
    if (r) return deref(r);
  }
  return el;
}
function stringList(el) {
  if (!el) return [];
  // direct <string> children, or a nested container's children
  const direct = childrenNamed(el, "string").map(textOf);
  if (direct.length) return direct;
  for (const c of el.children) {
    const inner = childrenNamed(c, "string").map(textOf);
    if (inner.length) return inner;
  }
  return [];
}
// A string->string map from <entry><string>k</string><string>v</string></entry>
function stringMap(el) {
  const out = {};
  if (!el) return out;
  for (const e of el.children) {
    if (localName(e) !== "entry") continue;
    const ss = childrenNamed(e, "string");
    if (ss.length >= 2) out[textOf(ss[0])] = textOf(ss[1]);
  }
  return out;
}
function nodeText(el, name) {
  const c = childNamed(el, name);
  if (!c) return "";
  // a <name> element may hold a plain string or a structured name object
  if (localName(c) === "name" && c.children.length) {
    const first = textOf(childNamed(c, "first")), last = textOf(childNamed(c, "last"));
    if (first || last) return `${first} ${last}`.trim();
  }
  return textOf(c);
}
function personName(person) {
  if (!person) return "";
  const n = childNamed(person, "name");
  if (!n) return textOf(person);
  if (n.children.length) {
    const first = textOf(childNamed(n, "first")), last = textOf(childNamed(n, "last"));
    if (first || last) return `${first} ${last}`.trim();
  }
  return textOf(n);
}
// Collect every element matching a local name, depth-first (cheap for
// campaign.xml since one pass covers playerFleet, fleets, factions, variants).
function scanAll(doc, name) {
  const out = [];
  const walk = (el) => {
    for (const c of el.children) {
      if (localName(c) === name) out.push(c);
      walk(c);
    }
  };
  walk(doc.documentElement);
  return out;
}
// A fleet member: shipName + a variant (inline, reference stub, or bare id
// that matches a variant's variantId text), excluding fighter wings.
function memberShipName(member) {
  return nodeText(member, "shipName") || nodeText(member, "name") || "";
}
function memberType(member) {
  return (nodeText(member, "type") || nodeText(member, "shipType") || "").toUpperCase();
}
function parseVariant(variantEl, registry) {
  const v = deref(variantEl);
  if (!v) return null;
  // bare-id stub: an element whose text is a variant id from the registry
  if (!v.children.length && textOf(v) && registry[textOf(v)]) return registry[textOf(v)];
  const variantId = textOf(childNamed(v, "variantId")) || textOf(childNamed(v, "id"));
  const hullId = textOf(childNamed(v, "hullId")) || textOf(childNamed(v, "shipId")) || "";
  const weapons = {};
  const groups = [];
  const groupsEl = childNamed(v, "weaponGroups") || childNamed(v, "groups");
  if (groupsEl) {
    for (const g of groupsEl.children) {
      const mode = (textOf(childNamed(g, "mode")) || "LINKED").toUpperCase();
      const mapEl = childNamed(g, "weapons") || g;
      const map = stringMap(mapEl);
      groups.push({ mode, autofire: textOf(childNamed(g, "autofire")) === "true", weapons: map });
      Object.assign(weapons, map);
    }
  } else {
    // flat weapons map on the variant itself
    Object.assign(weapons, stringMap(childNamed(v, "weapons")));
  }
  // wings: a <wings>/<fittedWings> string list, else a wing map's values
  let wings = [];
  const wingsEl = childNamed(v, "wings") || childNamed(v, "fittedWings");
  if (wingsEl) {
    wings = stringList(wingsEl);
    if (!wings.length) wings = Object.values(stringMap(wingsEl));
  }
  return {
    variantId, hullId,
    displayName: textOf(childNamed(v, "displayName")) || textOf(childNamed(v, "name")) || "",
    fluxVents: numOf(childNamed(v, "fluxVents")),
    fluxCapacitors: numOf(childNamed(v, "fluxCapacitors")),
    hullMods: stringList(childNamed(v, "hullMods")),
    permaMods: stringList(childNamed(v, "permaMods")),
    smods: stringList(childNamed(v, "smods")),
    weaponGroups: groups, weapons, wings,
  };
}
// A fleet element looks like: name, commander, faction, members container.
// Player fleet identification, in priority order:
//  1. a <playerFleet> element (direct or reference stub) anywhere in the doc
//  2. the fleet whose commander is the player Person (<playerPerson>,
//     <player> or <characterData>), or whose commander name matches
//  3. a fleet of the player faction (a Faction whose <id> is "player")
function findPlayerFleet(doc) {
  const playerFleetEls = scanAll(doc, "playerFleet");
  for (const el of playerFleetEls) {
    const f = deref(el);
    if (!f) continue;
    if (localName(f) !== "playerFleet") return { fleet: f, method: "playerFleet reference" };
    // inline form: the fleet serialized inside <playerFleet> itself
    if (fleetMembersRaw(el).length) return { fleet: el, method: "playerFleet element" };
  }
  const fleets = scanAll(doc, "CampaignFleet");
  if (!fleets.length) return null;
  const personEls = [...scanAll(doc, "playerPerson"), ...scanAll(doc, "characterData"), ...scanAll(doc, "player")];
  let playerPerson = null;
  for (const el of personEls) { const p = deref(el); if (p) { playerPerson = p; break; } }
  const playerName = playerPerson ? personName(playerPerson) : "";
  if (playerPerson || playerName) {
    for (const f of fleets) {
      const cmd = deref(childNamed(f, "commander"));
      if (playerPerson && cmd === playerPerson) return { fleet: f, method: "fleet commander is the player character" };
      if (playerName && cmd && personName(cmd) === playerName) return { fleet: f, method: "fleet commander name matches the player character" };
    }
  }
  // player faction: Faction with <id>player</id>, resolved via faction refs
  const factions = scanAll(doc, "Faction");
  const playerFaction = factions.find((fa) => textOf(childNamed(fa, "id")) === "player");
  if (playerFaction) {
    const playerFleets = fleets.filter((f) => {
      const fr = deref(childNamed(f, "faction"));
      return fr === playerFaction;
    });
    if (playerFleets.length) {
      // prefer a fleet whose name matches the player name, else the biggest
      if (playerName) {
        const named = playerFleets.find((f) => textOf(childNamed(f, "name")).includes(playerName));
        if (named) return { fleet: named, method: "player-faction fleet, name matches the player character" };
      }
      playerFleets.sort((a, b) => fleetMembersRaw(b).length - fleetMembersRaw(a).length);
      return { fleet: playerFleets[0], method: "player-faction fleet (largest)" };
    }
  }
  return null;
}
// Members container: the shallowest descendant named "members" whose
// children look like fleet members (have a variant or shipName).
function fleetMembersRaw(fleet) {
  const cands = [];
  const walk = (el, depth) => {
    for (const c of el.children) {
      if (localName(c) === "members") cands.push({ el: c, depth });
      walk(c, depth + 1);
    }
  };
  walk(fleet, 0);
  cands.sort((a, b) => a.depth - b.depth);
  for (const { el } of cands) {
    const kids = [...el.children].filter((k) => childNamed(k, "variant") || childNamed(k, "shipName"));
    if (kids.length) return kids;
  }
  return [];
}
function memberCr(member) {
  const rt = childNamed(member, "repairTracker") || childNamed(member, "status");
  const cr = (rt && childNamed(rt, "cr")) || childNamed(member, "cr");
  if (!cr) return null;
  const n = parseFloat(textOf(cr));
  return Number.isFinite(n) ? n : null;
}
// ---- the game's compact save dialect (what 0.98a actually writes):
// abbreviated class tags (Flt = fleet, FMmbr = member), data in attributes
// (sN = ship name, hId = hull id, v/c = flux vents/capacitors, cr on the
// repair tracker), repeated objects as ref="N" stubs resolved through the
// z="N" id index. See SAVE_FORMAT.md for the full mapping.
function parseSaveCompact(doc) {
  const zIndex = new Map();
  for (const el of doc.querySelectorAll("[z]")) zIndex.set(el.getAttribute("z"), el);
  const derefC = (el) => {
    let cur = el;
    for (let i = 0; i < 10 && cur && cur.getAttribute && cur.getAttribute("ref"); i++) {
      const nxt = zIndex.get(cur.getAttribute("ref"));
      if (!nxt) break;
      cur = nxt;
    }
    return cur;
  };
  // player fleet: the <playerFleet ref="…"> stub, resolved via the z index
  let fleet = null, method = "";
  for (const el of doc.getElementsByTagName("playerFleet")) {
    const f = derefC(el);
    if (f && f !== el) { fleet = f; method = "playerFleet reference (z-index)"; break; }
  }
  if (!fleet) {
    for (const f of doc.getElementsByTagName("Flt")) {
      if (f.getAttribute("n") === "Player Fleet") { fleet = f; method = "fleet named 'Player Fleet'"; break; }
    }
  }
  if (!fleet) throw new Error("No player fleet found: no <playerFleet> reference in this save.");
  // character name: characterData > name (matches descriptor.xml)
  let characterName = "";
  const cd = doc.getElementsByTagName("characterData")[0];
  if (cd) characterName = textOf(childNamed(cd, "name"));
  if (!characterName) characterName = fleet.getAttribute("n") || "";
  // members: fleet > fD (fleet data) > m (member list) > FMmbr elements
  const fD = derefC(childNamed(fleet, "fD"));
  let memberEls = [];
  if (fD) {
    const m = childNamed(fD, "m");
    if (m) memberEls = [...m.children].filter((k) => localName(k) === "FMmbr").map(derefC);
    if (!memberEls.length) memberEls = [...fD.querySelectorAll("FMmbr")].map(derefC);
  }
  if (!memberEls.length) throw new Error("Player fleet found but its member list (fD/m) could not be read.");
  const members = [];
  for (const mm of memberEls) {
    const parsed = parseMemberCompact(mm, derefC);
    if (parsed) members.push(parsed);
  }
  if (!members.length) throw new Error("Player fleet members could not be parsed.");
  return { characterName, fleetName: fleet.getAttribute("n") || "", method, members };
}
function parseMemberCompact(mm, derefC) {
  if ((mm.getAttribute("t") || "SHIP").toUpperCase().includes("FIGHTER")) return null;
  const sv = derefC(childNamed(mm, "savedVariant"));
  if (!sv) return null;
  let hullId = sv.getAttribute("hId") || "";
  // D-modded ships serialize against a "<base>_default_D" hull spec
  if (hullId.endsWith("_default_D")) hullId = hullId.slice(0, -"_default_D".length);
  if (!hullId) return null;
  // flat slot->weapon map: <wpn><e><st>slot</st><st>weapon</st></e>…
  const weapons = {};
  const wpn = derefC(childNamed(sv, "wpn"));
  if (wpn) {
    for (const e of wpn.children) {
      const pair = [...e.children].map((x) => x.textContent.trim());
      if (pair.length >= 2 && pair[0]) weapons[pair[0]] = pair[1];
    }
  }
  // weapon groups are SLOT lists (<s><st>slot</st>…); weapons come from wpn
  const groups = [];
  const wG = derefC(childNamed(sv, "wG"));
  if (wG) {
    for (const g of wG.children) {
      const sEl = childNamed(g, "s");
      const slots = sEl ? [...sEl.children].map((x) => x.textContent.trim()).filter(Boolean) : [];
      const gw = {};
      for (const sid of slots) if (weapons[sid]) gw[sid] = weapons[sid];
      groups.push({ mode: (g.getAttribute("t") || "LINKED").toUpperCase(),
                    autofire: g.getAttribute("a") === "true", weapons: gw });
    }
  }
  const stList = (tag) => {
    const el = derefC(childNamed(sv, tag));
    return el ? [...el.children].map((x) => x.textContent.trim()) : [];
  };
  // hM carries ALL installed mods (built-ins, D-mods, s-mods). D-mods ride
  // in <pM> (permaMods) too, but only <sMods> are true s-mods: pass just
  // those as smods so D-mods keep costing OP, per the game's model.
  const sModsEl = childNamed(sv, "sMods");
  const rt = childNamed(mm, "rT");
  const crRaw = rt ? parseFloat(rt.getAttribute("cr")) : NaN;
  return {
    name: mm.getAttribute("sN") || "",
    hullId,
    cr: Number.isFinite(crRaw) ? crRaw : null,
    variant: {
      variantId: sv.getAttribute("hVId") || "",
      hullId,
      displayName: sv.getAttribute("vDN") || "",
      fluxVents: parseInt(sv.getAttribute("v") || "0", 10) || 0,
      fluxCapacitors: parseInt(sv.getAttribute("c") || "0", 10) || 0,
      hullMods: stList("hM").filter(Boolean),
      permaMods: [],
      smods: (sModsEl ? stList("sMods") : stList("pM")).filter(Boolean),
      weaponGroups: groups, weapons,
      wings: stList("wng").map((w) => w || null),   // empty <st> = empty bay
    },
  };
}
function parseSave(doc) {
  // dialect dispatch: the compact format has FMmbr/Flt tags; the plainer
  // XStream-style layout (hand-written fixtures, some tooling) does not
  if (doc.getElementsByTagName("FMmbr").length || doc.getElementsByTagName("Flt").length) {
    return parseSaveCompact(doc);
  }
  // variant registry for bare-id variant references
  const registry = {};
  for (const v of scanAll(doc, "ShipVariant")) {
    const id = textOf(childNamed(v, "variantId")) || textOf(childNamed(v, "id"));
    if (id) registry[id] = parseVariant(v, registry);
  }
  const found = findPlayerFleet(doc);
  if (!found) throw new Error("No player fleet found: could not identify your fleet in this save.");
  const fleetEl = found.fleet;
  const rawMembers = fleetMembersRaw(fleetEl);
  if (!rawMembers.length) throw new Error("Player fleet found but no ship members could be read.");
  const members = [];
  for (const m of rawMembers) {
    if (memberType(m).includes("FIGHTER_WING")) continue;   // fighters aren't ships
    const variantEl = childNamed(m, "variant");
    const variant = variantEl ? parseVariant(variantEl, registry) : null;
    const hullId = variant ? variant.hullId : (textOf(childNamed(m, "hullId")) || "");
    if (!hullId) continue;
    members.push({
      name: memberShipName(m),
      hullId,
      variant,
      cr: memberCr(m),
    });
  }
  if (!members.length) throw new Error("Player fleet members could not be matched to known hulls.");
  const playerEls = [...scanAll(doc, "playerPerson"), ...scanAll(doc, "characterData")];
  let characterName = "";
  for (const el of playerEls) {
    const p = deref(el);
    if (p) { const n = personName(p); if (n) { characterName = n; break; } }
  }
  if (!characterName) characterName = textOf(childNamed(fleetEl, "name")) || "";
  return { characterName, fleetName: textOf(childNamed(fleetEl, "name")) || "", method: found.method, members };
}
function fleetMemberBuild(member) {
  // turn a parsed member into a variant-shaped object applyVariant accepts
  const v = member.variant || {};
  return {
    hullId: member.hullId,
    displayName: member.name || v.displayName || "",
    fluxVents: v.fluxVents || 0,
    fluxCapacitors: v.fluxCapacitors || 0,
    hullMods: v.hullMods || [],
    permaMods: v.permaMods || [],
    smods: v.smods || [],
    weaponGroups: v.weaponGroups || [],
    weapons: v.weapons || {},
    wings: v.wings || [],
  };
}
// ---------------------------------------------------------------- fleet strip
// When a save is imported, the fleet also renders as a horizontal strip of
// sprite thumbnails across the top of the stage, like the game's refit
// fleet row. Clicking a chip opens the ship in the editor (same as the
// fleet panel row). Rebuilt only when its signature changes, so ordinary
// panel re-renders don't churn the thumbnails.
const stripObserver = ("IntersectionObserver" in window)
  ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        stripObserver.unobserve(e.target);
        fetchJSON(`sprites/${e.target.dataset.thumb}.json`).then((shard) => {
          if (!e.target.isConnected) return;
          if (shard && shard.sprite) e.target.src = shard.sprite;
          else e.target.style.display = "none";
        });
      }
    }, { root: document.getElementById("fleet-strip"), rootMargin: "160px" })
  : null;
let stripSig = "";
function renderFleetStrip() {
  const strip = $("fleet-strip");
  if (!strip) return;
  const sig = S.fleet ? `${S.fleet.fileName}|${S.fleet.members.length}|${S.activeMember}` : "";
  if (sig === stripSig) return;
  stripSig = sig;
  if (!S.fleet) { strip.hidden = true; strip.innerHTML = ""; return; }
  strip.innerHTML = S.fleet.members.map((m, i) => {
    const sh = S.data.ships[m.hullId];
    return `<button class="fleet-chip ${i === S.activeMember ? "active" : ""}" data-member="${i}"
      ${sh ? "" : "disabled"} title="${sh ? "Open in the refit editor" : "Hull is not in this viewer's data (modded hull?)"}">
      ${sh && sh.sprite ? `<img data-thumb="${esc(sh.sprite)}" alt="">` : ""}
      <span class="fc-main"><span class="fc-name">${esc(m.name || (sh ? sh.name : m.hullId))}</span>
      <span class="fc-sub">${esc(sh ? sh.name : m.hullId)}</span></span></button>`;
  }).join("");
  strip.hidden = false;
  for (const b of strip.querySelectorAll("[data-member]")) {
    b.addEventListener("click", () => openFleetMember(Number(b.dataset.member)));
  }
  if (stripObserver) {
    for (const img of strip.querySelectorAll("img[data-thumb]")) stripObserver.observe(img);
  }
}

function openFleetMember(i) {
  const m = S.fleet && S.fleet.members[i];
  if (!m || !S.data.ships[m.hullId]) return;   // unknown hull: note instead of open
  applyVariant(fleetMemberBuild(m));
  // applyVariant → selectShip reset the active marker; restore it now
  S.activeMember = i;
  renderFleet();
  renderFleetStrip();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderFleet() {
  const view = $("fleet-view");
  if (!S.fleet) { view.hidden = true; view.innerHTML = ""; renderFleetStrip(); return; }
  const f = S.fleet;
  const rows = f.members.map((m, i) => {
    const sh = S.data.ships[m.hullId];
    if (!sh) {
      return `<button class="fleet-member" disabled title="Hull ${esc(m.hullId)} is not in this viewer's data (modded hull?)">
        <span class="fm-main"><span class="fm-name">${esc(m.name || m.hullId)}</span>
        <span class="fm-sub">${esc(m.hullId)} · not in viewer data</span></span>
        <span class="fm-side"><span class="fm-op">—</span><span class="fm-sub">${m.cr !== null && m.cr !== undefined ? `CR ${Math.round(m.cr * 100)}%` : ""}</span></span></button>`;
    }
    const build = fleetMemberBuild(m);
    // fleetMemberBuild speaks variant field names; opBreakdownFor wants a
    // build-shaped object (vents/caps, flat weapons incl. built-ins)
    const op = opBreakdownFor(sh, {
      weapons: { ...sh.builtInWeapons, ...build.weapons },
      hullMods: [...(sh.builtInMods || []), ...build.hullMods, ...build.smods],
      smods: build.smods,
      vents: build.fluxVents || 0,
      caps: build.fluxCapacitors || 0,
      wings: build.wings,
    });
    const smodCount = (build.smods || []).length;
    return `<button class="fleet-member ${i === S.activeMember ? "active" : ""}" data-member="${i}" title="Open in the refit editor">
      <span class="fm-main"><span class="fm-name">${esc(m.name || sh.name)}</span>
      <span class="fm-sub">${esc(sh.name)} · ${esc(sh.hullSize)} · DP ${sh.dp ?? "?"}</span></span>
      <span class="fm-side"><span class="fm-op ${op.total > op.budget ? "over" : ""}">${op.total} / ${op.budget} OP</span>
      <span class="fm-sub">${m.cr !== null && m.cr !== undefined ? `CR ${Math.round(m.cr * 100)}%` : ""}${smodCount ? ` · s-mod ×${smodCount}` : ""}</span></span></button>`;
  }).join("");
  const known = f.members.filter((m) => S.data.ships[m.hullId]);
  const sum = (k) => known.reduce((a, m) => a + (S.data.ships[m.hullId][k] || 0), 0);
  const burn = known.length ? Math.min(...known.map((m) => S.data.ships[m.hullId].maxBurn || 99)) : "—";
  const unknownNote = f.members.length !== known.length
    ? `<div class="note">${f.members.length - known.length} ship(s) use hulls not in this viewer's vanilla data (modded hulls) and are excluded from the totals below.</div>` : "";
  view.innerHTML = `
    <div class="fleet-head"><h3>Fleet — ${esc(f.characterName || "Unknown captain")}</h3>
      <button id="fleet-close" title="Close fleet view">✕</button></div>
    <div class="note">From <b>${esc(f.fileName)}</b> · ${esc(f.method)}. Read-only: the save is parsed in
      your browser — never uploaded, never written back. Click a ship to load its real loadout into the
      editor; edits stay in the browser and export as .variant files.</div>
    <div class="fleet-summary">
      <span class="fs-cell"><span class="fs-k">Ships</span><span class="fs-v">${f.members.length}</span></span>
      <span class="fs-cell"><span class="fs-k">Total DP</span><span class="fs-v">${sum("dp")}</span></span>
      <span class="fs-cell"><span class="fs-k">Fuel / ly</span><span class="fs-v">${fmt(sum("fuelPerLy"))}</span></span>
      <span class="fs-cell"><span class="fs-k">Upkeep</span><span class="fs-v">${fmt(sum("suppliesPerMonth"))} /mo</span></span>
      <span class="fs-cell"><span class="fs-k">Cargo</span><span class="fs-v">${fmt(sum("cargo"))}</span></span>
      <span class="fs-cell"><span class="fs-k">Fleet burn</span><span class="fs-v">${burn}</span></span>
    </div>
    ${unknownNote}
    <div class="fleet-members">${rows}</div>
    <div class="note">Fleet burn = the slowest ship's base burn. Augmented Drive Field and other
      burn bonuses are not modeled.</div>`;
  view.hidden = false;
  view.querySelector("#fleet-close").addEventListener("click", () => { S.fleet = null; renderFleet(); });
  for (const b of view.querySelectorAll("[data-member]")) {
    b.addEventListener("click", () => openFleetMember(parseInt(b.dataset.member, 10)));
  }
  renderFleetStrip();
}
async function importSaveFile(file) {
  if (!file) return;
  if (file.size > 80 * 1024 * 1024) {
    if (!confirm(`This save is ${(file.size / 1048576).toFixed(0)} MB — parsing may take a while. Continue?`)) return;
  }
  $("save-busy").hidden = false;
  try {
    const text = await file.text();
    // let the busy indicator paint before the synchronous parse blocks
    await new Promise((r) => setTimeout(r, 30));
    const doc = new DOMParser().parseFromString(text, "text/xml");
    const err = doc.querySelector("parsererror");
    if (err) throw new Error("Not valid XML.");
    const rootName = localName(doc.documentElement);
    const looksLikeSave = ["GameState", "Campaign", "CampaignEngine", "save"].includes(rootName)
      || doc.getElementsByTagName("playerFleet").length > 0
      || doc.getElementsByTagName("Flt").length > 0
      || scanAll(doc, "CampaignFleet").length > 0;
    if (!looksLikeSave) {
      throw new Error("That doesn't look like a Starsector campaign save. Pick the campaign.xml file from a Starsector save folder.");
    }
    const fleet = parseSave(doc);
    fleet.fileName = file.name;
    S.fleet = fleet;
    renderFleet();
    $("info-panel").scrollTop = 0;
  } catch (e) {
    console.error("Save import failed:", e);
    alert(`Could not read this save file: ${e.message}`);
  } finally {
    $("save-busy").hidden = true;
  }
}
function wireSaveImport() {
  $("import-save-btn").addEventListener("click", () => $("save-picker").click());
  $("save-picker").addEventListener("change", async (ev) => {
    const f = ev.target.files[0];
    ev.target.value = "";
    await importSaveFile(f);
  });
  // drag-and-drop anywhere on the page (the browser's file picker, same parser)
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    if (++dragDepth === 1) $("drop-overlay").hidden = false;
  });
  window.addEventListener("dragleave", (e) => {
    if (--dragDepth <= 0) { dragDepth = 0; $("drop-overlay").hidden = true; }
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", async (e) => {
    dragDepth = 0;
    $("drop-overlay").hidden = true;
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) await importSaveFile(f);
  });
}

// ---------------------------------------------------------------- test flight
// A flight sandbox on the refit stage: the current ship + build, flown with
// the game's own movement numbers, hullmod-modified through the exact same
// effShipStat machinery the stats panel uses — fit Unstable Injector in the
// mods column mid-flight and the ship's top speed changes under you. The
// build itself is never touched: entering/exiting only toggles S.flight.
// Model notes and deliberate approximations are in README ("Test flight").
const FLIGHT_CODES = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

function flightStats() {
  const agg = computeModAgg();
  return {
    maxSpeed: effShipStat("maxSpeed", agg) || 0,
    accel: effShipStat("acceleration", agg) || 0,
    decel: effShipStat("deceleration", agg) || 0,
    maxTurn: effShipStat("maxTurnRate", agg) || 0,
    turnAccel: effShipStat("turnAcceleration", agg) || 0,
  };
}

function enterFlight() {
  if (!S.shipId || !ship()) return;
  if (S.flight && S.flight.active) return;
  closePicker();
  $("tooltip").hidden = true;
  const f = {
    active: true,
    x: 0, y: 0, vx: 0, vy: 0, facing: 0, omega: 0,
    camX: 0, camY: 0,
    speed: 0, maxSpeed: 0, stats: flightStats(),
    keys: new Set(),
    touch: { left: false, right: false, thrust: false, brake: false },
    showRanges: true,
    lastT: performance.now(), raf: 0,
  };
  S.flight = f;
  window.__flight = f;   // debug/test handle
  $("stage").classList.add("flight");
  $("flight-hud").hidden = false;
  const btn = $("flight-btn");
  btn.textContent = "Back to refit";
  btn.classList.add("active");
  $("stage-hint").textContent =
    "W/↑ thrust · S/↓ brake · A/D or ←/→ turn · Q/E strafe · R reset · Esc exit";
  updateFlightHud();
  f.raf = requestAnimationFrame(flightTick);
  draw();
}

function exitFlight() {
  const f = S.flight;
  if (!f || !f.active) return;
  f.active = false;
  cancelAnimationFrame(f.raf);
  f.keys.clear();
  S.cam.px = 0; S.cam.py = 0;   // flight zoom (z) carries back; pan does not
  $("stage").classList.remove("flight");
  $("flight-hud").hidden = true;
  const btn = $("flight-btn");
  btn.textContent = "Test flight";
  btn.classList.remove("active");
  $("stage-hint").textContent =
    "Click a slot for the weapon picker · right-click clears · Esc closes · wheel zooms · drag pans";
  draw();
}

function resetFlight() {
  const f = S.flight;
  if (!f) return;
  f.x = 0; f.y = 0; f.vx = 0; f.vy = 0; f.omega = 0; f.facing = 0;
  f.camX = 0; f.camY = 0; f.speed = 0;
}

function stepFlight(dt) {
  const f = S.flight;
  const st = flightStats();           // live: hullmod edits apply mid-flight
  f.stats = st;
  f.maxSpeed = st.maxSpeed;
  const k = f.keys, tc = f.touch;
  const left = k.has("KeyA") || k.has("ArrowLeft") || tc.left;
  const right = k.has("KeyD") || k.has("ArrowRight") || tc.right;
  const thrust = k.has("KeyW") || k.has("ArrowUp") || tc.thrust;
  const brake = k.has("KeyS") || k.has("ArrowDown") || tc.brake;

  // ---- turning: angular velocity spins up/down at turnAcceleration,
  // ---- capped at maxTurnRate (the game's model)
  if (left && !right) f.omega -= st.turnAccel * dt;
  else if (right && !left) f.omega += st.turnAccel * dt;
  else if (f.omega > 0) f.omega = Math.max(0, f.omega - st.turnAccel * dt);
  else if (f.omega < 0) f.omega = Math.min(0, f.omega + st.turnAccel * dt);
  f.omega = Math.max(-st.maxTurn, Math.min(st.maxTurn, f.omega));
  f.facing = (((f.facing + f.omega * dt) % 360) + 360) % 360;

  const [fx, fy] = dirVec(f.facing);        // forward unit vector (world)
  const rx = -fy, ry = fx;                  // right unit vector

  // ---- thrust / strafe: acceleration, but never past the speed cap
  const applyAccel = (ax, ay) => {
    if (st.maxSpeed <= 0) return;
    let nvx = f.vx + ax * dt, nvy = f.vy + ay * dt;
    const ns = Math.hypot(nvx, nvy);
    if (ns > st.maxSpeed) {
      if (Math.hypot(f.vx, f.vy) >= st.maxSpeed) return;  // at cap: no gain
      const s = st.maxSpeed / ns; nvx *= s; nvy *= s;     // clip to the cap
    }
    f.vx = nvx; f.vy = nvy;
  };
  if (thrust) applyAccel(fx * st.accel, fy * st.accel);
  if (k.has("KeyE")) applyAccel(rx * st.accel, ry * st.accel);
  if (k.has("KeyQ")) applyAccel(-rx * st.accel, -ry * st.accel);

  // ---- brake: kill the velocity vector at deceleration; from a standstill
  // ---- it becomes reverse thrust, capped at max(10, 25% of max speed)
  if (brake) {
    const sp = Math.hypot(f.vx, f.vy);
    if (sp > 0) {
      const d = st.decel * dt;
      if (d >= sp) { f.vx = 0; f.vy = 0; }
      else { const s = (sp - d) / sp; f.vx *= s; f.vy *= s; }
    } else if (st.decel > 0) {
      const revCap = Math.max(10, 0.25 * st.maxSpeed);
      let back = -(f.vx * fx + f.vy * fy);
      if (back < revCap) {
        f.vx -= fx * st.decel * dt;
        f.vy -= fy * st.decel * dt;
        back = -(f.vx * fx + f.vy * fy);
        if (back > revCap) { f.vx += fx * (back - revCap); f.vy += fy * (back - revCap); }
      }
    }
  }

  // ---- over the cap (e.g. a speed hullmod was just removed): bleed back
  // ---- down at half the deceleration. At/under the cap there is NO drag —
  // ---- coasting keeps your velocity, which is the game's feel.
  const sp2 = Math.hypot(f.vx, f.vy);
  if (sp2 > st.maxSpeed && st.maxSpeed > 0) {
    const ns = Math.max(st.maxSpeed, sp2 - st.decel * 0.5 * dt);
    const s = ns / sp2; f.vx *= s; f.vy *= s;
  }

  f.x += f.vx * dt;
  f.y += f.vy * dt;
  f.speed = Math.hypot(f.vx, f.vy);

  // ---- camera: exponential follow on the ship
  const t = 1 - Math.exp(-5 * dt);
  f.camX += (f.x - f.camX) * t;
  f.camY += (f.y - f.camY) * t;
}

function flightTick(t) {
  const f = S.flight;
  if (!f || !f.active) return;
  let dt = (t - f.lastT) / 1000;
  f.lastT = t;
  if (!(dt > 0)) dt = 0;
  if (dt > 0.05) dt = 0.05;
  stepFlight(dt);
  draw();
  updateFlightHud();
  f.raf = requestAnimationFrame(flightTick);
}

function updateFlightHud() {
  const f = S.flight;
  if (!f) return;
  const sh = ship();
  $("fh-name").textContent = sh ? sh.name : "";
  $("fh-spd").textContent = f.speed.toFixed(1);
  $("fh-max").textContent = fmt(f.maxSpeed, 1);
  const hdg = ((f.facing % 360) + 360) % 360;
  $("fh-hdg").textContent = String(Math.round(hdg) % 360).padStart(3, "0") + "°";
  $("fh-turn").textContent = (f.omega > 0 ? "+" : "") + f.omega.toFixed(0) + "°/s";
  $("fh-acc").textContent = fmt((f.stats || {}).accel, 1);
}

// The flight renderer: same sprite/slot geometry as the refit draw, but in a
// scrolling world — the ship sits at (f.x, f.y) rotated to its heading, the
// camera follows, and ranges are drawn in world space off the rotated slots.
function drawFlight() {
  const cv = $("canvas");
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, W, H);
  const sh = ship();
  const f = S.flight;
  const agg = computeModAgg();

  const effW = S.shipImg ? S.shipImg.naturalWidth : (sh.width || (sh.collisionRadius || 100) * 2);
  const effH = S.shipImg ? S.shipImg.naturalHeight : (sh.height || (sh.collisionRadius || 100) * 2);
  const fitScale = Math.min((W - 30) / effW, (H - 30) / effH);
  const scale = fitScale * S.cam.z;
  S.view = { scale: fitScale, ox: 0, oy: 0, effW, effH };
  S.slotScreen = [];

  const toScreen = (wx, wy) => [W / 2 + (wx - f.camX) * scale, H / 2 + (wy - f.camY) * scale];
  const [scx, scy] = toScreen(f.x, f.y);
  const th = f.facing * Math.PI / 180;
  const cosT = Math.cos(th), sinT = Math.sin(th);
  // slot position in world space: ship-local offset is (slot.y, -slot.x)
  // in sprite pixels (lateral, -forward), rotated by the heading
  const slotScreen = (slot) => {
    const lx = slot.y, ly = -slot.x;
    return toScreen(f.x + lx * cosT - ly * sinT, f.y + lx * sinT + ly * cosT);
  };

  // ---- world blueprint grid: 50-unit cells from the world origin, axis
  // ---- lines through the origin drawn brighter
  const step = 50 * scale;
  if (step > 9) {
    const wl = f.camX - (W / 2) / scale, wr = f.camX + (W / 2) / scale;
    const wt = f.camY - (H / 2) / scale, wb = f.camY + (H / 2) / scale;
    ctx.save();
    ctx.lineWidth = 1;
    for (let gx = Math.ceil(wl / 50) * 50; gx <= wr; gx += 50) {
      const sx = toScreen(gx, 0)[0];
      ctx.strokeStyle = gx === 0 ? "rgba(120,170,200,.22)" : "rgba(120,170,200,.07)";
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
    }
    for (let gy = Math.ceil(wt / 50) * 50; gy <= wb; gy += 50) {
      const sy = toScreen(0, gy)[1];
      ctx.strokeStyle = gy === 0 ? "rgba(120,170,200,.22)" : "rgba(120,170,200,.07)";
      ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(W, sy); ctx.stroke();
    }
    ctx.restore();
  }

  // ---- range wedges at effective range, rotated with the ship
  const wedgeF = (sx, sy, angleDeg, arcDeg, rangeWorld, color, alpha, ring) => {
    const R = rangeWorld * scale;
    const a0 = (angleDeg - arcDeg / 2) * Math.PI / 180;
    const a1 = (angleDeg + arcDeg / 2) * Math.PI / 180;
    const c0 = Math.atan2(-Math.cos(a0), Math.sin(a0));
    const c1 = Math.atan2(-Math.cos(a1), Math.sin(a1));
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.arc(sx, sy, R, c0, c1, false);
    ctx.closePath();
    ctx.fillStyle = color; ctx.globalAlpha = alpha; ctx.fill(); ctx.globalAlpha = 1;
    if (ring) {
      ctx.beginPath();
      ctx.arc(sx, sy, R, c0, c1, false);
      ctx.strokeStyle = color; ctx.globalAlpha = 0.85;
      ctx.lineWidth = Math.max(1.2, dpr); ctx.stroke(); ctx.globalAlpha = 1;
    }
  };
  if (f.showRanges) {
    const selSlot = sh.slots.find((s) => s.id === S.selectedSlot) || null;
    const selW = selSlot ? fittedWeapon(selSlot) : null;
    for (const slot of sh.slots) {
      if (slot.type === "DECORATIVE" || slot.type === "SYSTEM" || slot.type === "LAUNCH_BAY") continue;
      const w = fittedWeapon(slot);
      if (!w) continue;
      const r = effectiveRange(w, slot, agg);
      if (r === null) continue;
      const [sx, sy] = slotScreen(slot);
      const col = TYPE_COLORS[slot.type] || "#888";
      const wa = f.facing + slot.angle;
      if (selW && slot.id === selSlot.id) {
        wedgeF(sx, sy, wa, slot.arc, r, col, 0.15, true);
        const [dx, dy] = dirVec(wa);
        const tx = sx + dx * r * scale, ty = sy + dy * r * scale;
        const label = fmt(Math.round(r));
        ctx.font = `${Math.round(11 * dpr)}px ui-monospace, monospace`;
        ctx.textAlign = "center";
        const tw = ctx.measureText(label).width + 9 * dpr;
        ctx.fillStyle = "rgba(6,12,18,.78)";
        ctx.fillRect(tx - tw / 2, ty - 8 * dpr, tw, 16 * dpr);
        ctx.fillStyle = "#e8f4f8";
        ctx.fillText(label, tx, ty + 4 * dpr);
      } else if (!selW) {
        wedgeF(sx, sy, wa, slot.arc, r, col, 0.06, false);
      }
    }
  }

  // ---- velocity vector: one second of travel at the current velocity
  if (f.speed > 0.5) {
    const [ex, ey] = toScreen(f.x + f.vx, f.y + f.vy);
    ctx.save();
    ctx.strokeStyle = "rgba(87,199,227,.55)";
    ctx.lineWidth = Math.max(1.2, dpr);
    ctx.beginPath(); ctx.moveTo(scx, scy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.fillStyle = "rgba(87,199,227,.85)";
    ctx.beginPath(); ctx.arc(ex, ey, 2.4 * dpr, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // ---- the ship, rotated to heading; fitted weapons ride along
  ctx.save();
  ctx.translate(scx, scy);
  ctx.rotate(th);
  if (S.shipImg) {
    ctx.drawImage(S.shipImg, -sh.center[0] * scale, -(effH - sh.center[1]) * scale,
      effW * scale, effH * scale);
  } else {
    // schematic silhouette around the origin, bow up (refit shape, centered)
    const hw = (effW / 2) * scale, hh = (effH / 2) * scale;
    ctx.save();
    ctx.strokeStyle = "rgba(57,194,215,.35)";
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.arc(0, 0, (sh.collisionRadius || effW / 2) * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(38,57,74,.55)";
    ctx.strokeStyle = "#39c2d7";
    ctx.beginPath();
    ctx.moveTo(0, -hh);
    ctx.lineTo(hw * 0.82, -hh * 0.35);
    ctx.lineTo(hw, hh * 0.55);
    ctx.lineTo(hw * 0.72, hh);
    ctx.lineTo(-hw * 0.72, hh);
    ctx.lineTo(-hw, hh * 0.55);
    ctx.lineTo(-hw * 0.82, -hh * 0.35);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  for (const slot of sh.slots) {
    const w = fittedWeapon(slot);
    const lx = slot.y * scale, ly = -slot.x * scale;
    let drew = false;
    if (w && S.show.sprites) {
      const img = S.weaponImgs[`${w.id}|${slot.mount === "HARDPOINT" ? "hardpoint" : "turret"}`];
      if (img) {
        const pw = img.naturalWidth * scale, ph = img.naturalHeight * scale;
        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(slot.angle * Math.PI / 180);
        ctx.drawImage(img, -pw / 2, -ph / 2, pw, ph);
        ctx.restore();
        drew = true;
      }
    }
    if (!drew && w) {
      // fitted but no art loaded: fall back to the slot glyph so the mount
      // still reads on the hull
      const r = Math.max((GLYPH_R[slot.size] || 5) * scale, 2.2 * dpr);
      drawSlotGlyph(ctx, slot, lx, ly, r,
        TYPE_COLORS[w.mountType] || TYPE_COLORS[slot.type] || "#888",
        { fitted: true, selected: S.selectedSlot === slot.id, hover: false, dpr });
    }
    if (S.show.labels) {
      ctx.fillStyle = "rgba(220,235,242,.85)";
      ctx.font = `${Math.round(10 * dpr)}px sans-serif`;
      ctx.textAlign = "left";
      ctx.fillText(slot.id, lx + 10 * dpr, ly + 3 * dpr);
    }
  }
  ctx.restore();

  // ---- facing tick just past the bow
  const [fdx, fdy] = dirVec(f.facing);
  const tickR = (sh.collisionRadius || effW / 2) * scale + 14 * dpr;
  ctx.save();
  ctx.strokeStyle = "rgba(240,248,252,.65)";
  ctx.lineWidth = Math.max(1.2, dpr);
  ctx.beginPath();
  ctx.moveTo(scx + fdx * tickR * 0.8, scy + fdy * tickR * 0.8);
  ctx.lineTo(scx + fdx * tickR, scy + fdy * tickR);
  ctx.stroke();
  ctx.restore();
}

function wireFlight() {
  $("flight-btn").addEventListener("click", () => {
    if (S.flight && S.flight.active) exitFlight(); else enterFlight();
  });
  $("flight-reset").addEventListener("click", () => resetFlight());
  $("fh-ranges").addEventListener("change", (e) => {
    if (S.flight) { S.flight.showRanges = e.target.checked; draw(); }
  });
  document.addEventListener("keydown", (e) => {
    const f = S.flight;
    if (!f || !f.active) return;
    const tag = e.target && e.target.tagName;
    const type = e.target && e.target.type;
    // typing in a text field still types; toggles/buttons keep flight keys
    if (tag === "TEXTAREA" || tag === "SELECT"
        || (tag === "INPUT" && (type === "text" || type === "search" || type === "number"))) return;
    if (e.key === "Escape") { exitFlight(); return; }
    if (e.code === "KeyR") { resetFlight(); return; }
    if (FLIGHT_CODES.has(e.code)) { f.keys.add(e.code); e.preventDefault(); }
  });
  document.addEventListener("keyup", (e) => {
    if (S.flight) S.flight.keys.delete(e.code);
  });
  window.addEventListener("blur", () => { if (S.flight) S.flight.keys.clear(); });
  for (const b of document.querySelectorAll("#flight-touch [data-tc]")) {
    const key = b.dataset.tc;
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (S.flight) S.flight.touch[key] = true;
      try { b.setPointerCapture(e.pointerId); } catch (err) { /* non-fatal */ }
    });
    const off = () => { if (S.flight) S.flight.touch[key] = false; };
    b.addEventListener("pointerup", off);
    b.addEventListener("pointercancel", off);
    b.addEventListener("lostpointercapture", off);
    b.addEventListener("contextmenu", (e) => e.preventDefault());
  }
}

// ---------------------------------------------------------------- UI wiring
function wireUI() {
  $("ship-search").addEventListener("input", (e) => { S.shipSearch = e.target.value; buildShipList(); });
  for (const chip of $("size-chips").querySelectorAll(".chip")) {
    chip.addEventListener("click", () => {
      for (const c of $("size-chips").querySelectorAll(".chip")) c.classList.remove("active");
      chip.classList.add("active");
      S.sizeFilter = chip.dataset.size;
      buildShipList();
    });
  }
  const bind = (id, key) => $(id).addEventListener("change", (e) => { S.show[key] = e.target.checked; draw(); });
  bind("tgl-sprites", "sprites"); bind("tgl-labels", "labels");
  $("ranges-mode").addEventListener("change", (e) => { S.show.ranges = e.target.value; draw(); });
  const cv = $("canvas");
  const zoomCenter = (factor) => {
    const r = cv.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, factor);
  };
  $("zoom-in").addEventListener("click", () => zoomCenter(1.3));
  $("zoom-out").addEventListener("click", () => zoomCenter(1 / 1.3));
  $("zoom-fit").addEventListener("click", () => { resetCam(); draw(); });
  $("zoom-range").addEventListener("click", fitRange);

  const evtPos = (e) => {
    const r = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr, e.clientX - r.left, e.clientY - r.top];
  };
  // drag to pan; a click that follows a real drag must not select a slot
  let drag = null, dragged = false;
  cv.addEventListener("pointerdown", (e) => {
    if (S.flight && S.flight.active) return;   // no pan/select while flying
    drag = { x: e.clientX, y: e.clientY, px: S.cam.px, py: S.cam.py };
    dragged = false;
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* non-fatal */ }
  });
  cv.addEventListener("pointerup", () => { drag = null; });
  cv.addEventListener("click", (e) => {
    if (S.flight && S.flight.active) return;
    if (dragged) { dragged = false; return; }
    const [mx, my] = evtPos(e);
    const slot = slotAt(mx, my);
    if (slot) {
      // clicking a slot opens (or retargets) the weapon picker for it
      if (slot.id !== S.selectedSlot) {
        S.weaponSearch = "";
        S.weaponSizeFilter = "ALL";   // size chips reset whenever the slot changes
      }
      S.selectedSlot = slot.id;
      S.pickerOpen = true;
    } else {
      // clicking empty stage is the "click away" that closes the picker
      S.selectedSlot = null;
      closePicker();
    }
    renderPanel();
    draw();
  });
  // right-click a fitted slot clears it (the game's remove, web-style)
  cv.addEventListener("contextmenu", (e) => {
    if (S.flight && S.flight.active) return;
    const [mx, my] = evtPos(e);
    const slot = slotAt(mx, my);
    if (slot && !isLocked(slot.id) && S.build.weapons[slot.id]) {
      e.preventDefault();
      fitWeapon(slot.id, null);
    }
  });
  // the picker's pinned spec card: right-click clears the current weapon
  $("picker-pinned").addEventListener("contextmenu", (e) => {
    const sh = ship();
    const sel = sh ? sh.slots.find((s) => s.id === S.selectedSlot) : null;
    if (sel && !isLocked(sel.id) && S.build.weapons[sel.id]) {
      e.preventDefault();
      fitWeapon(sel.id, null);
    }
  });
  $("picker-list").addEventListener("scroll", hideSpecFloat);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && S.pickerOpen) { closePicker(); renderPicker(); }
  });
  cv.addEventListener("pointermove", (e) => {
    if (S.flight && S.flight.active) { $("tooltip").hidden = true; return; }
    if (drag) {
      const dpr = window.devicePixelRatio || 1;
      const dx = (e.clientX - drag.x) * dpr, dy = (e.clientY - drag.y) * dpr;
      if (Math.abs(dx) + Math.abs(dy) > 4) dragged = true;
      if (dragged) {
        S.cam.px = drag.px + dx;
        S.cam.py = drag.py + dy;
        $("tooltip").hidden = true;
        draw();
        return;
      }
    }
    const [mx, my, cssX, cssY] = evtPos(e);
    const slot = slotAt(mx, my);
    const tip = $("tooltip");
    if (slot) {
      S.hoverSlot = slot.id;
      const w = fittedWeapon(slot);
      const effR = w ? effectiveRange(w, slot) : null;
      tip.textContent = `${slot.id} — ${slot.type} / ${slot.size || ""} / ${slot.mount || ""}\n`
        + (w ? `Fitted: ${w.name} (${w.op} OP)${effR !== null && effR !== undefined ? ` · range ${fmt(Math.round(effR))}` : ""}` : "Empty");
      tip.style.left = (cssX + 14) + "px";
      tip.style.top = (cssY + 10) + "px";
      tip.hidden = false;
      cv.style.cursor = "pointer";
    } else {
      S.hoverSlot = null;
      tip.hidden = true;
      cv.style.cursor = "default";
    }
    draw();
  });
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });
  cv.addEventListener("mouseleave", () => { S.hoverSlot = null; $("tooltip").hidden = true; draw(); });

  $("import-picker").addEventListener("change", async (ev) => {
    const f = ev.target.files[0];
    ev.target.value = "";
    if (!f) return;
    try { applyVariant(JSON.parse(await f.text())); }
    catch (e) { alert("Could not parse that file as a variant JSON."); }
  });

  wireSaveImport();
  wireFlight();

  new ResizeObserver(() => resizeCanvas()).observe($("stage"));
  window.addEventListener("resize", resizeCanvas);
}

init();
