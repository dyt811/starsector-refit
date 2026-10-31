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

# ------------------------------------------------- hullmod effects (Java)
#
# Hullmod scripts that ship as source live in data/hullmods/*.java (scripts in
# com.fs.starfarer.api.impl.hullmods.* live in the game jar and are NOT in this
# pull). We statically extract the MutableShipStatsAPI modifiers the viewer
# models: weapon range (per class: ballistic/energy/missile/beam + the PD-only
# bonuses + Safety Overrides' range threshold), flux capacity/dissipation,
# armor, and the maneuvering stats.
#
# A modifier value is a number, or {"bySize": {FRIGATE: n, ...}} when the
# script keys it by HullSize (the ITU/DTC "mag" maps). s-mod branches are
# stripped (the viewer does not model s-mods), and anything the parser cannot
# resolve statically (e.g. D-mod severity scaling in CompromisedArmor) is
# skipped with a warning.

HULLMOD_GETTERS = {
    "getBallisticWeaponRangeBonus": ("range", "ballistic"),
    "getEnergyWeaponRangeBonus": ("range", "energy"),
    "getMissileWeaponRangeBonus": ("range", "missile"),
    "getBeamWeaponRangeBonus": ("range", "beam"),
    "getNonBeamPDWeaponRangeBonus": ("range", "pdNonBeam"),
    "getBeamPDWeaponRangeBonus": ("range", "pdBeam"),
    "getWeaponRangeThreshold": ("range", "threshold"),
    "getWeaponRangeMultPastThreshold": ("range", "multPastThreshold"),
    "getFluxCapacity": ("fluxCapacity", None),
    "getFluxDissipation": ("fluxDissipation", None),
    "getArmorBonus": ("armor", None),
    "getMaxSpeed": ("maxSpeed", None),
    "getAcceleration": ("acceleration", None),
    "getDeceleration": ("deceleration", None),
    "getMaxTurnRate": ("maxTurnRate", None),
    "getTurnAcceleration": ("turnAcceleration", None),
}
HULL_SIZES = ("FIGHTER", "FRIGATE", "DESTROYER", "CRUISER", "CAPITAL_SHIP")


def strip_java_comments(src):
    out, i, n, state = [], 0, len(src), None
    while i < n:
        c = src[i]
        if state:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(src[i + 1]); i += 2; continue
            if c == state:
                state = None
            i += 1
        elif c in "\"'":
            state = c; out.append(c); i += 1
        elif c == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n":
                i += 1
        elif c == "/" and i + 1 < n and src[i + 1] == "*":
            i += 2
            while i + 1 < n and not (src[i] == "*" and src[i + 1] == "/"):
                i += 1
            i += 2
        else:
            out.append(c); i += 1
    return "".join(out)


def eval_num_expr(expr, consts):
    """Evaluate a Java float expression over known constants, safely."""
    # strip Java numeric suffixes FIRST (else "0f" parses 'f' as an identifier)
    e = re.sub(r"(\d+(?:\.\d+)?)[fFlL]\b", r"\1", expr)
    def repl(m):
        name = m.group(0)
        if name in consts:
            return repr(consts[name])
        raise KeyError(name)
    try:
        e = re.sub(r"[A-Za-z_]\w*", repl, e)
    except KeyError:
        return None
    if not re.fullmatch(r"[0-9\.\s\+\-\*/\(\)]+", e):
        return None
    try:
        return float(eval(e, {"__builtins__": {}}, {}))  # noqa: S307 - sanitized above
    except Exception:  # noqa: BLE001
        return None


def paren_span(s, open_idx):
    """(inner_text, index_after_close) for the '(' at open_idx."""
    depth, j = 0, open_idx
    while j < len(s):
        if s[j] == "(":
            depth += 1
        elif s[j] == ")":
            depth -= 1
            if depth == 0:
                return s[open_idx + 1:j], j + 1
        j += 1
    return s[open_idx + 1:], len(s)


