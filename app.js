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
const SIZE_PX = { SMALL: 22, MEDIUM: 32, LARGE: 46 };   // weapon sprite draw size (world units)
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
  show: { arcs: true, sprites: true, labels: false },
  shipImg: null,          // HTMLImageElement | null
  weaponImgs: {},         // `${weaponId}|${mount}` -> HTMLImageElement
  shardCache: {},         // shard path -> Promise<object|null>
  slotScreen: [],         // [{slot, sx, sy}] rebuilt every draw
  view: null,             // last transform {scale, ox, oy, effW, effH}
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
      <span class="nm">${esc(s.name)}${s.sprite ? ' <span class="dot" title="sprite available">●</span>' : ""}</span>
      <span class="sub">${esc((s.hullSize || "").replace("_SHIP", ""))} · DP ${fmt(s.dp)} · OP ${fmt(s.op)}</span>
    </div>`).join("");
  for (const el of $("ship-list").querySelectorAll(".ship-item")) {
    el.addEventListener("click", () => selectShip(el.dataset.ship));
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
    dissipation: (sh.fluxDissipation || 0) + 10 * S.build.vents,
    capacity: (sh.fluxCapacity || 0) + 100 * S.build.caps,
  };
}

// ---------------------------------------------------------------- legality
function legalWeapons(slot) {
  const accepts = SLOT_FIT[slot.type];
  if (!accepts) return [];
  const maxRank = SIZE_RANK[slot.size] || 0;
  return Object.values(S.data.weapons)
    .filter((w) => w.mountType && accepts.includes(w.mountType)
      && (SIZE_RANK[w.size] || 99) <= maxRank)
    .sort((a, b) => (a.op - b.op) || a.name.localeCompare(b.name));
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
  ctx.clearRect(0, 0, W, H);
  const sh = ship();

  // effective sprite dims: loaded image wins, else .ship width/height, else collision circle
  const effW = S.shipImg ? S.shipImg.naturalWidth : (sh.width || (sh.collisionRadius || 100) * 2);
  const effH = S.shipImg ? S.shipImg.naturalHeight : (sh.height || (sh.collisionRadius || 100) * 2);
  const scale = Math.min((W - 30) / effW, (H - 30) / effH);
  const ox = W / 2 - (effW / 2) * scale;   // screen pos of sprite top-left
  const oy = H / 2 - (effH / 2) * scale;
  S.view = { scale, ox, oy, effW, effH };

  const slotXY = (slot) => {
    const wx = sh.center[0] + slot.y;
    const wy = (effH - sh.center[1]) - slot.x;
    return [ox + wx * scale, oy + wy * scale];
  };

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
    ctx.font = `${Math.max(10, 11 * (window.devicePixelRatio || 1))}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("schematic — sprite not in local data pull", cx, cy + hh + 16);
    ctx.restore();
  }

  // ---- firing arcs (under markers)
  S.slotScreen = sh.slots.map((slot) => {
    const [sx, sy] = slotXY(slot);
    return { slot, sx, sy };
  });
  if (S.show.arcs) {
    for (const { slot, sx, sy } of S.slotScreen) {
      if (slot.type === "DECORATIVE" || slot.type === "SYSTEM") continue;
      const w = fittedWeapon(slot);
      const radius = w && w.range ? w.range * scale
        : Math.max(26, 0.4 * (sh.collisionRadius || 100) * scale);
      const col = TYPE_COLORS[slot.type] || "#888";
      const a0 = (slot.angle - slot.arc / 2) * Math.PI / 180;
      const a1 = (slot.angle + slot.arc / 2) * Math.PI / 180;
      // canvas arc angles: atan2 of dirVec = atan2(-cos, sin)
      const c0 = Math.atan2(-Math.cos(a0), Math.sin(a0));
      const c1 = Math.atan2(-Math.cos(a1), Math.sin(a1));
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.arc(sx, sy, radius, c0, c1, false);
      ctx.closePath();
      ctx.fillStyle = col + (S.selectedSlot === slot.id ? "3d" : "1f");
      ctx.fill();
      if (S.selectedSlot === slot.id) {
        ctx.strokeStyle = col; ctx.globalAlpha = 0.65; ctx.stroke(); ctx.globalAlpha = 1;
      }
    }
  }

  // ---- weapon sprites + slot markers
  for (const { slot, sx, sy } of S.slotScreen) {
    const w = fittedWeapon(slot);
    let drewSprite = false;
    if (w && S.show.sprites) {
      const img = S.weaponImgs[`${w.id}|${slot.mount === "HARDPOINT" ? "hardpoint" : "turret"}`];
      if (img) {
        const size = (SIZE_PX[slot.size] || 26) * scale;
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(slot.angle * Math.PI / 180);
        ctx.drawImage(img, -size / 2, -size / 2, size, size * (img.naturalHeight / img.naturalWidth || 1));
        ctx.restore();
        drewSprite = true;
      }
    }
    const r = (SIZE_RANK[slot.size] || 1) * 2.2 + 2;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = drewSprite ? "rgba(10,16,22,.35)"
      : (w ? (TYPE_COLORS[w.mountType] || "#aaa") : (TYPE_COLORS[slot.type] || "#888"));
    ctx.globalAlpha = w || drewSprite ? 0.95 : 0.55;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = S.selectedSlot === slot.id ? 2.5 : 1;
    ctx.strokeStyle = S.selectedSlot === slot.id ? "#ffffff"
      : (S.hoverSlot === slot.id ? "#cfe8ef" : "rgba(6,12,18,.8)");
    ctx.stroke();
    if (S.show.labels) {
      ctx.fillStyle = "rgba(220,235,242,.85)";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(slot.id, sx + r + 3, sy + 3);
    }
  }
}

