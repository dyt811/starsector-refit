// V5 verification suite — game-fidelity refit UI
const { chromium } = require("playwright-core");

const BASE = "http://localhost:8901/index.html";
const FIXTURE = "/home/hatch/workspace/starsector-refit/tests/fixture_campaign.xml";
const REAL = "/home/hatch/workspace/starsector-onslaught-3d/gamedata/savesample/campaign.xml";
const SHOTS = "/tmp/shots";
require("fs").mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    // resource-load failures (e.g. Google Fonts in this sandbox) are network
    // noise, not JS errors — pageerror is the real signal
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text());
  });

  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => typeof S !== "undefined" && S.data && S.shipId, null, { timeout: 30000 });
  check("app boots with data", true);

  // ---------- picker flow on a deterministic ship/slot ----------
  const slotInfo = await page.evaluate(() => {
    // find a hull with a fittable, non-locked slot that has legal weapons
    for (const sh of Object.values(S.data.ships)) {
      for (const slot of sh.slots) {
        if (isLocked(slot.id) || !SLOT_FIT[slot.type]) continue;
        selectShip(sh.id);
        if (legalWeapons(slot).length >= 3) return { shipId: sh.id, slotId: slot.id, size: slot.size };
      }
    }
    return null;
  });
  check("found a fittable slot for picker test", !!slotInfo, JSON.stringify(slotInfo));

  async function slotPos(slotId) {
    return page.evaluate((sid) => {
      draw();
      const e = S.slotScreen.find((x) => x.slot.id === sid);
      const r = document.getElementById("canvas").getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      return { x: r.left + e.sx / dpr, y: r.top + e.sy / dpr };
    }, slotId);
  }

  let pos = await slotPos(slotInfo.slotId);
  await page.mouse.click(pos.x, pos.y);
  await page.waitForTimeout(150);
  const pickerOpen = await page.evaluate(() =>
    document.getElementById("picker").classList.contains("open"));
  check("click slot → picker opens", pickerOpen);
  const headText = await page.textContent("#picker-head");
  check("picker head names the slot", headText.includes(slotInfo.slotId), headText.trim().slice(0, 60));

  // hover a row → floating spec card appears with the weapon's name
  const rowCount = await page.locator("#picker-list .weapon-row2").count();
  check("picker lists legal weapons", rowCount >= 3, `${rowCount} rows`);
  const firstRow = page.locator("#picker-list .weapon-row2").first();
  const firstName = await firstRow.locator(".wr-name").textContent();
  await firstRow.hover();
  await page.waitForTimeout(250);
  const floatVisible = await page.evaluate(() => {
    const f = document.getElementById("spec-float");
    const r = f.getBoundingClientRect();
    return !f.hidden && r.width > 100 && r.height > 50;
  });
  const floatText = await page.textContent("#spec-float");
  check("hover row → floating spec card", floatVisible && floatText.includes(firstName.trim()),
    `card for ${firstName.trim()}`);
  check("floating card carries full spec data", /Effective range|Base range|Damage/.test(floatText));

  await page.screenshot({ path: `${SHOTS}/v5-picker.png` });

  // click the row → fitted + picker closes
  const firstWid = await firstRow.getAttribute("data-fit");
  await firstRow.click();
  await page.waitForTimeout(150);
  const afterFit = await page.evaluate((sid) => ({
    fitted: S.build.weapons[sid],
    open: document.getElementById("picker").classList.contains("open"),
  }), slotInfo.slotId);
  check("click weapon → fitted", afterFit.fitted === firstWid, `${slotInfo.slotId} = ${afterFit.fitted}`);
  check("picker closes on fit", afterFit.open === false);

  // right-click the fitted slot on canvas → cleared
  pos = await slotPos(slotInfo.slotId);
  await page.mouse.click(pos.x, pos.y, { button: "right" });
  await page.waitForTimeout(150);
  const afterClear = await page.evaluate((sid) => S.build.weapons[sid] || null, slotInfo.slotId);
  check("right-click slot clears it", afterClear === null);

  // Esc closes the picker without change
  await page.mouse.click(pos.x, pos.y);
  await page.waitForTimeout(120);
  const openAgain = await page.evaluate(() =>
    document.getElementById("picker").classList.contains("open"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
  const afterEsc = await page.evaluate(() => ({
    open: document.getElementById("picker").classList.contains("open"),
    sel: S.selectedSlot,
  }));
  check("Esc closes picker", openAgain && afterEsc.open === false);

  // clicking another slot retargets the picker — use the two fittable slots
  // farthest apart on screen so the hit test is unambiguous
  const two = await page.evaluate(() => {
    draw();
    const pts = S.slotScreen.filter((e) => !isLocked(e.slot.id) && SLOT_FIT[e.slot.type]);
    let best = null, bd = -1;
    for (const a of pts) for (const b of pts) {
      const d = (a.sx - b.sx) ** 2 + (a.sy - b.sy) ** 2;
      if (d > bd) { bd = d; best = [a.slot.id, b.slot.id]; }
    }
    return best;
  });
  if (two.length >= 2) {
    const pA = await slotPos(two[0]);
    await page.mouse.click(pA.x, pA.y);
    await page.waitForTimeout(100);
    const pB = await slotPos(two[1]);
    await page.mouse.click(pB.x, pB.y);
    await page.waitForTimeout(150);
    const head2 = await page.textContent("#picker-head");
    const stillOpen = await page.evaluate(() =>
      document.getElementById("picker").classList.contains("open"));
    check("clicking another slot retargets picker", stillOpen && head2.includes(two[1]), `now on ${two[1]}`);
    await page.keyboard.press("Escape");
  } else {
    check("clicking another slot retargets picker", false, "ship has <2 fittable slots");
  }

  // ---------- size chips adapt to a SMALL slot ----------
  const small = await page.evaluate(() => {
    for (const sh of Object.values(S.data.ships)) {
      const slot = sh.slots.find((s) => !isLocked(s.id) && SLOT_FIT[s.type] && s.size === "SMALL" && legalWeapons(s).length);
      if (slot) { selectShip(sh.id); draw(); return { shipId: sh.id, slotId: slot.id }; }
    }
    return null;
  });
  check("found a SMALL slot", !!small, JSON.stringify(small));
  if (small) {
    const sp = await slotPos(small.slotId);
    await page.mouse.click(sp.x, sp.y);
    await page.waitForTimeout(150);
    const chips = await page.evaluate(() =>
      [...document.querySelectorAll("#picker-controls [data-wsize]")].map((b) => b.dataset.wsize));
    check("size chips adapt to SMALL slot", JSON.stringify(chips) === JSON.stringify(["ALL", "SMALL"]),
      chips.join(","));
    await page.keyboard.press("Escape");
  }

  await page.screenshot({ path: `${SHOTS}/v5-layout.png` });

  // ---------- fixture save import ----------
  await page.setInputFiles("#save-picker", FIXTURE);
  await page.waitForFunction(() => S.fleet, null, { timeout: 15000 });
  const fx = await page.evaluate(() => ({
    n: S.fleet.members.length,
    method: S.fleet.method,
    stripChips: document.querySelectorAll("#fleet-strip .fleet-chip").length,
    stripHidden: document.getElementById("fleet-strip").hidden,
  }));
  check("fixture save parses", fx.n >= 1, `${fx.n} members via ${fx.method}`);
  check("fleet strip appears with fixture", !fx.stripHidden && fx.stripChips === fx.n, `${fx.stripChips} chips`);

  // ---------- real save import: counts + strip + open ship OP ----------
  // the real sample lives outside the repo (a pull from the game install);
  // skip gracefully where it is absent
  if (!require("fs").existsSync(REAL)) {
    console.log("SKIP  real-save checks — sample not present on this machine");
  } else {
  await page.setInputFiles("#save-picker", REAL);
  await page.waitForFunction(() => S.fleet && S.fleet.members.length > 50, null, { timeout: 60000 });
  const real = await page.evaluate(() => ({ n: S.fleet.members.length }));
  check("real save parses to 113 ships", real.n === 113, `${real.n} members`);

  const expected = await page.evaluate(() => {
    // pick the first member whose hull is in viewer data and has weapons fitted
    for (let i = 0; i < S.fleet.members.length; i++) {
      const m = S.fleet.members[i];
      const sh = S.data.ships[m.hullId];
      if (!sh) continue;
      const b = fleetMemberBuild(m);
      if (!Object.keys(b.weapons || {}).length) continue;
      const op = opBreakdownFor(sh, {
        weapons: { ...sh.builtInWeapons, ...b.weapons },
        hullMods: [...(sh.builtInMods || []), ...b.hullMods, ...b.smods],
        smods: b.smods, vents: b.fluxVents || 0, caps: b.fluxCapacitors || 0, wings: b.wings,
      });
      if (op.total < 50) continue;   // want a ship with a real, non-trivial loadout
      return { i, hullId: m.hullId, total: op.total, budget: op.budget };
    }
    return null;
  });
  check("found an openable real-save ship", !!expected, JSON.stringify(expected));
  if (expected) {
    await page.evaluate((i) => openFleetMember(i), expected.i);
    await page.waitForTimeout(300);
    const opened = await page.evaluate(() => ({
      hull: S.shipId, total: opBreakdown().total, budget: opBreakdown().budget,
      activeChip: !!document.querySelector("#fleet-strip .fleet-chip.active"),
      activeRow: !!document.querySelector("#fleet-view .fleet-member.active"),
    }));
    check("save ship opens in editor", opened.hull === expected.hullId, opened.hull);
    check("opened ship OP matches save loadout", opened.total === expected.total && opened.budget === expected.budget,
      `${opened.total}/${opened.budget} vs expected ${expected.total}/${expected.budget}`);
    check("active ship highlighted in strip + panel", opened.activeChip && opened.activeRow);
  }
  await page.screenshot({ path: `${SHOTS}/v5-fleet.png` });
  }

  check("zero JS errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("SUITE ERROR:", e); process.exit(2); });
