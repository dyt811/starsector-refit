// V6 verification suite — test-flight movement sandbox
// Run: NODE_PATH=/tmp/pwtest/node_modules node tests/v6test.js
// (expects the repo served at http://localhost:8901, like v5test.js)
const { chromium } = require("playwright-core");

const BASE = "http://localhost:8901/index.html";
const SHOTS = "/tmp/shots";
require("fs").mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text());
  });

  await page.goto(BASE, { waitUntil: "load" });
  await page.waitForFunction(() => typeof S !== "undefined" && S.data && S.shipId, null, { timeout: 30000 });
  check("app boots with data", true);

  // ---------- deterministic ship: Onslaught XIV ----------
  await page.evaluate(() => selectShip("onslaught_xiv"));
  await page.waitForFunction(() => S.shipImg, null, { timeout: 15000 }).catch(() => {});
  const truth = await page.evaluate(() => ({
    v0: effShipStat("maxSpeed"),
    acc: effShipStat("acceleration"),
    weapons: JSON.parse(JSON.stringify(S.build.weapons)),
    vents: S.build.vents, caps: S.build.caps,
    mods: [...S.build.hullMods],
  }));
  // base 25, Fourteenth Battlegroup x0.92 -> 23
  check("ground truth: XIV effective max speed is 23", near(truth.v0, 23, 0.05), `v0=${truth.v0}`);

  // ---------- enter flight through the real button ----------
  await page.click("#flight-btn");
  await page.waitForFunction(() => window.__flight && window.__flight.active, null, { timeout: 5000 });
  const entered = await page.evaluate(() => ({
    hudHidden: document.getElementById("flight-hud").hidden,
    stageClass: document.getElementById("stage").classList.contains("flight"),
    btn: document.getElementById("flight-btn").textContent,
  }));
  check("test flight engages", !entered.hudHidden && entered.stageClass && /refit/i.test(entered.btn),
    `btn="${entered.btn}"`);

  // ---------- thrust run 1: approach but never exceed the cap ----------
  await page.keyboard.down("KeyW");
  await page.waitForFunction((v) => window.__flight.speed > v * 0.92, truth.v0, { timeout: 25000 });
  const run1 = await page.evaluate(() => window.__flight.speed);
  await page.screenshot({ path: `${SHOTS}/v6-flight.png` });
  await page.keyboard.up("KeyW");
  check("thrust approaches effective max speed", run1 >= truth.v0 * 0.9, `speed=${run1.toFixed(1)} vs cap ${truth.v0}`);
  check("thrust never exceeds the cap", run1 <= truth.v0 + 0.75, `speed=${run1.toFixed(1)} vs cap ${truth.v0}`);

  // ---------- drift: no drag below the cap ----------
  const s1 = await page.evaluate(() => window.__flight.speed);
  await page.waitForTimeout(2000);
  const s2 = await page.evaluate(() => window.__flight.speed);
  check("coasting keeps velocity (drift)", s2 >= s1 * 0.95 && s2 <= s1 + 0.01, `${s1.toFixed(1)} -> ${s2.toFixed(1)} over 2s`);

  // ---------- reset ----------
  await page.keyboard.press("KeyR");
  await page.waitForTimeout(120);
  const rs = await page.evaluate(() => ({ sp: window.__flight.speed, x: window.__flight.x, y: window.__flight.y }));
  check("R resets position and velocity", rs.sp === 0 && rs.x === 0 && rs.y === 0, JSON.stringify(rs));

  // ---------- turning: heading changes monotonically ----------
  const h0 = await page.evaluate(() => window.__flight.facing);
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(1100);
  const hMid = await page.evaluate(() => window.__flight.facing);
  await page.waitForTimeout(1500);
  const h1 = await page.evaluate(() => window.__flight.facing);
  await page.keyboard.up("KeyD");
  const dh = h1 - h0;
  check("D turns the ship monotonically", hMid > h0 && h1 > hMid && dh > 2 && dh < 25,
    `heading ${h0.toFixed(1)} -> ${hMid.toFixed(1)} -> ${h1.toFixed(1)} (XIV max turn ${await page.evaluate(() => effShipStat("maxTurnRate"))}°/s)`);

  await page.keyboard.press("KeyR");
  await page.waitForTimeout(120);

  // ---------- hullmod mid-flight: Unstable Injector via the mods UI ----------
  await page.click('[data-hullmod="unstable_injector"]');
  await page.waitForTimeout(200);
  const v1 = await page.evaluate(() => effShipStat("maxSpeed"));
  // (25 base + 15 UI flat) x 0.92 XIV mult = 36.8
  check("Unstable Injector raises effective max speed", near(v1, 36.8, 0.6) && v1 > truth.v0 + 10,
    `v0=${truth.v0} -> v1=${v1}`);
  await page.waitForFunction((v) => Math.abs(window.__flight.maxSpeed - v) < 0.6, v1, { timeout: 5000 });
  check("flying ship adopts the new cap live", true, `flight.maxSpeed tracks ${v1}`);

  // ---------- thrust run 2: past the OLD cap, up to the new one ----------
  await page.keyboard.down("KeyW");
  await page.waitForFunction((v) => window.__flight.speed > v * 0.92, v1, { timeout: 30000 });
  const run2 = await page.evaluate(() => window.__flight.speed);
  check("second run exceeds the old cap", run2 > truth.v0 + 5, `speed=${run2.toFixed(1)} > old cap ${truth.v0}`);
  check("second run respects the new cap", run2 <= v1 + 0.75 && run2 >= v1 * 0.9, `speed=${run2.toFixed(1)} vs cap ${v1}`);
  // zoom out for a framed shot of ship + range wedges, still under thrust
  await page.evaluate(() => { S.cam.z = 0.32; });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/v6-flight-zoom.png` });
  await page.keyboard.up("KeyW");

  // ---------- exit via Esc: build untouched, refit draw restored ----------
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => {
    draw();
    return {
      active: window.__flight.active,
      hudHidden: document.getElementById("flight-hud").hidden,
      stageClass: document.getElementById("stage").classList.contains("flight"),
      weapons: S.build.weapons, vents: S.build.vents, caps: S.build.caps,
      slotScreen: S.slotScreen.length,
    };
  });
  check("Esc exits flight mode", after.active === false && after.hudHidden && !after.stageClass);
  check("build weapons/vents/caps untouched by flight",
    JSON.stringify(after.weapons) === JSON.stringify(truth.weapons)
    && after.vents === truth.vents && after.caps === truth.caps);
  check("refit rendering restored after exit", after.slotScreen > 0, `${after.slotScreen} slots hit-mapped`);

  check("zero JS errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("SUITE ERROR:", e); process.exit(2); });