def method_body(src, name):
    """Body of the method declaration `name` (any return type; skips call sites)."""
    for m in re.finditer(r"\b" + re.escape(name) + r"\s*\(", src):
        _, after = paren_span(src, m.end() - 1)
        k = after
        while k < len(src) and src[k] in " \t\r\n":
            k += 1
        if k >= len(src) or src[k] != "{":
            continue  # a call site, not the declaration
        depth, j = 0, k
        while j < len(src):
            if src[j] == "{":
                depth += 1
            elif src[j] == "}":
                depth -= 1
                if depth == 0:
                    return src[k + 1:j]
            j += 1
    return None


def _branch_span(body, pos):
    """Span (content_start, content_end, total_end) of a then/else branch at pos."""
    i = pos
    while i < len(body) and body[i] in " \t\r\n":
        i += 1
    if i < len(body) and body[i] == "{":
        depth, j = 0, i
        while j < len(body):
            if body[j] == "{":
                depth += 1
            elif body[j] == "}":
                depth -= 1
                if depth == 0:
                    return i + 1, j, j + 1
            j += 1
        return i + 1, len(body), len(body)
    semi = body.index(";", i)
    return i, semi + 1, semi + 1


def remove_smod_branches(body):
    """Drop `if (sMod) ...` code (viewer does not model s-mods); keep `!sMod`."""
    while True:
        m = re.search(r"if\s*\(\s*(!?)\s*(?:sMod\b|isSMod\s*\()", body)
        if not m:
            return body
        negated = m.group(1) == "!"
        _, cond_end = paren_span(body, body.index("(", m.start()))
        cs, ce, te = _branch_span(body, cond_end)
        k = te
        while k < len(body) and body[k] in " \t\r\n":
            k += 1
        else_span = None
        if body.startswith("else", k) and (k + 4 >= len(body)
                                           or not (body[k + 4].isalnum() or body[k + 4] == "_")):
            else_span = _branch_span(body, k + 4)
        if not negated:
            if else_span:
                body = body[:m.start()] + body[else_span[0]:else_span[1]] + body[else_span[2]:]
            else:
                body = body[:m.start()] + body[te:]
        else:
            tail = body[else_span[2]:] if else_span else body[te:]
            body = body[:m.start()] + body[cs:ce] + tail


def split_top_commas(s):
    parts, depth, cur = [], 0, []
    for c in s:
        if c in "([":
            depth += 1
        elif c in ")]":
            depth -= 1
        if c == "," and depth == 0:
            parts.append("".join(cur)); cur = []
        else:
            cur.append(c)
    parts.append("".join(cur))
    return parts


def split_ternary(expr):
    depth, q = 0, -1
    for i, c in enumerate(expr):
        if c in "([":
            depth += 1
        elif c in ")]":
            depth -= 1
        elif c == "?" and depth == 0:
            q = i; break
    if q < 0:
        return None
    depth, nest = 0, 0
    for j in range(q + 1, len(expr)):
        c = expr[j]
        if c in "([":
            depth += 1
        elif c in ")]":
            depth -= 1
        elif c == "?" and depth == 0:
            nest += 1
        elif c == ":" and depth == 0:
            if nest == 0:
                return expr[:q], expr[q + 1:j], expr[j + 1:]
            nest -= 1
    return None


class JavaHullmod:
    """One data/hullmods/*.java source: constants, HullSize maps, effects."""

    def __init__(self, path):
        self.name = path.stem
        self.src = strip_java_comments(path.read_text(encoding="utf-8", errors="replace"))
        self.consts = {}
        self.maps = {}
        pat = re.compile(r"static\s+(?:final\s+)?(?:float|int|double)\s+(\w+)\s*=\s*([^;]+);")
        for _ in range(5):
            progressed = False
            for m in pat.finditer(self.src):
                if m.group(1) in self.consts:
                    continue
                v = eval_num_expr(m.group(2), self.consts)
                if v is not None:
                    self.consts[m.group(1)] = v
                    progressed = True
            if not progressed:
                break
        for m in re.finditer(r"(\w+)\.put\(\s*HullSize\.(\w+)\s*,\s*([^)]+)\)", self.src):
            v = eval_num_expr(m.group(3), self.consts)
            if v is not None:
                self.maps.setdefault(m.group(1), {})[m.group(2)] = v


