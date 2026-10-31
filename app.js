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
  hoverSlot: null,
  sizeFilter: "ALL",
  shipSearch: "",
  weaponSearch: "",
  weaponSort: "op",
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

function buildShipList() {
  const q = S.shipSearch.trim().toLowerCase();
  const ships = Object.values(S.data.ships)
    .filter((s) => S.sizeFilter === "ALL" || s.hullSize === S.sizeFilter)
    .filter((s) => !q || s.name.toLowerCase().includes(q) || s.id.includes(q)
      || (s.manufacturer || "").toLowerCase().includes(q))
    .sort((a, b) => (SIZE_ORDER[a.hullSize] ?? 9) - (SIZE_ORDER[b.hullSize] ?? 9)
      || a.name.localeCompare(b.name));
  $("ship-list").innerHTML = ships.map((s) => `
    <div class="ship-item ${s.id === S.shipId ? "selected" : ""}" data-ship="${esc(s.id)}">
      ${s.sprite ? `<img class="ship-thumb" data-thumb="${esc(s.sprite)}" alt="" loading="lazy">` : ""}
      <span class="nm">${esc(s.name)}</span>
      <span class="sub">${esc(s.designation || (s.hullSize || "").replace("_SHIP", ""))}</span>
      <span class="sub mono">${esc((s.hullSize || "").replace("_SHIP", ""))} · DP ${fmt(s.dp)} · OP ${fmt(s.op)}</span>
    </div>`).join("");
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
    vents: 0, caps: 0, hullMods: [...(ship.builtInMods || [])],
    wings: Array.from({ length: bayCount(ship) }, (_, i) => (ship.builtInWings || [])[i] || null),
  };
}
function selectShip(shipId, savedBuild) {
  const ship = S.data.ships[shipId];
  if (!ship) return;
  S.shipId = shipId;
  S.selectedSlot = null;
  S.hoverSlot = null;
  S.weaponSearch = "";
  resetCam();
  S.shipImg = null;
  S.build = savedBuild && savedBuild.hullId === shipId
    ? { name: "", vents: 0, caps: 0, hullMods: [], ...savedBuild }
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
function opBreakdown() {
  const sh = ship();
  let weapons = 0;
  for (const slot of sh.slots) {
    const wid = S.build.weapons[slot.id];
    if (wid && !isLocked(slot.id)) weapons += (S.data.weapons[wid] || {}).op || 0;
  }
  let hullmods = 0;
  for (const mid of S.build.hullMods) {
    if ((sh.builtInMods || []).includes(mid)) continue;   // built-ins cost no OP
    const hm = (S.data.hullmods || {})[mid];
    if (!hm) continue;
    const costs = hm.costs || hm.opCost || {};
    hullmods += costs[sh.hullSize] ?? costs.default ?? 0;
  }
  let fighters = 0;
  (S.build.wings || []).forEach((wid, i) => {
    if (wid && !wingBayLocked(sh, i)) fighters += ((S.data.wings || {})[wid] || {}).op || 0;
  });
  return {
    weapons, hullmods, fighters,
    vents: S.build.vents, caps: S.build.caps,
    total: weapons + hullmods + fighters + S.build.vents + S.build.caps,
    budget: sh.op || 0,
  };
}
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

function renderPanel() {
  const sh = ship();
  if (!sh) return;
  const op = opBreakdown();
  const fx = fluxStats();
  const agg = computeModAgg();
  const over = op.total > op.budget;
  // stat row with base -> effective + signed delta when hullmods (or vents /
  // caps, for the flux pair) change the value
  const statRow = (label, base, eff, d = 0) => {
    if (base === null || base === undefined)
      return `<span class="k">${label}</span><span class="v">—</span>`;
    if (eff === null || eff === undefined || Math.abs(eff - base) < 0.05)
      return `<span class="k">${label}</span><span class="v">${fmt(base, d)}</span>`;
    const delta = eff - base;
    return `<span class="k">${label}</span><span class="v eff">${fmt(Math.round(eff * 10) / 10, d)} `
      + `<span class="delta ${delta > 0 ? "pos" : "neg"}">(${delta > 0 ? "+" : ""}${fmt(Math.round(delta * 10) / 10, d)})</span></span>`;
  };
  const pct = (n) => Math.min(100, (n / Math.max(op.budget, op.total, 1)) * 100);
  const sel = sh.slots.find((s) => s.id === S.selectedSlot) || null;

  let html = `
    <h2>${esc(sh.name)}</h2>
    <div class="ship-sub">${esc(sh.designation || "")}${sh.designation && sh.manufacturer ? " · " : ""}${esc(sh.manufacturer || "")}
      · ${esc((sh.hullSize || "").replace(/_/g, " "))}${sh.isSkin ? ` · skin of ${esc(sh.baseHullId)}` : ""}</div>
    <div class="stats-grid">
      <span class="k">Deployment pts</span><span class="v">${fmt(sh.dp)}</span>
      <span class="k">Ordnance pts</span><span class="v">${fmt(sh.op)}</span>
      <span class="k">Hitpoints</span><span class="v">${fmt(sh.hitpoints)}</span>
      ${statRow("Armor", sh.armor, effShipStat("armor", agg))}
      ${statRow("Flux capacity", sh.fluxCapacity, fx.capacity)}
      ${statRow("Flux dissipation", sh.fluxDissipation, fx.dissipation)}
      ${statRow("Max speed", sh.maxSpeed, effShipStat("maxSpeed", agg))}
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

    <h3>Ordnance Points</h3>
    <div class="opbar ${over ? "over" : ""}">
      <div class="seg-weapons" style="width:${pct(op.weapons)}%"></div>
      <div class="seg-hullmods" style="width:${pct(op.hullmods)}%"></div>
      <div class="seg-fighters" style="width:${pct(op.fighters)}%"></div>
      <div class="seg-vents" style="width:${pct(op.vents)}%"></div>
      <div class="seg-caps" style="width:${pct(op.caps)}%"></div>
    </div>
    <div class="op-legend ${over ? "over-text" : ""}"><b>${op.total} / ${op.budget} OP</b>
      · weapons ${op.weapons} · hullmods ${op.hullmods} · fighters ${op.fighters}
      · vents ${op.vents} · caps ${op.caps}${over ? " · OVER BUDGET" : ""}</div>

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
    <div class="note">1 OP each, max 30. +10 dissipation per vent, +100 capacity per capacitor.</div>
  `;

  // ---- selected slot
  html += `<h3>Weapon Slot</h3>`;
  if (!sel) {
    html += `<div class="note">Click a slot on the ship to select it.</div>`;
  } else {
    const locked = isLocked(sel.id);
    const w = fittedWeapon(sel);
    html += `<div class="slot-head"><b>${esc(sel.id)}</b> — ${esc(sel.type)} / ${esc(sel.size || "")} / ${esc(sel.mount || "")}
      · arc ${fmt(sel.arc)}° @ ${fmt(sel.angle)}° ${locked ? '<span class="locked">[built-in, locked]</span>' : ""}</div>`;
    if (w) {
      html += weaponCard(w, sel, agg, true);
    } else {
      html += `<div class="note">Empty.</div>`;
    }
    if (locked) {
      html += `<div class="note">Built-in weapon — cannot be changed.</div>`;
    } else if (!SLOT_FIT[sel.type]) {
      html += `<div class="note">${esc(sel.type)} slots cannot be fitted.</div>`;
    } else {
      const legal = legalWeapons(sel)
        .filter((x) => !S.weaponSearch
          || x.name.toLowerCase().includes(S.weaponSearch.toLowerCase())
          || x.id.includes(S.weaponSearch.toLowerCase()));
      const sortOpt = (v, label) =>
        `<option value="${v}" ${S.weaponSort === v ? "selected" : ""}>${label}</option>`;
      html += `
        <button data-action="empty-slot" ${w ? "" : "disabled"}>Empty slot</button>
        <div class="weapon-controls">
          <input class="weapon-search" id="weapon-search" type="search" placeholder="Search weapons..."
                 value="${esc(S.weaponSearch)}" autocomplete="off">
          <select id="weapon-sort" title="Sort weapons">
            ${sortOpt("op", "Sort: OP")}${sortOpt("dps", "Sort: DPS")}
            ${sortOpt("range", "Sort: Range")}${sortOpt("name", "Sort: Name")}
          </select>
        </div>
        <div class="weapon-list">
          ${legal.map((x) => weaponCard(x, sel, agg, w && w.id === x.id)).join("")
            || '<div class="note" style="padding:6px">No legal weapons match.</div>'}
        </div>`;
    }
  }

  // ---- hullmods
  html += `<h3>Hullmods</h3>`;
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
      .sort((a, b) => a.name.localeCompare(b.name));
    html += `<div class="hullmod-list">` + visible.map((hm) => {
      const cost = (hm.costs || {})[sh.hullSize] ?? 0;
      const builtIn = builtIns.includes(hm.id);
      const block = builtIn ? null : hullmodBlockReason(hm, sh);
      const tip = hm.desc && !hm.desc.startsWith("<Tooltip") ? hm.desc : (hm.short || "");
      const effSum = effectsSummary(hm, sh.hullSize);
      return `<label class="hullmod-row ${block ? "blocked" : ""}"><input type="checkbox" data-hullmod="${esc(hm.id)}"
        ${S.build.hullMods.includes(hm.id) ? "checked" : ""} ${builtIn || block ? "disabled" : ""}>
        ${hm.icon ? `<img class="hm-icon" data-hmicon="${esc(hm.id)}" alt="">` : `<span class="hm-icon"></span>`}
        <span class="hm-name"${tip ? ` title="${esc(tip)}"` : ""}>${esc(hm.name)}${effSum ? `<span class="hm-effects">${esc(effSum)}</span>` : ""}${block ? `<span class="hm-block">${esc(block)}</span>` : ""}</span>
        <span class="note">${builtIn ? "built-in" : `${cost} OP`}</span></label>`;
    }).join("")
      + builtIns.filter((mid) => !allMods[mid]).map((mid) =>
        `<div class="hullmod-row"><span class="hm-icon"></span><span class="hm-name">${esc(mid)}</span>
          <span class="note">built-in</span></div>`).join("")
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

  // ---- builds
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS_BUILDS) || "{}"); } catch (e) { /* ignore */ }
  html += `
    <h3>Builds</h3>
    <div class="build-row">
      <input type="text" id="build-name" placeholder="Build name" value="${esc(S.build.name || "")}">
      <button data-action="save-build">Save</button>
    </div>
    <div id="saved-builds">
      ${Object.keys(saved).sort().map((name, i) => `
        <div class="saved-build"><span>${esc(name)} <span class="meta">${esc(saved[name].hullId || "")}</span></span>
          <span><button data-load="${i}">Load</button> <button data-del="${i}">Delete</button></span></div>`).join("")
        || '<div class="note">No saved builds yet.</div>'}
    </div>
    <div class="build-row">
      <button data-action="export">Export .variant</button>
      <button data-action="copy">Copy variant</button>
      <button data-action="import">Import</button>
    </div>
    <div class="note">Builds and your current work are stored only in this browser (localStorage). Nothing leaves your machine.</div>
  `;

  $("panel-content").innerHTML = html;
  wirePanel(saved);
  hydrateHullmodIcons();
  hydrateWeaponCards(sel);
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