function slotAt(mx, my) {
  let best = null, bestD = 16;   // px hit radius
  for (const s of S.slotScreen) {
    const d = Math.hypot(s.sx - mx, s.sy - my);
    if (d < bestD) { bestD = d; best = s.slot; }
  }
  return best;
}

// ---------------------------------------------------------------- panel
function weaponStatsLine(w) {
  if (!w) return "";
  const bits = [`${w.op} OP`];
  if (w.range) bits.push(`rng ${fmt(w.range)}`);
  if (w.damagePerSecond) bits.push(`${fmt(w.damagePerSecond)} dps`);
  if (w.damagePerShot) bits.push(`${fmt(w.damagePerShot)}/shot`);
  if (w.damageType) bits.push(w.damageType.replace("_", " "));
  if (w.fluxPerSecond) bits.push(`${fmt(w.fluxPerSecond)} fl/s`);
  else if (w.fluxPerShot) bits.push(`${fmt(w.fluxPerShot)} fl/shot`);
  return bits.join(" · ");
}

function renderPanel() {
  const sh = ship();
  if (!sh) return;
  const op = opBreakdown();
  const fx = fluxStats();
  const over = op.total > op.budget;
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
      <span class="k">Armor</span><span class="v">${fmt(sh.armor)}</span>
      <span class="k">Flux capacity</span><span class="v">${fmt(fx.capacity)}${S.build.caps ? ` (base ${fmt(sh.fluxCapacity)})` : ""}</span>
      <span class="k">Flux dissipation</span><span class="v">${fmt(fx.dissipation)}${S.build.vents ? ` (base ${fmt(sh.fluxDissipation)})` : ""}</span>
      <span class="k">Max speed</span><span class="v">${fmt(sh.maxSpeed)}</span>
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
      html += `<div class="fitted-box"><div class="fname">${esc(w.name)}</div>
        <div class="fstats">${esc(weaponStatsLine(w))}</div></div>`;
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
      html += `
        <button data-action="empty-slot" ${w ? "" : "disabled"}>Empty slot</button>
        <input class="weapon-search" id="weapon-search" type="search" placeholder="Search weapons..."
               value="${esc(S.weaponSearch)}" autocomplete="off">
        <div class="weapon-list">
          ${legal.map((x) => `
            <div class="weapon-row ${w && w.id === x.id ? "fitted" : ""}" data-fit="${esc(x.id)}">
              <span class="wname">${esc(x.name)}</span>
              <span class="wstats">${esc(x.size)} ${esc(x.mountType)} · ${esc(weaponStatsLine(x))}</span>
            </div>`).join("") || '<div class="note" style="padding:6px">No legal weapons match.</div>'}
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
      const tip = hm.desc && !hm.desc.startsWith("<Tooltip") ? hm.desc : (hm.short || "");
      return `<label class="hullmod-row"><input type="checkbox" data-hullmod="${esc(hm.id)}"
        ${S.build.hullMods.includes(hm.id) ? "checked" : ""} ${builtIn ? "disabled" : ""}>
        ${hm.icon ? `<img class="hm-icon" data-hmicon="${esc(hm.id)}" alt="">` : `<span class="hm-icon"></span>`}
        <span class="hm-name"${tip ? ` title="${esc(tip)}"` : ""}>${esc(hm.name)}</span>
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
  bind("tgl-arcs", "arcs"); bind("tgl-sprites", "sprites"); bind("tgl-labels", "labels");

  const cv = $("canvas");
  const evtPos = (e) => {
    const r = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr, e.clientX - r.left, e.clientY - r.top];
  };
  cv.addEventListener("click", (e) => {
    const [mx, my] = evtPos(e);
    const slot = slotAt(mx, my);
    S.selectedSlot = slot ? slot.id : null;
    S.weaponSearch = "";
    renderPanel();
    draw();
  });
  cv.addEventListener("mousemove", (e) => {
    const [mx, my, cssX, cssY] = evtPos(e);
    const slot = slotAt(mx, my);
    const tip = $("tooltip");
    if (slot) {
      S.hoverSlot = slot.id;
      const w = fittedWeapon(slot);
      tip.textContent = `${slot.id} — ${slot.type} / ${slot.size || ""} / ${slot.mount || ""}\n`
        + (w ? `Fitted: ${w.name} (${w.op} OP)` : "Empty");
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