def resolve_value(expr, jcls, locals_, map_alias, registry):
    """Resolve a modify*(id, EXPR) argument to a number or {"bySize": {...}}."""
    expr = re.sub(r"\(\s*(?:float|int|double|Float|Integer)\s*\)", "", expr).strip()
    expr = re.sub(r"(\d+(?:\.\d+)?)[fFlL]\b", r"\1", expr)  # numeric suffixes
    if "sMod" in expr:
        t = split_ternary(expr)
        if t:
            cond, a, b = t
            expr = (a if "!" in cond else b).strip()
    m = re.fullmatch(
        r"(?:\(\s*Float\s*\)\s*)?(?:(\w+)\.)?(\w+)\.get\(\s*hullSize\s*\)"
        r"\s*(?:([*/])\s*(.+))?", expr)
    if m:
        cls, var, op, factor = m.groups()
        mp = None
        if cls:
            jc = registry.get(cls)
            mp = jc.maps.get(var) if jc else None
        elif var in map_alias:
            mp = map_alias[var]
        else:
            mp = jcls.maps.get(var)
        if mp is None:
            return None
        if op:
            f = eval_num_expr(factor, jcls.consts)
            if f is None:
                return None
            return {"bySize": {k: (v * f if op == "*" else v / f) for k, v in mp.items()}}
        return {"bySize": dict(mp)}
    if re.fullmatch(r"[A-Za-z_]\w*", expr):
        if expr in jcls.consts:
            return jcls.consts[expr]
        return locals_.get(expr)
    def sub(mo):
        name = mo.group(0)
        if name in jcls.consts:
            return repr(jcls.consts[name])
        v = locals_.get(name)
        if isinstance(v, (int, float)):
            return repr(v)
        raise KeyError(name)
    try:
        e = re.sub(r"[A-Za-z_]\w*", sub, expr)
    except KeyError:
        return None
    return eval_num_expr(e, {})


def combine_specs(a, b, kind):
    if a is None:
        return b
    if isinstance(a, dict) or isinstance(b, dict):
        da = a["bySize"] if isinstance(a, dict) else {s: a for s in HULL_SIZES}
        db = b["bySize"] if isinstance(b, dict) else {s: b for s in HULL_SIZES}
        out = {}
        for s in HULL_SIZES:
            va, vb = da.get(s), db.get(s)
            if kind == "mult":
                out[s] = (1 if va is None else va) * (1 if vb is None else vb)
            else:
                out[s] = (0 if va is None else va) + (0 if vb is None else vb)
        return {"bySize": out}
    return a * b if kind == "mult" else a + b


def clean_spec(spec):
    """Collapse uniform bySize maps to a scalar; round float noise away."""
    if isinstance(spec, dict):
        vals = spec["bySize"]
        if len(set(vals.values())) == 1 and len(vals) == len(HULL_SIZES):
            return round(float(next(iter(vals.values()))), 4)
        return {"bySize": {k: round(float(v), 4) for k, v in vals.items()}}
    return round(float(spec), 4)


