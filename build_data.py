#!/usr/bin/env python3
"""
build_data.py -- parse Starsector 0.98a-RC8 game data into data.json + sprite shards.

Source (read-only): ~/workspace/starsector-onslaught-3d/gamedata/assets/
Output (this dir):
  data.json                    ships / weapons / hullmods / wings
  sprites/ships/<hullId>.json  {"sprite": "data:image/png;base64,..."} for hulls
                               whose sprite PNG exists locally (text-only shards
                               so the repo can be published with a text-only push)
  sprites/weapons/<id>.json    {"turret": ..., "hardpoint": ...} for weapons
  sprites/hullmods/<id>.json   {"icon": ...} for hullmods (path from the CSV's
                               own `sprite` column, verified against disk)

Coordinates: slots are stored in GAME coordinates (x = forward axis,
y = lateral axis, relative to ship center). app.js does all screen mapping:
  img_x = center_x + slot.y
  img_y = (spriteHeight - center_y) - slot.x
"""

import base64
import csv
import json
import re
import struct
import sys
from pathlib import Path

SRC = Path.home() / "workspace/starsector-onslaught-3d/gamedata/assets"
OUT = Path(__file__).resolve().parent
VERSION = "0.98a-RC8"

# ---------------------------------------------------------------- lenient JSON

def load_lenient(path: Path):
    """Starsector's JSON dialect, normalized in one string-aware pass:
    //, /* */ and # comments; ';' used as a separator; bare enum words
    (e.g. [RENDER_BARREL_BELOW]); leading-dot floats (.67); trailing commas.
    """
    s = path.read_text(encoding="utf-8", errors="replace")
    out = []
    i, n = 0, len(s)
    in_str = esc = False
    while i < n:
        c = s[i]
        if in_str:
            out.append(c)
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            i += 1
        elif c == '"':
            in_str = True
            out.append(c)
            i += 1
        elif c == "/" and i + 1 < n and s[i + 1] == "/":
            while i < n and s[i] != "\n":
                i += 1
        elif c == "/" and i + 1 < n and s[i + 1] == "*":
            i += 2
            while i + 1 < n and not (s[i] == "*" and s[i + 1] == "/"):
                i += 1
            i += 2
        elif c == "#":
            while i < n and s[i] != "\n":
                i += 1
        elif c == ";":
            out.append(",")
            i += 1
        elif (c == "." and i + 1 < n and s[i + 1].isdigit()
              and not (out and (out[-1][-1].isdigit() or out[-1][-1] == "."))):
            out.append("0.")  # leading-dot float (.67) -> 0.67, but leave 0.15 alone
            i += 1
        elif c.isalpha() or c == "_":
            j = i
            while j < n and (s[j].isalnum() or s[j] in "_-."):
                j += 1
            word = s[i:j]
            if word in ("true", "false", "null"):
                out.append(word)
            else:
                out.append(json.dumps(word))  # bare enum -> string
            i = j
        else:
            out.append(c)
            i += 1
    s = "".join(out)
    s = re.sub(r",\s*([}\]])", r"\1", s)
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        obj, _ = json.JSONDecoder().raw_decode(s)  # tolerate trailing junk
        return obj

# ---------------------------------------------------------------- numbers

def fnum(v):
    if v is None:
        return None
    v = str(v).strip()
    if not v:
        return None
    try:
        return float(v)
    except ValueError:
        return None

def inum(v):
    f = fnum(v)
    return None if f is None else int(f)

def png_size(path: Path):
    """(width, height) from a PNG IHDR header, no imaging library needed."""
    with path.open("rb") as fh:
        head = fh.read(24)
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    w, h = struct.unpack(">II", head[16:24])
    return w, h

# ---------------------------------------------------------------- CSV tables

def read_csv_by_id(path: Path):
    rows = {}
    dupes = []
    with path.open(newline="", encoding="utf-8", errors="replace") as fh:
        for row in csv.DictReader(fh):
            rid = (row.get("id") or "").strip()
            if not rid:
                continue  # blank / comment rows
            if rid in rows:
                dupes.append(rid)
                continue
            rows[rid] = row
    return rows, dupes

# ---------------------------------------------------------------- main

