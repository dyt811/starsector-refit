# Starsector campaign.xml — format notes for the save importer

Findings from reverse-engineering a real 0.98a-RC8 save
(`save_WindStalker_…/campaign.xml`, 12.7 MB, 113-ship player fleet),
October 2026. The importer in `app.js` (`parseSaveCompact` /
`parseSave`) implements exactly what is documented here.

## It is not plain XStream

A campaign.xml is the game's **compact object serialization**, not
semantic XML and not vanilla XStream:

- Class names are abbreviated in tags: `CampaignEngine` (root),
  `Flt` (a fleet), `FMmbr` (a fleet member), `Plnt`, `Sstm`, …
- Scalar fields live in **attributes** with abbreviated names, or in
  tiny child elements.
- Every serialized object carries `z="N"` — a document-unique id.
  A repeated object is written once; later mentions are stubs with
  `ref="N"` pointing at that id. There is no XPath referencing.
  (154,479 z-indexed objects in the reference save.)
- Sets are `<st>` text lists; maps are `<e>` elements whose children
  are the key/value pair.

## Finding the player fleet

`<playerFleet ref="98485"/>` appears once (inside the campaign
engine element). Resolving `98485` through the z-index lands on
`<Flt z="98485" n="Player Fleet" …>` — that is the player fleet.
Fallback if the stub is ever absent: the `Flt` whose `n` attribute
is `Player Fleet`.

The character's name is `characterData > name` (plain text), which
matches `descriptor.xml`'s `<characterName>` (the importer only
reads campaign.xml, so it uses the former).

Fleet members: `Flt > fD > m`, whose children are the `FMmbr`
elements inline (113 of them; other fleets' views reference the
same members by `ref`, so always enter through `fD/m`).

## Fleet member (FMmbr)

Attributes: `sN` = ship name, `t` = member type (`SHIP`;
fighter wings would be `FIGHTER_WING` and are skipped), `sid` =
the variant spec the member was created from.

Children:

- `savedVariant` — the member's current variant (below).
- `rT` — repair tracker; its **`cr` attribute** is the member's
  current combat readiness (0.0–1.0; 0.0 for mothballed ships).
- `status` — per-slot damage state; not needed here.

## Variant (savedVariant)

Attributes: `hId` = hull id, `v` = flux vents, `c` = flux
capacitors, `hVId` = the variant's own id, `vDN` = display name,
`s` = source (`REFIT`).

- **D-modded ships** serialize against a synthetic hull spec:
  `hId="legion_default_D"`. Strip the `_default_D` suffix to get
  the real hull/skin id (`onslaught`, `legion_xiv`, `falcon_p`, …).
  All 113 reference-save members resolve to viewer hulls this way.
- `wpn` — the flat slot→weapon map:
  `<e><st>WS 019</st><st>hephag</st></e>`. It includes built-in
  slots (e.g. the Onslaught's TPCs); importers must treat hull
  built-ins as locked, not fitted.
- `wG` — weapon groups. A `WGSpec` has `t` = mode (LINKED /
  ALTERNATING), `a` = autofire, and a child `<s>` holding a list
  of **slot ids** — groups partition slots; the weapons themselves
  come from `wpn`.
- `hM` — `<st>` list of **all** installed hullmods: built-ins,
  normal mods, D-mods, and s-mods together.
- `pM` — `<st>` list of permanent mods: D-mods **and** s-mods.
- `sMods` — `<st>` list of true s-mods only (a subset of `pM`).
  The importer passes only `sMods` through as zero-OP locked
  s-mods; D-mods stay in `hM` and cost OP normally, as in the game.
- `wng` — `<st>` list of wing ids, one per launch bay, **an empty
  `<st>` is an empty bay** (positions are meaningful).
- `originalVariant` (child, text) — the stock variant the ship's
  fit derives from, when any.

Vents/capacitors exceed the old 30 cap: the reference save has
capitals at 50 vents / a Conquest at 55. The editor therefore
allows up to 99.

Two reference-save ships compute **over** their OP budget
(HSS Ourea, an Onslaught at 390/360, and PLS Hoel, a Conquest at
355/315) — both carry legacy stock fits (`originalVariant`
lineage) that predate OP rebalances. The importer reports the
numbers as-is; every other member lands at or under budget, most
exactly at it, which cross-validates the whole mapping (weapon OP,
per-size hullmod costs, s-mods at 0, vents/caps at 1 each).

## descriptor.xml

Small sidecar in the save folder: character name, level, game
version, save date, mod list. The importer does not read it —
everything it needs is in campaign.xml.

## The other dialect

`parseSave` also accepts a plainer XStream-style layout (field-name
elements, `reference="relative/xpath"` stubs, `<entry>` map pairs,
`permaMods`/`smods` lists) — retained for hand-written fixtures
(`tests/fixture_campaign.xml`) and third-party tooling that emits
that shape. Real game saves always take the compact path.
