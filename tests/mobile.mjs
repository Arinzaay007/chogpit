import assert from 'node:assert/strict';

// Runs against the isolated smoke-test server. Touch events are real Chromium
// events; portrait gates active play and the raid is completed in landscape.
export async function runMobilePlaytest(browser, base) {
  const portrait = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true
  });
  const page = await portrait.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/app.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ status: response.status(), contentType: 'application/javascript', body: `${await response.text()}\nwindow.__testGame = game;` });
  });
  const cdp = await portrait.newCDPSession(page);
  const point = (x, y, id = 1) => ({ x: Math.round(x), y: Math.round(y), id, radiusX: 8, radiusY: 8, force: 1 });
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  // Advance until the avatar reaches a world coordinate rather than assuming
  // a fixed frame rate on a busy CI machine; the input is still a thumb drag.
  const moveTo = async (axis, target, dx, dy, maxMs = 7000) => {
    // CI may cancel a synthetic long touch; refresh the same thumb drag every
    // ~1.5s so a busy browser cannot leave an inert finger on the canvas.
    let held = false, position, pulse = 0;
    const begin = async () => {
      await touch('touchStart', [point(75, 260)]);
      await touch('touchMove', [point(75 + dx * 65, 260 + dy * 65)]);
      held = true; pulse = Date.now();
    };
    const release = async () => { if (held) { await touch('touchEnd', []); held = false; } };
    try {
      const start = Date.now();
      await begin();
      while (Date.now() - start < maxMs) {
        await page.waitForTimeout(90);
        const status = await page.evaluate(key => ({ position: window.__testGame.player[key],
          moving: !!window.__testGame.touch.move, mode: window.__testGame.mode,
          x: window.__testGame.player.x, y: window.__testGame.player.y,
          hp: window.__testGame.player.hp, shield: window.__testGame.player.shield,
          loot: window.__testGame.loot, time: window.__testGame.timeLeft }), axis);
        position = status.position;
        if (position >= target) return position;
        if (status.mode !== 'play') throw new Error(`Raid ended before moving ${axis} to ${target}: ${JSON.stringify(status)}.`);
        if (!status.moving || Date.now() - pulse > 1500) { await release(); await begin(); }
      }
      const detail = await page.evaluate(() => {
        const g = window.__testGame, p = g.player;
        return { x: p.x, y: p.y, mode: g.mode, loot: g.loot, genome: g.arena.genome, touch: g.touch,
          nearby: g.obstacles.filter(o => o.x < p.x + 45 && o.x + o.w > p.x - 45 && o.y < p.y + 45 && o.y + o.h > p.y - 45) };
      });
      if (detail[axis] >= target) return detail[axis];
      throw new Error(`Thumb drag stopped at ${axis}=${position}; expected ${target}. ${JSON.stringify(detail)}`);
    } finally { await release(); }
  };
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    assert.match(await page.locator('.nft-guide summary').innerText(), /NFT = ARENA DEED/);
    await page.locator('.nft-guide summary').tap();
    assert.match(await page.locator('.nft-guide p').innerText(), /current on-chain owner signs the exact layout/i);
    assert.match(await page.locator('.nft-guide p').innerText(), /Anyone can raid without an NFT/);
    await page.locator('.nft-guide summary').tap();
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight), 844, 'The phone viewport itself must not scroll away from the controls.');

    // The portrait menu remains usable; play waits for a sideways phone.
    assert.equal(await page.locator('#rotateOverlay').isVisible(), false);
    await page.locator('#playButton').tap();
    await page.locator('#rotateOverlay').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => window.__testGame.orientationBlocked), true);
    assert.match(await page.locator('#rotateMatchNote').innerText(), /PRACTICE PAUSES/);
    const stoppedAt = await page.evaluate(() => window.__testGame.timeLeft);
    await page.waitForTimeout(270);
    assert.equal(await page.evaluate(() => window.__testGame.timeLeft), stoppedAt,
      'Practice time must not run while waiting for rotation.');
    await page.setViewportSize({ width: 844, height: 390 });
    await page.locator('#rotateOverlay').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => window.__testGame.viewH === 346, null, { timeout: 2000 });
    assert.equal(await page.evaluate(() => window.__testGame.orientationBlocked), false);
    for (const selector of ['#moveStick', '#shootButton', '#touchDash', '#pauseButton'])
      assert.equal(await page.locator(selector).isVisible(), true);

    // A complete two-supply escape, using only landscape thumb drags and OPEN/HOLD.
    await moveTo('x', 1030, 1, 0, 2600);
    await page.locator('#interactPrompt').waitFor({ state: 'visible', timeout: 1500 });
    assert.match(await page.locator('#interactText').innerText(), /OPEN SUPPLY/);
    await page.locator('#interactPrompt').tap();
    await page.waitForFunction(() => Number(document.querySelector('#hudLoot').textContent) >= 1, null, { timeout: 1600 });
    await moveTo('y', 1155, 0, 1, 3500); await moveTo('x', 1255, 1, 0, 3000);
    await page.locator('#interactPrompt').waitFor({ state: 'visible', timeout: 1500 });
    assert.match(await page.locator('#interactText').innerText(), /OPEN SUPPLY/);
    await page.locator('#interactPrompt').tap();
    await page.waitForFunction(() => Number(document.querySelector('#hudLoot').textContent) >= 2, null, { timeout: 1600 });
    await moveTo('y', 1390, 0, 1, 3600);
    await page.locator('#touchDash').tap();
    await moveTo('x', 2300, 1, 0, 10000);
    await moveTo('y', 1460, 0, 1, 2200);
    await page.locator('#interactPrompt').waitFor({ state: 'visible', timeout: 1500 });
    assert.match(await page.locator('#interactText').innerText(), /HOLD EXIT/);
    const exit = await page.locator('#interactPrompt').boundingBox();
    await touch('touchStart', [point(exit.x + exit.width / 2, exit.y + exit.height / 2, 5)]);
    try {
      await page.waitForTimeout(700);
      assert.equal(await page.locator('#resultOverlay').isVisible(), false, 'A tap cannot bypass the extraction hold.');
      await page.waitForFunction(() => !document.querySelector('#resultOverlay').hidden, null, { timeout: 7000 });
    } finally { await touch('touchEnd', []); }
    assert.equal(await page.locator('#resultTitle').innerText(), 'YOU GOT OUT.');
    assert.match(await page.locator('#scarLabel').innerText(), /DEMO PIT/);
    await page.locator('[data-mark="static"]').tap(); await page.locator('#resultButton').tap();
    await page.waitForFunction(() => document.querySelector('#resultButton').textContent.includes('DROP BACK IN'), null, { timeout: 5000 });
    assert.ok(Number(await page.locator('#crateCount').innerText()) >= 1);
    assert.ok(Number((await page.locator('#lockerRep').innerText()).replace(/,/g, '')) > 0);

    // Right-thumb aim/fire and left-thumb movement remain independent pointers.
    await page.locator('#resultButton').tap();
    await touch('touchStart', [point(75, 260)]);
    await touch('touchMove', [point(140, 260)]);
    await touch('touchStart', [point(140, 260), point(570, 170, 2)]);
    await touch('touchMove', [point(140, 260), point(595, 145, 2)]);
    await page.waitForTimeout(160);
    const twinSticks = await page.evaluate(() => ({
      moving: !!window.__testGame.touch.move, aiming: !!window.__testGame.touch.aim,
      shot: window.__testGame.player.fireCd > 0
    }));
    assert.ok(twinSticks.moving && twinSticks.aiming && twinSticks.shot, 'Drag-to-aim must fire while the move stick is held.');
    await touch('touchEnd', [point(595, 145, 2)]);
    assert.equal(await page.evaluate(() => !!window.__testGame.touch.aim), false);
    assert.equal(await page.evaluate(() => !!window.__testGame.touch.move), true);
    await touch('touchEnd', [point(140, 260)]);

    // The separate FIRE button can also auto-aim while the other thumb moves.
    const fire = await page.locator('#shootButton').boundingBox();
    const f = point(fire.x + fire.width / 2, fire.y + fire.height / 2, 2);
    await touch('touchStart', [point(75, 260)]);
    await touch('touchMove', [point(140, 260)]);
    const startX = await page.evaluate(() => window.__testGame.player.x);
    await touch('touchStart', [point(140, 260), f]);
    await page.waitForTimeout(240);
    const movingAndFiring = await page.evaluate(() => ({
      x: window.__testGame.player.x, moving: !!window.__testGame.touch.move,
      firing: window.__testGame.buttonFiring, shot: window.__testGame.player.fireCd > 0
    }));
    assert.ok(movingAndFiring.x > startX + 10 && movingAndFiring.moving && movingAndFiring.firing && movingAndFiring.shot,
      'Left thumb movement and right thumb fire must work together.');
    await touch('touchEnd', [f]);
    assert.equal(await page.evaluate(() => window.__testGame.buttonFiring), false);
    assert.equal(await page.evaluate(() => !!window.__testGame.touch.move), true);
    await touch('touchEnd', [point(140, 260)]);
    await page.locator('#touchDash').tap();
    assert.ok(await page.evaluate(() => window.__testGame.player.dashCd > 0), 'The mobile DASH button must activate.');

    // Rotating mid-run releases all held controls without losing solo progress.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#rotateOverlay').waitFor({ state: 'visible' });
    const pausedAt = await page.evaluate(() => window.__testGame.timeLeft);
    await page.waitForTimeout(280);
    assert.equal(await page.evaluate(() => window.__testGame.timeLeft), pausedAt);
    assert.equal(await page.evaluate(() => window.__testGame.touch.move === null && !window.__testGame.buttonFiring), true);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.locator('#rotateOverlay').waitFor({ state: 'hidden' });
    await page.waitForFunction(time => window.__testGame.timeLeft < time - .1, pausedAt, { timeout: 2500 });
    await page.locator('#pauseButton').tap();
    assert.equal(await page.locator('#pauseOverlay').isVisible(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('#rotateOverlay').isVisible(), false, 'The pause menu stays usable upright.');
    await page.locator('#resumeButton').tap();
    await page.locator('#rotateOverlay').waitFor({ state: 'visible' });
    await page.locator('#rotateMenuButton').tap();
    assert.equal(await page.locator('#lobbyOverlay').isVisible(), true);
    assert.equal(await page.locator('#rotateOverlay').isVisible(), false);
    await page.locator('#buildButton').tap();
    assert.equal(await page.locator('#builderPanel').isVisible(), true);
    await page.touchscreen.tap(80, 270);
    assert.match(await page.locator('#trapCount').innerText(), /4 \/ 8/);
    await page.locator('#closeBuilder').tap();
    assert.deepEqual(errors, []);
  } finally {
    await portrait.close();
  }

  // A small phone must keep the header and controls fixed even when its lobby
  // needs scrolling, and rotating mid-run must resize the actual game camera.
  const compact = await browser.newContext({
    viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true
  });
  const compactPage = await compact.newPage();
  const compactErrors = []; compactPage.on('pageerror', error => compactErrors.push(error.message));
  await compactPage.route('**/app.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ status: response.status(), contentType: 'application/javascript', body: `${await response.text()}\nwindow.__testGame = game;` });
  });
  try {
    await compactPage.goto(base, { waitUntil: 'domcontentloaded' });
    assert.equal(await compactPage.evaluate(() => document.documentElement.scrollHeight), 568);
    assert.ok(await compactPage.evaluate(() => document.querySelector('#lobbyOverlay').scrollHeight > document.querySelector('#lobbyOverlay').clientHeight));
    await compactPage.locator('#playButton').tap();
    await compactPage.locator('#rotateOverlay').waitFor({ state: 'visible' });
    assert.equal(await compactPage.evaluate(() => window.__testGame.viewH), 510);
    await compactPage.setViewportSize({ width: 568, height: 320 });
    await compactPage.locator('#rotateOverlay').waitFor({ state: 'hidden' });
    await compactPage.waitForFunction(() => window.__testGame.viewH === 276, null, { timeout: 2000 });
    for (const selector of ['#shootButton', '#touchDash', '#moveStick']) {
      const box = await compactPage.locator(selector).boundingBox();
      assert.ok(box.y >= 44 && box.y + box.height <= 320, `${selector} must survive phone rotation.`);
    }
    await compactPage.setViewportSize({ width: 320, height: 568 });
    await compactPage.waitForFunction(() => window.__testGame.viewH === 510, null, { timeout: 2000 });
    await compactPage.locator('#rotateOverlay').waitFor({ state: 'visible' });
    await compactPage.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert.equal(await compactPage.locator('#pauseOverlay').isVisible(), true, 'Returning from another app needs a touch-accessible resume.');
    assert.equal(await compactPage.locator('#rotateOverlay').isVisible(), false, 'Pause is still usable in portrait.');
    await compactPage.locator('#resumeButton').tap();
    await compactPage.locator('#rotateOverlay').waitFor({ state: 'visible' });
    assert.equal(await compactPage.evaluate(() => document.documentElement.scrollHeight), 568);
    assert.deepEqual(compactErrors, []);
  } finally {
    await compact.close();
  }

  // Landscape uses a compact HUD; menus and the result must scroll internally.
  const landscape = await browser.newContext({
    viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true
  });
  const landPage = await landscape.newPage();
  const landErrors = []; landPage.on('pageerror', error => landErrors.push(error.message));
  await landPage.route('**/app.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ status: response.status(), contentType: 'application/javascript', body: `${await response.text()}\nwindow.__testGame = game;` });
  });
  const landCdp = await landscape.newCDPSession(landPage);
  try {
    await landPage.goto(base, { waitUntil: 'domcontentloaded' });
    assert.equal(await landPage.evaluate(() => document.documentElement.scrollHeight), 390);
    assert.ok(await landPage.evaluate(() => document.querySelector('#lobbyOverlay').scrollHeight > document.querySelector('#lobbyOverlay').clientHeight));
    await landPage.locator('#playButton').tap();
    assert.equal(await landPage.locator('#rotateOverlay').isVisible(), false);
    for (const selector of ['#shootButton', '#touchDash', '#moveStick', '#pauseButton']) {
      const box = await landPage.locator(selector).boundingBox();
      assert.ok(box.y >= 44 && box.y + box.height <= 390, `${selector} must fit in a landscape phone.`);
    }
    assert.equal(await landPage.evaluate(() => window.__testGame.viewH), 346, 'Camera must match the short landscape canvas.');
    await landPage.evaluate(() => {
      const game = window.__testGame;
      game.loot = 2; game.bots = []; game.respawnTimers = []; game.traps = []; game.scars = [];
      game.player.x = game.extract.x; game.player.y = game.extract.y;
    });
    await landPage.waitForFunction(() => !document.querySelector('#interactPrompt').hidden, null, { timeout: 2500 });
    const exit = await landPage.locator('#interactPrompt').boundingBox();
    assert.ok(exit.y >= 44 && exit.y + exit.height <= 390);
    const p = point(exit.x + exit.width / 2, exit.y + exit.height / 2, 7);
    await landCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
    try {
      await landPage.waitForFunction(() => !document.querySelector('#resultOverlay').hidden, null, { timeout: 7000 });
    } finally { await landCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }
    await landPage.locator('#resultButton').tap();
    await landPage.waitForFunction(() => document.querySelector('#resultButton').textContent.includes('DROP BACK IN'), null, { timeout: 5000 });
    assert.equal(await landPage.locator('#crateCount').innerText(), '1');
    assert.equal(await landPage.evaluate(() => document.documentElement.scrollHeight), 390, 'Result scrolling must not shift the arena or header.');
    assert.deepEqual(landErrors, []);
  } finally {
    await landscape.close();
  }
}