def parse_hullmod_effects(jcls, registry):
    effects, notes = {}, []
    bodies = []
    for name in ("applyEffectsBeforeShipCreation", "applyEffectsAfterShipCreation"):
        b = method_body(jcls.src, name)
        if b:
            bodies.append(remove_smod_branches(b))
    for body in bodies:
        map_alias, locals_ = {}, {}
        for m in re.finditer(r"\bMap\s+(\w+)\s*=\s*(?:(\w+)\.)?(\w+)\s*;", body):
            var, cls, target = m.groups()
            jc = registry.get(cls) if cls else None
            mp = (jc.maps.get(target) if jc else
                  jcls.maps.get(target) if not cls else None)
            if mp is not None:
                map_alias[var] = mp
        for m in re.finditer(r"\bfloat\s+(\w+)\s*=\s*([^;]+);", body):
            locals_[m.group(1)] = resolve_value(m.group(2), jcls, locals_, map_alias, registry)
        call_re = re.compile(r"stats\s*\.\s*(get\w+)\s*\(\s*\)\s*\.\s*modify(Percent|Flat|Mult)\s*\(")
        for m in call_re.finditer(body):
            getter, kind = m.group(1), m.group(2)
            if getter not in HULLMOD_GETTERS:
                continue
            args_text, _ = paren_span(body, m.end() - 1)
            args = split_top_commas(args_text)
            if len(args) < 2:
                continue
            spec = resolve_value(args[1], jcls, locals_, map_alias, registry)
            if spec is None:
                notes.append(f"{jcls.name}: unresolved {getter}.modify{kind}"
                             f"({args[1].strip()[:48]})")
                continue
            key, group = HULLMOD_GETTERS[getter]
            target = effects.setdefault("range", {}).setdefault(group, {}) if group \
                else effects.setdefault(key, {})
            kind = kind.lower()
            target[kind] = combine_specs(target.get(kind), spec, kind)
    # prune neutral modifiers (flat 0 / percent 0 / mult 1) and empty stats
    def prune(stat):
        out = {}
        for kind, spec in stat.items():
            spec = clean_spec(spec)
            if kind in ("flat", "percent") and spec == 0:
                continue
            if kind == "mult" and spec == 1:
                continue
            out[kind] = spec
        return out
    cleaned = {}
    for key, val in effects.items():
        if key == "range":
            groups = {g: prune(s) for g, s in val.items()}
            groups = {g: s for g, s in groups.items() if s}
            if groups:
                cleaned["range"] = groups
        else:
            p = prune(val)
            if p:
                cleaned[key] = p
    return cleaned, notes


def parse_hullmod_applicability(jcls, known_ids):
    """incompatibleWith / onlySizes / blockedSizes from isApplicableToShip."""
    body = method_body(jcls.src, "isApplicableToShip")
    if not body:
        return {"incompatibleWith": [], "onlySizes": None, "blockedSizes": []}
    incompat = set()
    ref_re = re.compile(
        r"(?:getHullMods\(\)\s*\.\s*contains|hasHullMod)"
        r"\(\s*(?:\"([^\"]+)\"|HullMods\.(\w+))\s*\)")

    def hid_of(m):
        if m.group(1):
            return m.group(1)
        cand = (m.group(2) or "").lower()
        if cand in known_ids:
            return cand
        # HullMods constants are not always the id verbatim (FLUX_SHUNT -> fluxshunt)
        squashed = cand.replace("_", "")
        for kid in known_ids:
            if kid.replace("_", "") == squashed:
                return kid
        return cand

    def negated_before(text, start):
        # walk back over the dotted receiver chain: "!ship.getVariant().<ref>"
        i = start - 1
        while i >= 0 and (text[i].isalnum() or text[i] in "._$() \t\r\n"):
            i -= 1
        return i >= 0 and text[i] == "!"

    # return expressions: a negated reference (!contains(X)) excludes X
    for m in re.finditer(r"\breturn\b", body):
        semi = body.find(";", m.end())
        seg = body[m.end():semi if semi > 0 else len(body)]
        for m2 in ref_re.finditer(seg):
            if negated_before(seg, m2.start()):
                hid = hid_of(m2)
                if hid in known_ids:
                    incompat.add(hid)
    # `if (...) return false` guards: positive references exclude; == sizes block
    blocked = set()
    for m in re.finditer(r"if\s*\(", body):
        cond, after_idx = paren_span(body, m.end() - 1)
        after = body[after_idx:after_idx + 40]
        if re.match(r"\s*\{?\s*return\s+false", after):
            for s in re.findall(r"getHullSize\(\)\s*==\s*HullSize\.(\w+)", cond):
                blocked.add(s)
            for m2 in ref_re.finditer(cond):
                if not negated_before(cond, m2.start()):
                    hid = hid_of(m2)
                    if hid in known_ids:
                        incompat.add(hid)
    eq = set(re.findall(r"getHullSize\(\)\s*==\s*HullSize\.(\w+)", body))
    only = sorted(eq - blocked) or None
    return {"incompatibleWith": sorted(incompat), "onlySizes": only,
            "blockedSizes": sorted(blocked)}