function wirePanel(saved) {
  const panel = $("panel-content");
  for (const b of panel.querySelectorAll("[data-step]")) {
    b.addEventListener("click", () => {
      const [field, d] = b.dataset.step.split("|");
      S.build[field] = Math.max(0, Math.min(30, S.build[field] + Number(d)));
      afterBuildChange();
    });
  }
  for (const b of panel.querySelectorAll("[data-fit]")) {
    b.addEventListener("click", () => fitWeapon(S.selectedSlot, b.dataset.fit));
  }
  for (const b of panel.querySelectorAll("[data-hullmod]")) {
    b.addEventListener("change", () => {
      const mid = b.dataset.hullmod;
      if (b.checked) S.build.hullMods.push(mid);
      else S.build.hullMods = S.build.hullMods.filter((m) => m !== mid);
      afterBuildChange();
    });
  }
  for (const selEl of panel.querySelectorAll("[data-wing-bay]")) {
    selEl.addEventListener("change", () => {
      const i = Number(selEl.dataset.wingBay);
      if (!Array.isArray(S.build.wings)) S.build.wings = [];
      S.build.wings[i] = selEl.value || null;
      afterBuildChange();
    });
  }
  const emptyBtn = panel.querySelector("[data-action='empty-slot']");
  if (emptyBtn) emptyBtn.addEventListener("click", () => fitWeapon(S.selectedSlot, null));
  const ws = $("weapon-search");
  if (ws) {
    ws.addEventListener("input", () => {
      S.weaponSearch = ws.value;
      const pos = ws.selectionStart;
      renderPanel();
      const el = $("weapon-search");
      if (el) { el.focus(); el.setSelectionRange(pos, pos); }
      draw();
    });
  }
  const wsort = $("weapon-sort");
  if (wsort) {
    wsort.addEventListener("change", () => { S.weaponSort = wsort.value; renderPanel(); draw(); });
  }
  const bn = $("build-name");
  if (bn) bn.addEventListener("input", () => { S.build.name = bn.value; persistCurrent(); });
  const names = Object.keys(saved).sort();
  for (const b of panel.querySelectorAll("[data-load]")) {
    b.addEventListener("click", () => {
      const name = names[Number(b.dataset.load)];
      const build = saved[name];
      if (!build) return;
      S.build.name = name;
      selectShip(build.hullId, build);
    });
  }
  for (const b of panel.querySelectorAll("[data-del]")) {
    b.addEventListener("click", () => {
      const name = names[Number(b.dataset.del)];
      const all = JSON.parse(localStorage.getItem(LS_BUILDS) || "{}");
      delete all[name];
      localStorage.setItem(LS_BUILDS, JSON.stringify(all));
      renderPanel();
    });
  }
  const act = (name) => panel.querySelector(`[data-action='${name}']`);
  if (act("save-build")) act("save-build").addEventListener("click", saveBuild);
  if (act("export")) act("export").addEventListener("click", exportVariant);
  if (act("copy")) act("copy").addEventListener("click", copyVariant);
  if (act("import")) act("import").addEventListener("click", () => $("import-picker").click());
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
  return {
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
    vents: Math.max(0, Math.min(30, v.fluxVents ?? v.vents ?? 0)),
    caps: Math.max(0, Math.min(30, v.fluxCapacitors ?? v.caps ?? 0)),
    hullMods: [...(target.builtInMods || [])],
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
  selectShip(hullId, build);
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
    drag = { x: e.clientX, y: e.clientY, px: S.cam.px, py: S.cam.py };
    dragged = false;
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* non-fatal */ }
  });
  cv.addEventListener("pointerup", () => { drag = null; });
  cv.addEventListener("click", (e) => {
    if (dragged) { dragged = false; return; }
    const [mx, my] = evtPos(e);
    const slot = slotAt(mx, my);
    S.selectedSlot = slot ? slot.id : null;
    S.weaponSearch = "";
    renderPanel();
    draw();
  });
  cv.addEventListener("pointermove", (e) => {
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

  new ResizeObserver(() => resizeCanvas()).observe($("stage"));
  window.addEventListener("resize", resizeCanvas);
}

init();