def main():
    warnings = []
    for sub in ("ships", "weapons", "hullmods"):
        (OUT / "sprites" / sub).mkdir(parents=True, exist_ok=True)
    ship_rows, ship_dupes = read_csv_by_id(SRC / "data/hulls/ship_data.csv")
    weap_rows, weap_dupes = read_csv_by_id(SRC / "data/weapons/weapon_data.csv")
    if ship_dupes:
        warnings.append(f"ship_data.csv duplicate ids (kept first): {ship_dupes}")
    if weap_dupes:
        warnings.append(f"weapon_data.csv duplicate ids (kept first): {weap_dupes}")

    # ---- weapons: CSV stats merged with .wpn mount type/size ----------------
    wpn_files = {}
    for f in sorted((SRC / "data/weapons").glob("*.wpn")):
        try:
            d = load_lenient(f)
        except Exception as e:  # noqa: BLE001
            warnings.append(f"failed to parse {f.name}: {e}")
            continue
        if d.get("id"):
            wpn_files[d["id"]] = d

    weapons = {}
    for wid, row in weap_rows.items():
        w = wpn_files.get(wid, {})
        weapons[wid] = {
            "id": wid,
            "name": (row.get("name") or wid).strip(),
            "mountType": w.get("type"),          # from .wpn (CSV 'type' is damage type)
            "size": w.get("size"),
            "op": inum(row.get("OPs")) or 0,
            "range": inum(row.get("range")),
            "damagePerShot": fnum(row.get("damage/shot")),
            "damagePerSecond": fnum(row.get("damage/second")),
            "empDamage": fnum(row.get("emp")),
            "damageType": (row.get("type") or "").strip() or None,
            "fluxPerShot": fnum(row.get("energy/shot")),
            "fluxPerSecond": fnum(row.get("energy/second")),
            # shard keys; app fetches sprites/weapons/<id>.json on demand, 404-tolerant
            "turretSprite": f"weapons/{wid}",
            "hardpointSprite": f"weapons/{wid}",
        }
    wpn_only = [wid for wid in wpn_files if wid not in weap_rows]
    for wid in wpn_only:
        w = wpn_files[wid]
        weapons[wid] = {
            "id": wid, "name": wid, "mountType": w.get("type"), "size": w.get("size"),
            "op": 0, "range": None, "damagePerShot": None, "damagePerSecond": None,
            "empDamage": None, "damageType": None, "fluxPerShot": None,
            "fluxPerSecond": None,
            "turretSprite": f"weapons/{wid}", "hardpointSprite": f"weapons/{wid}",
        }
    if wpn_only:
        warnings.append(f".wpn files with no weapon_data.csv row: {wpn_only}")
    no_wpn = [wid for wid in weap_rows if wid not in wpn_files]
    if no_wpn:
        warnings.append(f"{len(no_wpn)} weapons have no .wpn file (mountType/size null, "
                        f"not fittable): {no_wpn[:12]}{'...' if len(no_wpn) > 12 else ''}")

    # weapon sprite shards: embed any local weapon PNGs (none in the current pull)
    weap_shards = 0
    for wid, w in wpn_files.items():
        shard = {}
        for key, field in (("turret", "turretSprite"), ("hardpoint", "hardpointSprite")):
            rel = w.get(field)
            if rel:
                p = SRC / rel
                if p.exists():
                    shard[key] = "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode()
        if shard:
            (OUT / "sprites/weapons" / f"{wid}.json").write_text(json.dumps(shard))
            weap_shards += 1

    # ---- ships ----------------------------------------------------------------
    def slot_list(ship_def):
        slots = []
        for ws in ship_def.get("weaponSlots", []):
            loc = ws.get("locations") or [0, 0]
            if len(loc) > 2:
                # LAUNCH_BAY slots carry a polygon: 4+ (fwd, lat) points -> centroid
                pts = list(zip(loc[0::2], loc[1::2]))
                x = sum(p[0] for p in pts) / len(pts)
                y = sum(p[1] for p in pts) / len(pts)
            else:
                x, y = float(loc[0]), float(loc[1])
            slots.append({
                "id": ws.get("id"),
                "type": ws.get("type"),
                "size": ws.get("size"),
                "mount": ws.get("mount"),
                "x": x,               # game coords: forward axis
                "y": y,               # game coords: lateral axis
                "angle": ws.get("angle", 0),
                "arc": ws.get("arc", 0),
            })
        return slots

    STAT_KEYS = ("designation", "manufacturer", "dp", "op", "fighterBays",
                 "hitpoints", "armor", "fluxCapacity", "fluxDissipation",
                 "maxSpeed", "shieldType", "shieldArc", "shieldEfficiency",
                 "phaseCost", "systemId", "baseValue")

    def stats_from_row(row):
        if row is None:
            return {k: (0 if k == "fighterBays" else None) for k in STAT_KEYS}
        return {
            "designation": (row.get("designation") or "").strip() or None,
            "manufacturer": (row.get("tech/manufacturer") or "").strip() or None,
            "dp": inum(row.get("fleet pts")),
            "op": inum(row.get("ordnance points")),
            "fighterBays": inum(row.get("fighter bays")) or 0,
            "hitpoints": inum(row.get("hitpoints")),
            "armor": inum(row.get("armor rating")),
            "fluxCapacity": inum(row.get("max flux")),
            "fluxDissipation": inum(row.get("flux dissipation")),
            "maxSpeed": inum(row.get("max speed")),
            "shieldType": (row.get("shield type") or "").strip() or None,
            "shieldArc": inum(row.get("shield arc")),
            "shieldEfficiency": fnum(row.get("shield efficiency")),
            "phaseCost": fnum(row.get("phase cost")),
            "systemId": (row.get("system id") or "").strip() or None,
            "baseValue": inum(row.get("base value")),
        }

    def sprite_shard(hull_id, sprite_rel):
        """Write sprites/ships/<hullId>.json if the PNG exists; return shard key."""
        if not sprite_rel:
            return None
        p = SRC / sprite_rel
        if not p.exists():
            return None
        data = "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode()
        (OUT / "sprites/ships" / f"{hull_id}.json").write_text(
            json.dumps({"sprite": data}))
        return f"ships/{hull_id}"

    ships = {}
    ship_defs = {}   # hullId -> parsed .ship (bases for skins)
    for f in sorted((SRC / "data/hulls").glob("*.ship")):
        try:
            d = load_lenient(f)
        except Exception as e:  # noqa: BLE001
            warnings.append(f"failed to parse {f.name}: {e}")
            continue
        hid = d.get("hullId")
        if not hid:
            warnings.append(f"{f.name}: no hullId, skipped")
            continue
        ship_defs[hid] = d
        row = ship_rows.get(hid)
        if row is None:
            warnings.append(f"{hid}: .ship file but no ship_data.csv row (stats null)")
        sprite_rel = d.get("spriteName")
        width, height = d.get("width"), d.get("height")
        if (width is None or height is None) and sprite_rel and (SRC / sprite_rel).exists():
            dims = png_size(SRC / sprite_rel)
            if dims:
                width, height = dims
        entry = {
            "id": hid,
            "name": (row.get("name") if row else None) or d.get("hullName") or hid,
            **stats_from_row(row),
            "hullSize": d.get("hullSize"),
            "sprite": sprite_shard(hid, sprite_rel),
            "center": d.get("center") or [0, 0],
            "collisionRadius": d.get("collisionRadius"),
            "width": width,
            "height": height,
            "slots": slot_list(d),
            "builtInWeapons": d.get("builtInWeapons") or {},
            "builtInMods": d.get("builtInMods") or [],
            "builtInWings": d.get("builtInWings") or [],
        }
        if entry["sprite"] is None and sprite_rel:
            pass  # sprite exists in game but was not in the local pull -- expected for most hulls
        ships[hid] = entry

    csv_only = [rid for rid in ship_rows if rid not in ship_defs]
    if csv_only:
        warnings.append(f"{len(csv_only)} ship_data.csv rows have no .ship file "
                        f"(no geometry, not emitted): {csv_only[:12]}"
                        f"{'...' if len(csv_only) > 12 else ''}")

    # ---- skins: extra ship entries layered on a base hull ---------------------
    skins_dir = SRC / "data/hulls/skins"
    skin_count = 0
    for f in sorted(skins_dir.glob("*.skin")):
        try:
            sk = load_lenient(f)
        except Exception as e:  # noqa: BLE001
            warnings.append(f"failed to parse skin {f.name}: {e}")
            continue
        base_id = sk.get("baseHullId")
        skin_id = sk.get("skinHullId") or f.stem
        base = ships.get(base_id)
        if base is None:
            warnings.append(f"skin {f.name}: base hull '{base_id}' not found, skipped")
            continue
        base_def = ship_defs[base_id]
        entry = json.loads(json.dumps(base))  # deep copy of base entry
        entry["id"] = skin_id
        entry["name"] = sk.get("hullName") or entry["name"]
        entry["isSkin"] = True
        entry["baseHullId"] = base_id
        # stats: skin's own CSV row if one exists, else base stats + skin overrides
        row = ship_rows.get(skin_id)
        if row is not None:
            entry.update(stats_from_row(row))
        else:
            if sk.get("ordnancePoints") is not None:
                entry["op"] = inum(sk["ordnancePoints"])
            if sk.get("fleetPoints") is not None:
                entry["dp"] = inum(sk["fleetPoints"])
            if sk.get("baseValueMult") is not None and entry.get("baseValue"):
                entry["baseValue"] = int(entry["baseValue"] * float(sk["baseValueMult"]))
            if sk.get("tech"):
                entry["manufacturer"] = sk["tech"]
        # slots / built-ins: base minus removals, plus skin additions
        remove_slots = set(sk.get("removeWeaponSlots") or [])
        if remove_slots:
            entry["slots"] = [s for s in entry["slots"] if s["id"] not in remove_slots]
        biw = dict(base_def.get("builtInWeapons") or {})
        for sid in sk.get("removeBuiltInWeapons") or []:
            biw.pop(sid, None)
        biw.update(sk.get("builtInWeapons") or {})
        entry["builtInWeapons"] = biw
        bim = [m for m in (base_def.get("builtInMods") or [])
               if m not in set(sk.get("removeBuiltInMods") or [])]
        for m in sk.get("builtInMods") or []:
            if m not in bim:
                bim.append(m)
        entry["builtInMods"] = bim
        # sprite: skin's own sprite if pulled locally, else fall back to base sprite
        entry["sprite"] = sprite_shard(skin_id, sk.get("spriteName")) or base["sprite"]
        ships[skin_id] = entry
        skin_count += 1

    # ---- hullmods: data/hullmods/hull_mods.csv --------------------------------
    hm_rows, hm_dupes = read_csv_by_id(SRC / "data/hullmods/hull_mods.csv")
    if hm_dupes:
        warnings.append(f"hull_mods.csv duplicate ids (kept first): {hm_dupes}")
    hullmods = {}
    hm_shards = 0
    for mid, row in hm_rows.items():
        sprite_rel = (row.get("sprite") or "").strip()
        icon = None
        if sprite_rel:
            p = SRC / sprite_rel
            if p.exists():
                data_uri = "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode()
                (OUT / "sprites/hullmods" / f"{mid}.json").write_text(
                    json.dumps({"icon": data_uri}))
                icon = f"hullmods/{mid}"   # shard key; app fetches sprites/hullmods/<id>.json
                hm_shards += 1
            else:
                warnings.append(f"hullmod {mid}: icon '{sprite_rel}' from CSV not on disk")
        hullmods[mid] = {
            "id": mid,
            "name": (row.get("name") or mid).strip(),
            "desc": (row.get("desc") or "").strip() or None,
            "short": (row.get("short") or "").strip() or None,
            "costs": {
                "FRIGATE": inum(row.get("cost_frigate")),
                "DESTROYER": inum(row.get("cost_dest")),
                "CRUISER": inum(row.get("cost_cruiser")),
                "CAPITAL_SHIP": inum(row.get("cost_capital")),
            },
            "hidden": (row.get("hidden") or "").strip().upper() == "TRUE",
            "hiddenEverywhere": (row.get("hiddenEverywhere") or "").strip().upper() == "TRUE",
            "tags": [t.strip() for t in (row.get("tags") or "").split(",") if t.strip()],
            "icon": icon,
        }

    # ---- wings: data/hulls/wing_data.csv ---------------------------------------
    wing_rows, wing_dupes = read_csv_by_id(SRC / "data/hulls/wing_data.csv")
    if wing_dupes:
        warnings.append(f"wing_data.csv duplicate ids (kept first): {wing_dupes}")
    variant_files = {p.stem for p in (SRC / "data/variants").rglob("*.variant")}
    wings = {}
    for wid, row in wing_rows.items():
        base = wid[:-5] if wid.endswith("_wing") else wid
        wings[wid] = {
            "id": wid,
            # wing_data.csv has no name column; display name derived from the
            # wing id (broadsword_wing -> "Broadsword", mining_drone_wing ->
            # "Mining Drone"). Matches the LPC names for vanilla wings.
            "name": " ".join(w.capitalize() for w in base.split("_")),
            "variant": (row.get("variant") or "").strip() or None,
            "op": inum(row.get("op cost")) or 0,
            "tier": inum(row.get("tier")),
            "rarity": fnum(row.get("rarity")),
            "numFighters": inum(row.get("num")),
            "role": (row.get("role desc") or row.get("role") or "").strip() or None,
            "refitTime": inum(row.get("refit")),
        }
    missing_variant = [wid for wid, w in wings.items()
                       if w["variant"] and w["variant"] not in variant_files]
    if missing_variant:
        warnings.append(f"wings referencing variant files absent from this pull: "
                        f"{[(wid, wings[wid]['variant']) for wid in missing_variant]}")

    # ---------------------------------------------------------------- output
    data = {"version": VERSION, "ships": ships, "weapons": weapons,
            "hullmods": hullmods, "wings": wings}
    (OUT / "data.json").write_text(json.dumps(data, separators=(",", ":")))

    with_sprites = [h for h, s in ships.items() if s["sprite"]]
    print(f"ships: {len(ships)} (base hulls {len(ship_defs)}, skins {skin_count})")
    print(f"weapons: {len(weapons)}")
    print(f"hullmods: {len(hullmods)} (icon shards {hm_shards})")
    print(f"wings: {len(wings)}")
    print(f"ships with local sprites: {len(with_sprites)} -> {sorted(with_sprites)}")
    print(f"weapon sprite shards written: {weap_shards}")
    print(f"data.json: {(OUT / 'data.json').stat().st_size} bytes")
    for w in warnings:
        print("WARN:", w)
    return 0

if __name__ == "__main__":
    sys.exit(main())