# Hand-encoded special cases. These hullmods' scripts ship in the game jar
# (com.fs.starfarer.api.impl.hullmods.*), not in this data pull, so they can
# not be parsed above. Their mechanics below are transcribed from the in-game
# tooltips (cross-checked against the hullmod documentation):
# - Ballistic Rangefinder: per-weapon BASE range bonus for non-PD weapons in
#   BALLISTIC slots (applied before percent/mult bonuses; other bonuses then
#   apply to the raised base). If the ship has a large ballistic slot: small
#   slots +200, medium +100, result capped at 900. Otherwise small +100,
#   capped at 800. Destroyers and up only.
# - High Scatter Amplifier: beam weapons with base range over 200 have their
#   base range set to 200 + (range - 200) * 0.5 before other bonuses.
HULLMOD_SPECIALS = {
    "ballistic_rangefinder": {
        "special": "ballistic_rangefinder",
        "onlySizes": ["DESTROYER", "CRUISER", "CAPITAL_SHIP"],
    },
    "high_scatter_amp": {
        "special": "high_scatter_amp",
        "incompatibleWith": ["advancedoptics"],
    },
}

# ---------------------------------------------------------------- main

def main():
    warnings = []
    for sub in ("ships", "weapons", "hullmods"):
        (OUT / "sprites" / sub).mkdir(parents=True, exist_ok=True)
    ship_rows, ship_dupes = read_csv_by_id(SRC / "data/hulls/ship_data.csv")
    weap_rows, weap_dupes = read_csv_by_id(SRC / "data/weapons/weapon_data.csv")

    # ---- weapon descriptions: data/strings/descriptions.csv (optional) -------
    # Schema: id,type,text1..text5,notes. WEAPON rows carry the description in
    # text1 (later text columns are rare continuations). Absent file -> no desc.
    descriptions = {}
    desc_path = SRC / "data/strings/descriptions.csv"
    if desc_path.exists():
        with desc_path.open(newline="", encoding="utf-8", errors="replace") as fh:
            for row in csv.DictReader(fh):
                rid = (row.get("id") or "").strip()
                if not rid or (row.get("type") or "").strip() != "WEAPON":
                    continue
                txt = "\n\n".join(
                    t for t in ((row.get(f"text{i}") or "").strip() for i in range(1, 6)) if t)
                if txt:
                    descriptions[rid] = txt
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

    def weapon_extra(wid, row):
        """Spec-card fields beyond the core stats (row = weapon_data.csv row)."""
        hints = [h.strip() for h in (row.get("hints") or "").split(",")] if row else []
        return {
            "ammo": inum(row.get("ammo")) if row else None,
            "burstSize": inum(row.get("burst size")) if row else None,
            "burstDelay": fnum(row.get("burst delay")) if row else None,
            "projSpeed": inum(row.get("proj speed")) if row else None,
            # beams are the rows with a beam speed; PD bonuses key off the hints
            "beam": bool(row and fnum(row.get("beam speed"))),
            "pd": any(h in ("PD", "PD_ONLY") for h in hints),
            "role": ((row.get("primaryRoleStr") or "").strip() or None) if row else None,
            "turnRate": fnum(row.get("turn rate")) if row else None,
            "desc": descriptions.get(wid),
        }

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
            **weapon_extra(wid, row),
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
            **weapon_extra(wid, None),
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
                 "maxSpeed", "acceleration", "deceleration", "maxTurnRate",
                 "turnAcceleration", "shieldType", "shieldArc", "shieldEfficiency",
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
            "acceleration": inum(row.get("acceleration")),
            "deceleration": inum(row.get("deceleration")),
            "maxTurnRate": inum(row.get("max turn rate")),
            "turnAcceleration": inum(row.get("turn acceleration")),
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

    # ---- hullmod effects + applicability from the local .java sources --------
    java_mods = {}
    for f in sorted((SRC / "data/hullmods").glob("*.java")):
        java_mods[f.stem] = JavaHullmod(f)
    for mid, entry in hullmods.items():
        script = (hm_rows[mid].get("script") or "").strip()
        if not script.startswith("data.hullmods."):
            continue  # jar script (com.fs.starfarer.api.impl.hullmods.*): no source
        jcls = java_mods.get(script.rsplit(".", 1)[-1])
        if jcls is None:
            warnings.append(f"hullmod {mid}: script {script} but no local .java source")
            continue
        effects, notes = parse_hullmod_effects(jcls, java_mods)
        warnings.extend(notes)
        if effects:
            entry["effects"] = effects
        appl = parse_hullmod_applicability(jcls, set(hullmods))
        if appl["incompatibleWith"]:
            entry["incompatibleWith"] = appl["incompatibleWith"]
        if appl["onlySizes"]:
            entry["onlySizes"] = appl["onlySizes"]
        if appl["blockedSizes"]:
            entry["blockedSizes"] = appl["blockedSizes"]
    # hand-encoded specials for jar-only scripts (see HULLMOD_SPECIALS)
    for mid, spec in HULLMOD_SPECIALS.items():
        if mid not in hullmods:
            continue
        for k, v in spec.items():
            if k == "incompatibleWith":
                inc = set(hullmods[mid].get("incompatibleWith") or []) | set(v)
                hullmods[mid]["incompatibleWith"] = sorted(inc)
            else:
                hullmods[mid][k] = v
    # incompatibilities are symmetric in the game's UI
    for mid, entry in hullmods.items():
        for other in list(entry.get("incompatibleWith") or []):
            if other in hullmods:
                lst = hullmods[other].setdefault("incompatibleWith", [])
                if mid not in lst:
                    lst.append(mid)
                    hullmods[other]["incompatibleWith"] = sorted(lst)

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
    print(f"weapon descriptions from descriptions.csv: "
          f"{sum(1 for w in weapons.values() if w.get('desc'))} "
          f"({'present' if desc_path.exists() else 'ABSENT'})")
    print(f"hullmods: {len(hullmods)} (icon shards {hm_shards})")
    eff_ids = sorted(m for m, e in hullmods.items() if e.get("effects"))
    print(f"hullmods with parsed effects: {len(eff_ids)} -> {eff_ids}")
    for check in ("targetingunit", "dedicated_targeting_core", "advancedcore",
                  "advancedoptics", "eccm", "unstable_injector", "safetyoverrides",
                  "ballistic_rangefinder", "high_scatter_amp"):
        e = hullmods.get(check) or {}
        print(f"  check {check}: effects={e.get('effects')} "
              f"incompatible={e.get('incompatibleWith')} onlySizes={e.get('onlySizes')} "
              f"blocked={e.get('blockedSizes')} special={e.get('special')}")
    print(f"wings: {len(wings)}")
    print(f"ships with local sprites: {len(with_sprites)} -> {sorted(with_sprites)}")
    print(f"weapon sprite shards written: {weap_shards}")
    print(f"data.json: {(OUT / 'data.json').stat().st_size} bytes")
    for w in warnings:
        print("WARN:", w)
    return 0

if __name__ == "__main__":
    sys.exit(main())
