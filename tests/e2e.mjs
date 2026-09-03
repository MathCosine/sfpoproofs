import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

// Serve the repo ourselves so the test is one command with no setup.
const ROOT = new URL('..', import.meta.url).pathname;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.txt': 'text/plain',
};
const server = createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, rel === '/' ? 'index.html' : rel);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
// ?demo=1 is mandatory here: assets/config.js carries real Supabase
// credentials, and these tests must never write into the live contest.
const BASE = `http://127.0.0.1:${server.address().port}/?demo=1`;
const out = [];
const check = (name, ok, detail = '') => {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
};

// CHROMIUM_PATH lets a sandbox point at a preinstalled binary; everywhere
// else Playwright's own download is correct.
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({ viewport: { width: 1500, height: 980 } });
// A failed webfont fetch is not a bug in the portal; an uncaught
// exception is. Keep them apart.
const jsErrors = [];
const resourceErrors = [];
// Nothing in this run may reach the real project. config.js holds live
// credentials, so a single request to supabase.co means ?demo=1 stopped
// working and the tests are writing into the contest.
const liveRequests = [];
const watch = (p, tag) => {
  p.on('pageerror', (e) => jsErrors.push(`${tag}: ${e}`));
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    (/Failed to load resource|net::ERR/.test(m.text()) ? resourceErrors : jsErrors)
      .push(`${tag}: ${m.text()}`);
  });
  p.on('requestfailed', (r) => resourceErrors.push(`${tag}: ${r.url()}`));
  p.on('request', (r) => {
    if (/supabase\.co|supabase\.in/.test(r.url())) liveRequests.push(`${tag}: ${r.url()}`);
  });
};

await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
// The copy-for-slides button uses the clipboard API.
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
  .catch(() => {});

const page = await ctx.newPage();
watch(page, 'tab1');


await page.goto(BASE, { waitUntil: 'networkidle' });

// ---- gate ---------------------------------------------------------
check('gate is shown', await page.isVisible('#gate'));
check('?demo=1 forces the demo store', await page.isVisible('#gateDemo'));
await page.fill('#graderName', 'Priya Raman');
await page.click('#gateEnter');
await page.waitForSelector('#app:not(.hidden)');
check('entered the portal', await page.isVisible('#app'));
check('name is on the bar', (await page.textContent('#whoamiName')) === 'Priya Raman');

check('a correctly-served page shows no version warning',
  !(await page.locator('#gate .banner--error').count()));

// ---- answer key ---------------------------------------------------
await page.click('.tab[data-tab="key"]');
await page.waitForTimeout(200);
const keyBoxes = await page.locator('#keyIndividualA .ans input').count();
check('the key has one box per individual problem', keyBoxes === 20, String(keyBoxes));
check('there is a separate grid per division',
  (await page.locator('#keyIndividualB .ans input').count()) === 20);
check('only the selected division’s grid is shown',
  await page.isVisible('#keyIndividualA') && !(await page.isVisible('#keyIndividualB')));
const gutsSets = await page.locator('#keyGuts .keyset').count();
check('the guts key is grouped into 7 sets', gutsSets === 7, String(gutsSets));
const gutsBoxes = await page.locator('#keyGuts .ans input').count();
check('7 sets of 4 is 28 guts boxes', gutsBoxes === 28, String(gutsBoxes));

// Fill the key: individual problem n -> n, guts problem n -> n*2.
// Division A answers n, Division B answers n+100 — disjoint on purpose.
await page.evaluate(() => {
  document.querySelectorAll('#keyIndividualA .ans input').forEach((input, i) => {
    input.value = String(i + 1);
    input.dispatchEvent(new Event('input'));
  });
  document.querySelectorAll('#keyIndividualB .ans input').forEach((input, i) => {
    input.value = String(i + 101);
    input.dispatchEvent(new Event('input'));
  });
  document.querySelectorAll('#keyGuts .ans input').forEach((input, i) => {
    input.value = String((i + 1) * 2);
    input.dispatchEvent(new Event('input'));
  });
});
await page.click('.tab[data-keydiv="B"]');
await page.waitForTimeout(150);
check('switching division shows the other grid',
  await page.isVisible('#keyIndividualB') && !(await page.isVisible('#keyIndividualA')));
await page.click('.tab[data-keydiv="A"]');
const setPoints = await page.locator('#keyGuts .keyset__points input').nth(6).inputValue();
check('set 7 defaults to 7 points each', setPoints === '7', setPoints);
await page.click('#saveKey');
await page.waitForTimeout(500);
check('the key saves and reports complete',
  (await page.textContent('#keyState')) === 'complete', await page.textContent('#keyState'));

// ---- the key editor must not be eaten either -------------------------
// Same bug as the guts grid: focus alone was not enough of a guard, so
// clicking the other division's tab or simply pausing let a background
// render overwrite everything unsaved.
await page.click('.tab[data-keydiv="B"]');
await page.waitForTimeout(150);
await page.evaluate(() => {
  const box = document.querySelectorAll('#keyIndividualB .ans input')[0];
  box.value = '4242';
  box.dispatchEvent(new Event('input'));
});
await page.click('.tab[data-keydiv="A"]');          // focus leaves the box
await page.evaluate(() => {
  window.dispatchEvent(new StorageEvent('storage', { key: 'contest-demo-db' }));
});
await page.waitForTimeout(600);
await page.click('.tab[data-keydiv="B"]');
check('an unsaved key edit survives a background render',
  (await page.locator('#keyIndividualB .ans input').first().inputValue()) === '4242',
  await page.locator('#keyIndividualB .ans input').first().inputValue());
await page.evaluate(() => {
  const box = document.querySelectorAll('#keyIndividualB .ans input')[0];
  box.value = '101';
  box.dispatchEvent(new Event('input'));
});
await page.click('.tab[data-keydiv="A"]');

// ---- clearing the key ----------------------------------------------
check('clearing the key takes two clicks', await page.isVisible('#clearKey'));
await page.click('#clearKey');
await page.waitForTimeout(150);
check('the first click only arms it',
  (await page.textContent('#clearKey')).includes('Click again'),
  await page.textContent('#clearKey'));
check('and it says what will happen',
  (await page.textContent('#clearKeyHint')).includes('both divisions'));
await page.click('#clearKey');
await page.waitForTimeout(600);
check('the second click empties all 68 answers (20 + 20 + 28)',
  (await page.textContent('#keyState')) === '68 unset', await page.textContent('#keyState'));
check('guts point values survive a clear',
  (await page.locator('#keyGuts .keyset__points input').nth(6).inputValue()) === '7');

// Put the key back for the rest of the run.
await page.evaluate(() => {
  document.querySelectorAll('#keyIndividualA .ans input').forEach((input, i) => {
    input.value = String(i + 1); input.dispatchEvent(new Event('input'));
  });
  document.querySelectorAll('#keyIndividualB .ans input').forEach((input, i) => {
    input.value = String(i + 101); input.dispatchEvent(new Event('input'));
  });
  document.querySelectorAll('#keyGuts .ans input').forEach((input, i) => {
    input.value = String((i + 1) * 2); input.dispatchEvent(new Event('input'));
  });
});
await page.click('#saveKey');
await page.waitForTimeout(500);
check('and the key can be typed back in',
  (await page.textContent('#keyState')) === 'complete', await page.textContent('#keyState'));

// ---- individual entry ---------------------------------------------
await page.selectOption('#divisionPick', 'A');
await page.fill('#individualId', 'a121');
await page.waitForTimeout(200);
check('the ID uppercases itself', (await page.inputValue('#individualId')) === 'A121');
check('typing A121 fills the division', (await page.inputValue('#divisionPick')) === 'A');
check('typing A121 fills the team box', (await page.inputValue('#teamNo')) === '12');
check('typing A121 fills the member box', (await page.inputValue('#memberLetter')) === '1');

await page.fill('#teamNo', '13');
await page.waitForTimeout(200);
check('the team box stays editable and rebuilds the ID',
  (await page.inputValue('#individualId')) === 'A131', await page.inputValue('#individualId'));
await page.selectOption('#divisionPick', 'B');
await page.waitForTimeout(200);
check('the division box stays editable too',
  (await page.inputValue('#individualId')) === 'B131', await page.inputValue('#individualId'));
await page.selectOption('#divisionPick', 'A');
await page.fill('#individualId', 'A121');
await page.waitForTimeout(200);
await page.fill('#contestantName', 'Ada Lovelace');

const answerBoxes = await page.locator('#answerGrid .ans input').count();
check('there are 20 answer boxes', answerBoxes === 20, String(answerBoxes));

// Type into the first box and let Enter walk the grid.
const first = page.locator('#answerGrid .ans input').first();
await first.click();
await page.keyboard.type('1');
await page.keyboard.press('Enter');
await page.keyboard.type('2');
await page.keyboard.press('Enter');
await page.keyboard.type('999');
await page.waitForTimeout(200);
check('Enter walks to the next box',
  (await page.locator('#answerGrid .ans input').nth(2).inputValue()) === '999');
check('a correct answer turns the box green',
  (await page.locator('#answerGrid .ans').first().getAttribute('class')).includes('ans--correct'));

// The same sheet against the other division's paper must go red.
await page.selectOption('#divisionPick', 'B');
await page.waitForTimeout(250);
check('switching division re-marks the sheet against the other paper',
  (await page.locator('#answerGrid .ans').first().getAttribute('class')).includes('ans--wrong'),
  await page.locator('#answerGrid .ans').first().getAttribute('class'));
check('the running total follows the division',
  (await page.textContent('#myCount')).startsWith('0 correct'),
  await page.textContent('#myCount'));
await page.selectOption('#divisionPick', 'A');
await page.waitForTimeout(250);
check('a wrong answer turns the box red',
  (await page.locator('#answerGrid .ans').nth(2).getAttribute('class')).includes('ans--wrong'));
check('the running total is shown while typing',
  (await page.textContent('#myCount')).includes('2 correct'), await page.textContent('#myCount'));

// Paste a whole row across the grid.
await page.locator('#answerGrid .ans input').nth(3).click();
await page.evaluate(() => {
  const input = document.querySelectorAll('#answerGrid .ans input')[3];
  const data = new DataTransfer();
  data.setData('text', '4 5 6 7');
  input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
});
await page.waitForTimeout(200);
check('pasting a row spreads across the boxes',
  (await page.locator('#answerGrid .ans input').nth(6).inputValue()) === '7',
  await page.locator('#answerGrid .ans input').nth(6).inputValue());

await page.click('#saveSheet');
await page.waitForTimeout(500);
const savedToast = await page.locator('.toast').last().textContent();
check('the sheet saves with its score', savedToast.includes('A121') && savedToast.includes('6 pts'),
  savedToast.trim());
check('a non-negative integer is required',
  (await page.locator('#answerGrid .ans--bad').count()) === 0);

// ---- progress is per contestant, not per problem -------------------
await page.click('.tab[data-tab="progress"]');
await page.waitForTimeout(300);
check('progress lists people, not 20 boxes each',
  (await page.locator('.person').count()) === 4
  && (await page.locator('#progressPanel .ans').count()) === 0,
  `${await page.locator('.person').count()} chips`);
check('the entered contestant shows their score',
  (await page.locator('.person--partial, .person--done').first().textContent()).includes('A121'));

// ---- guts ----------------------------------------------------------
await page.click('.tab[data-entry="guts"]');
await page.waitForTimeout(200);
await page.selectOption('#gutsDivision', 'A');
await page.fill('#gutsTeam', '12');
await page.selectOption('#gutsSet', '1');
await page.waitForTimeout(250);
check('guts shows 4 boxes for a set',
  (await page.locator('#gutsGrid .ans input').count()) === 4);
check('guts states the points for the set',
  (await page.textContent('#gutsPointsHint')).includes('1 point(s) each'),
  await page.textContent('#gutsPointsHint'));
check('a team with no name is asked for one',
  (await page.textContent('#gutsNameHint')).includes('give it a name'));

await page.click('#saveGuts');
await page.waitForTimeout(300);
check('guts refuses to save without a team name',
  (await page.locator('.toast').last().textContent()).includes('name'));

await page.fill('#gutsTeamName', 'Cowbell');
await page.evaluate(() => {
  document.querySelectorAll('#gutsGrid .ans input').forEach((input, i) => {
    input.value = String((i + 1) * 2);
    input.dispatchEvent(new Event('input'));
  });
});
await page.click('#saveGuts');
await page.waitForTimeout(600);
check('the set saves and advances to the next one',
  (await page.inputValue('#gutsSet')) === '2', await page.inputValue('#gutsSet'));

await page.selectOption('#gutsSet', '7');
await page.waitForTimeout(250);
check('set 7 is worth 7 points each',
  (await page.textContent('#gutsPointsHint')).includes('7 point(s) each'));
await page.evaluate(() => {
  document.querySelectorAll('#gutsGrid .ans input').forEach((input, i) => {
    input.value = String((25 + i) * 2);
    input.dispatchEvent(new Event('input'));
  });
});
await page.click('#saveGuts');
await page.waitForTimeout(600);

await page.click('.tab[data-tab="leaderboard"]');
await page.click('.tab[data-board="guts"]');
await page.waitForTimeout(300);
const gutsRow = await page.locator('#boards table tbody tr').first().textContent();
check('guts points rise by set: 4 x 1 + 4 x 7 = 32',
  gutsRow.includes('32'), gutsRow.trim());
check('the team name reaches the leaderboard', gutsRow.includes('Cowbell'), gutsRow.trim());

// ---- a background refresh must not eat what you are typing ----------
// The bug: refreshGutsContext() reloaded the boxes from the database on
// every render, so any other scorer saving anything wiped your entry.
await page.selectOption('#gutsSet', '4');
await page.waitForTimeout(300);
await page.evaluate(() => {
  document.querySelectorAll('#gutsGrid .ans input').forEach((input, i) => {
    input.value = String(700 + i);
    input.dispatchEvent(new Event('input'));
  });
});
const typed = await page.locator('#gutsGrid .ans input').allTextContents()
  .then(() => page.evaluate(() => [...document.querySelectorAll('#gutsGrid .ans input')].map((i) => i.value)));
check('typed guts answers are in the boxes', typed.join(',') === '700,701,702,703', typed.join(','));

// Force the exact code path a realtime event from another scorer takes.
await page.evaluate(() => {
  window.dispatchEvent(new StorageEvent('storage', { key: 'contest-demo-db' }));
});
await page.waitForTimeout(600);
const after = await page.evaluate(
  () => [...document.querySelectorAll('#gutsGrid .ans input')].map((i) => i.value));
check('a background refresh leaves half-typed guts answers alone',
  after.join(',') === '700,701,702,703', after.join(','));

// Switching set must still load that set's stored answers.
await page.selectOption('#gutsSet', '1');
await page.waitForTimeout(400);
const reloaded = await page.evaluate(
  () => [...document.querySelectorAll('#gutsGrid .ans input')].map((i) => i.value));
check('but switching set still loads what was saved',
  reloaded.join(',') === '2,4,6,8', reloaded.join(','));

// ---- leaderboard paging ---------------------------------------------
await page.click('.tab[data-tab="setup"]');
await page.click('#seedDemo');
await page.waitForTimeout(4000);
await page.click('.tab[data-tab="leaderboard"]');
await page.click('.tab[data-board="individual"]');
await page.waitForTimeout(500);

const firstPage = await page.locator('#boards .table-wrap:not(.table-wrap--dq)').first()
  .locator('tbody tr').count();
check('a division shows ten at a time', firstPage <= 10 && firstPage > 0, String(firstPage));
const whereBefore = await page.locator('.pager__where').first().textContent();
check('the pager says where you are', /^1–\d+ of \d+$/.test(whereBefore.trim()), whereBefore);
check('back is disabled on the first page',
  await page.locator('.pager .btn').first().isDisabled());

const topBefore = await page.locator('#boards tbody tr').first().textContent();
await page.locator('.pager .btn').nth(1).click();
await page.waitForTimeout(400);
const whereAfter = await page.locator('.pager__where').first().textContent();
check('the arrow moves to the next ten', whereAfter.trim().startsWith('11–'), whereAfter);
check('and the rows actually change',
  (await page.locator('#boards tbody tr').first().textContent()) !== topBefore);
check('back is enabled once you have moved',
  !(await page.locator('.pager .btn').first().isDisabled()));
await page.locator('.pager .btn').first().click();
await page.waitForTimeout(400);
check('and going back returns to the first ten',
  (await page.locator('.pager__where').first().textContent()).trim().startsWith('1–'));
check('rank numbering follows the page, not the page position',
  (await page.locator('#boards tbody tr').first().locator('td').first().textContent()).trim() === '1');

// ---- copy for slides -------------------------------------------------
const copyBtn = page.locator('button', { hasText: 'Copy for slides' }).first();
check('there is a copy button on the individual board', await copyBtn.isVisible());
await copyBtn.click();
await page.waitForTimeout(400);
check('it confirms how many it copied',
  /Copied \d+ for slides/.test(await page.locator('.toast').last().textContent()),
  await page.locator('.toast').last().textContent());
const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
check('the copied text is ID, name and score per contestant',
  /^[AB]\d{2,3}[1-9].*\nScore: \d+/.test(clip), clip.split('\n').slice(0, 2).join(' / '));

// ---- statistics export ------------------------------------------------
await page.click('.tab[data-tab="setup"]');
const statsDl = page.waitForEvent('download', { timeout: 8000 });
await page.click('#exportStats');
const statsFile = await statsDl;
const statsStream = await statsFile.createReadStream();
const statsChunks = [];
for await (const c of statsStream) statsChunks.push(c);
const statsText = Buffer.concat(statsChunks).toString('utf8');
check('statistics CSV downloads', statsFile.suggestedFilename().includes('statistics'));
for (const want of ['individual mean', 'individual median', 'individual stdev',
  'most solved', 'fewest solved', 'distribution', 'percent correct']) {
  check(`statistics include ${want}`, statsText.includes(want));
}
check('statistics cover both divisions',
  statsText.includes('DIVISION,A') && statsText.includes('DIVISION,B'));

// ---- clock ---------------------------------------------------------
await page.click('.tab[data-tab="run"]');
await page.waitForTimeout(250);
check('the clock starts at 75 minutes',
  (await page.textContent('#clockBig')) === '75:00', await page.textContent('#clockBig'));
await page.click('#clockMinus');
await page.waitForTimeout(400);
check('the clock is adjustable while stopped',
  (await page.textContent('#clockBig')) === '74:00', await page.textContent('#clockBig'));
await page.click('#clockStart');
const ticked = await page.waitForFunction(
  () => document.querySelector('#clockBig').textContent !== '74:00',
  null, { timeout: 8000 },
).then(() => true, () => false);
check('starting the clock makes it count down', ticked,
  await page.textContent('#clockBig'));

await page.click('#clockPause');
await page.waitForTimeout(600);
const paused = await page.textContent('#clockBig');
await page.waitForTimeout(2200);
check('pausing holds it still', (await page.textContent('#clockBig')) === paused, paused);

check('the board reports itself live',
  (await page.textContent('#freezeState')).includes('is live'));
await page.click('#freezeToggle');
await page.waitForTimeout(400);
check('freezing is reflected in the portal',
  (await page.textContent('#freezeState')).includes('is frozen'));
await page.click('#freezeToggle');
await page.waitForTimeout(400);

// ---- the public board ----------------------------------------------
const board = await ctx.newPage();
watch(board, 'board');
const BOARD_URL = BASE.replace('/?demo=1', '/guts.html?demo=1');
await board.goto(BOARD_URL, { waitUntil: 'networkidle' });
await board.waitForTimeout(1200);
const boardText = await board.innerText('body');
const leaderCards = await board.locator('.card').count();
check('the public board lists teams as cards', leaderCards > 0, `${leaderCards} cards`);
const topCard = await board.locator('.card').first().innerText();
check('each card shows a team and a score',
  /\S/.test(topCard) && /\d/.test(topCard), topCard.replace(/\n/g, ' | ').slice(0, 70));
check('the board shows how far along each team is',
  /Set \d|All \d in/.test(boardText), boardText.slice(0, 80));
check('the public board shows a clock',
  /\d\d:\d\d/.test(await board.textContent('#clockTime')), await board.textContent('#clockTime'));
const leak = ['answer key', 'Staff', 'Disqualif', 'ERASE', 'Individual ID']
  .filter((w) => new RegExp(w, 'i').test(boardText));
check('the public board leaks nothing from the portal', leak.length === 0,
  `matched: ${leak.join(', ')} | body: ${boardText.replace(/\s+/g, ' ').slice(0, 150)}`);
check('the public board has no answer boxes',
  (await board.locator('input').count()) === 0);
await board.close();

// ---- two graders never key the same sheet ---------------------------
const page2 = await ctx.newPage();
watch(page2, 'tab2');
await page2.addInitScript(() => {
  localStorage.setItem('contest-grader-id', 'grader-dan');
  localStorage.setItem('contest-grader-name', 'Dan Whitfield');
});
await page2.goto(BASE, { waitUntil: 'networkidle' });
await page2.waitForSelector('#app:not(.hidden)');
check('tab 2 is a different grader',
  (await page2.textContent('#whoamiName')) === 'Dan Whitfield');
await page2.fill('#individualId', 'A201');
await page2.waitForTimeout(700);

await page.click('.tab[data-entry="individual"]');
await page.fill('#individualId', 'A201');
await page.waitForTimeout(900);
check('opening a sheet someone else holds warns you',
  (await page.textContent('#individualBanner')).includes('entering this sheet right now'),
  (await page.textContent('#individualBanner')).trim().slice(0, 70));
await page2.close();

// ---- the purple "someone is on this" indicator ----------------------
// What a scorer relies on to know what everyone else has open.
{
  const other = await ctx.newPage();
  watch(other, 'purple');
  await other.addInitScript(() => {
    localStorage.setItem('contest-grader-id', 'grader-purple');
    localStorage.setItem('contest-grader-name', 'Mei Sato');
  });
  await other.goto(BASE, { waitUntil: 'domcontentloaded' });
  await other.waitForSelector('#app:not(.hidden)');

  // Mei opens an individual sheet.
  await other.fill('#individualId', 'A122');
  await other.waitForTimeout(900);
  await page.click('.tab[data-tab="progress"]');
  await page.waitForTimeout(900);
  const chip = page.locator('.person', { hasText: 'A122' }).first();
  check('another scorer opening a sheet turns that contestant purple',
    (await chip.getAttribute('class')).includes('person--claimed'),
    await chip.getAttribute('class'));
  check('and the chip says who has it',
    (await chip.getAttribute('title')).includes('Mei Sato'), await chip.getAttribute('title'));

  // Mei moves to a guts set instead.
  await other.click('.tab[data-entry="guts"]');
  await other.selectOption('#gutsDivision', 'A');
  await other.fill('#gutsTeam', '12');
  await other.selectOption('#gutsSet', '3');
  await other.waitForTimeout(900);
  await page.waitForTimeout(900);
  const pip = page.locator('.rosterteam', { hasText: 'A12' }).locator('.setpip').nth(2);
  check('and a guts set she opens goes purple too',
    (await pip.getAttribute('class')).includes('setpip--claimed'),
    await pip.getAttribute('class'));

  check('the released sheet stops being purple once she moves on',
    !(await page.locator('.person', { hasText: 'A122' }).first()
      .getAttribute('class')).includes('person--claimed'));

  await page.click('.tab[data-tab="activity"]').catch(() => {});
  await other.close();
  await page.waitForTimeout(900);
}

// ---- pasting a key in from a spreadsheet ------------------------------
await page.click('.tab[data-tab="key"]');
await page.click('.tab[data-keydiv="A"]');
await page.waitForTimeout(200);
await page.evaluate(() => {
  const first = document.querySelectorAll('#keyIndividualA .ans input')[0];
  first.focus();
  const data = new DataTransfer();
  data.setData('text', '11\t12\t13\t14\t15');   // a row copied out of a spreadsheet
  first.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
});
await page.waitForTimeout(250);
const pasted = await page.evaluate(() => [...document.querySelectorAll('#keyIndividualA .ans input')]
  .slice(0, 5).map((i) => i.value));
check('a tab-separated row pastes across the key boxes',
  pasted.join(',') === '11,12,13,14,15', pasted.join(','));
// Put the real key back.
await page.evaluate(() => {
  document.querySelectorAll('#keyIndividualA .ans input').forEach((input, i) => {
    input.value = String(i + 1);
    input.dispatchEvent(new Event('input'));
  });
});
await page.click('#saveKey');
await page.waitForTimeout(500);
await page.click('.tab[data-entry="individual"]');

// ---- ten scorers at once --------------------------------------------
// The lock's mutual exclusion is unit-tested against the Postgres
// contract; this is the other half — ten real tabs, ten identities, all
// live at the same time, and the UI holding up.
const crew = [];
for (let i = 0; i < 10; i += 1) {
  const tab = await ctx.newPage();
  watch(tab, `crew${i}`);
  await tab.addInitScript((n) => {
    localStorage.setItem('contest-grader-id', `crew-${n}`);
    localStorage.setItem('contest-grader-name', `Scorer ${n}`);
  }, i);
  await tab.goto(BASE, { waitUntil: 'domcontentloaded' });
  crew.push(tab);
}
await Promise.all(crew.map((tab) => tab.waitForSelector('#app:not(.hidden)', { timeout: 20000 })));
check('ten scorers can all be signed in at once', crew.length === 10);

// Each opens a different sheet, all at the same moment.
await Promise.all(crew.map(async (tab, i) => {
  await tab.selectOption('#divisionPick', i % 2 ? 'A' : 'B');
    await tab.fill('#individualId', `${i % 2 ? 'A' : 'B'}${String(40 + i).padStart(2, '0')}1`);
}));
await page.waitForTimeout(1500);

const identities = await Promise.all(crew.map((t) => t.textContent('#whoamiName')));
check('each tab keeps its own scorer identity',
  new Set(identities).size === 10, identities.slice(0, 3).join(', '));

const banners = await Promise.all(crew.map((t) => t.textContent('#individualBanner')));
check('ten different sheets means nobody is blocked',
  banners.every((b) => !b.includes('entering this sheet right now')));

// Now all ten pile onto the SAME sheet.
await Promise.all(crew.map((tab) => tab.fill('#individualId', 'A771')));
await page.waitForTimeout(2000);
const contested = await Promise.all(crew.map((t) => t.textContent('#individualBanner')));
const warned = contested.filter((b) => b.includes('entering this sheet right now')).length;
check('piling onto one sheet warns all but the holder',
  warned >= 8, `${warned} of 10 warned off`);

// Everyone enters and saves their own sheet simultaneously.
await Promise.all(crew.map(async (tab, i) => {
  await tab.selectOption('#divisionPick', i % 2 ? 'A' : 'B');
    await tab.fill('#individualId', `${i % 2 ? 'A' : 'B'}${String(40 + i).padStart(2, '0')}1`);
  await tab.selectOption('#divisionPick', i % 2 ? 'A' : 'B');
  await tab.evaluate((n) => {
    document.querySelectorAll('#answerGrid .ans input').forEach((input, k) => {
      input.value = String(k <= n ? k + 1 : 0);
      input.dispatchEvent(new Event('input'));
    });
  }, i);
}));
await Promise.all(crew.map((tab) => tab.click('#saveSheet')));
await page.waitForTimeout(2500);

const savedIds = await page.evaluate(() => {
  const db = JSON.parse(localStorage.getItem('contest-demo-db') || '{}');
  return (db.contestants || []).map((c) => c.individual_id);
});
const expected = Array.from({ length: 10 }, (_, i) => `${i % 2 ? 'A' : 'B'}${String(40 + i).padStart(2, '0')}1`);
const landed = expected.filter((id) => savedIds.includes(id));
check('ten simultaneous saves all land', landed.length === 10,
  `${landed.length}/10 — missing ${expected.filter((id) => !savedIds.includes(id)).join(', ')}`);

await page.click('.tab[data-tab="progress"]');
await page.waitForTimeout(600);
check('the portal is still responsive with ten tabs open',
  (await page.locator('.person').count()) > 0);

// Now the shape a real contest takes: some scorers on answer sheets and
// some on guts sets, all saving in the same moment.
await Promise.all(crew.map(async (tab, i) => {
  if (i % 2 === 0) {
    await tab.click('.tab[data-entry="individual"]');
    await tab.selectOption('#divisionPick', 'A');
    await tab.fill('#individualId', `A${String(60 + i).padStart(2, '0')}2`);
    await tab.evaluate(() => {
      document.querySelectorAll('#answerGrid .ans input').forEach((input, k) => {
        input.value = String(k + 1);
        input.dispatchEvent(new Event('input'));
      });
    });
  } else {
    await tab.click('.tab[data-entry="guts"]');
    await tab.selectOption('#gutsDivision', 'B');
    await tab.fill('#gutsTeam', String(60 + i));
    await tab.selectOption('#gutsSet', String((i % 7) + 1));
    await tab.fill('#gutsTeamName', `Crew ${i}`);
    await tab.evaluate((n) => {
      const first = (n % 7) * 4 + 1;
      document.querySelectorAll('#gutsGrid .ans input').forEach((input, k) => {
        input.value = String((first + k) * 2);
        input.dispatchEvent(new Event('input'));
      });
    }, i);
  }
}));
await Promise.all(crew.map((tab, i) => tab.click(i % 2 === 0 ? '#saveSheet' : '#saveGuts')));
await page.waitForTimeout(3000);

const mixed = await page.evaluate(() => {
  const db = JSON.parse(localStorage.getItem('contest-demo-db') || '{}');
  return {
    sheets: (db.contestants || []).map((c) => c.individual_id),
    gutsTeams: [...new Set((db.gutsAnswers || []).map((g) => String(g.team)))],
  };
});
const wantSheets = [0, 2, 4, 6, 8].map((i) => `A${String(60 + i).padStart(2, '0')}2`);
const wantGuts = [1, 3, 5, 7, 9].map((i) => `B${String(60 + i).padStart(2, '0')}`);
check('five simultaneous answer sheets all land',
  wantSheets.every((id) => mixed.sheets.includes(id)),
  `missing ${wantSheets.filter((id) => !mixed.sheets.includes(id)).join(', ') || 'none'}`);
check('five simultaneous guts sets all land',
  wantGuts.every((t) => mixed.gutsTeams.includes(t)),
  `missing ${wantGuts.filter((t) => !mixed.gutsTeams.includes(t)).join(', ') || 'none'}`);

// And every one of those tabs is still usable afterwards.
const alive = await Promise.all(crew.map((tab) => tab.isVisible('#app').catch(() => false)));
check('every scorer\u2019s tab survives the burst', alive.every(Boolean),
  `${alive.filter(Boolean).length}/10 alive`);

await Promise.all(crew.map((tab) => tab.close()));

// ---- a team with no division must not vanish silently ---------------
await page.click('.tab[data-entry="guts"]');
await page.selectOption('#gutsDivision', 'A');
await page.fill('#gutsTeam', '91');
await page.selectOption('#gutsSet', '1');
await page.fill('#gutsTeamName', 'No Division Yet');
await page.waitForTimeout(200);
await page.evaluate(() => {
  document.querySelectorAll('#gutsGrid .ans input').forEach((input, i) => {
    input.value = String((i + 1) * 2);
    input.dispatchEvent(new Event('input'));
  });
});
await page.click('#saveGuts');
await page.waitForTimeout(500);

// Division is part of the team key now, so a saved team always has one.
// Force a division-less row in to prove the leaderboard still warns.
await page.evaluate(() => {
  const db = JSON.parse(localStorage.getItem('contest-demo-db'));
  db.teams.push({ team: 'X91', name: 'No Division Yet', division: null, disqualified: false });
  db.gutsAnswers.push({ team: 'X91', problem: 1, answer: 2 });
  localStorage.setItem('contest-demo-db', JSON.stringify(db));
  window.dispatchEvent(new StorageEvent('storage', { key: 'contest-demo-db' }));
});
await page.click('.tab[data-tab="leaderboard"]');
await page.click('.tab[data-board="guts"]');
await page.waitForTimeout(600);
const orphanWarn = await page.textContent('#boards .banner--warn').catch(() => '');

check('a team with no division is called out rather than dropped',
  orphanWarn.includes('no division') && orphanWarn.includes('X91'),
  orphanWarn.trim().slice(0, 80));
check('the warning pluralises correctly',
  /One team has no division/.test(orphanWarn) || /\d+ teams have no division/.test(orphanWarn),
  orphanWarn.trim().slice(0, 50));
await page.click('.tab[data-entry="individual"]');

// ---- disqualification ----------------------------------------------
await page.click('.tab[data-tab="setup"]');
await page.fill('#dqTeam', 'A12');
await page.fill('#dqReason', 'Outside help');
await page.click('#dqAdd');
await page.waitForTimeout(600);
check('the DQ is listed with its reason',
  (await page.textContent('#dqList')).includes('Outside help'));
await page.click('.tab[data-tab="leaderboard"]');
await page.waitForTimeout(300);
check('a disqualified team drops out of the ranking',
  (await page.locator('#boards .table-wrap--dq').count()) >= 1);
await page.click('.tab[data-tab="setup"]');
await page.click('#dqList button');
await page.waitForTimeout(500);

// ---- exports --------------------------------------------------------
const readDownload = async (id) => {
  const dl = page.waitForEvent('download', { timeout: 5000 });
  await page.click(id);
  const d = await dl;
  const stream = await d.createReadStream();
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return { name: d.suggestedFilename(), text: Buffer.concat(chunks).toString('utf8') };
};
for (const [id, label] of [['#exportIndividual', 'individual'], ['#exportGuts', 'guts'],
  ['#exportCombined', 'combined']]) {
  const d = await readDownload(id);
  check(`${label} CSV downloads with rows`,
    d.name.endsWith('.csv') && d.text.trim().split('\n').length > 1, d.name);
}
const indCsv = await readDownload('#exportIndividual');
const indLines = indCsv.text.replace(/^\uFEFF/, '').trim().split('\n');
const width = indLines[0].split(',').length;
check('individual CSV columns line up',
  indLines.slice(1).every((l) => l.split(',').length === width),
  `header ${width} cols`);
// The numbers in the file have to be the numbers on the screen.
await page.click('.tab[data-tab="leaderboard"]');
await page.click('.tab[data-board="individual"]');
await page.waitForTimeout(400);
const boardTop = await page.evaluate(() => {
  const row = document.querySelector('#boards table tbody tr');
  return row ? [...row.children].map((c) => c.textContent.trim()) : null;
});
check('the exported individual CSV agrees with the leaderboard',
  boardTop === null || indLines.some((l) => {
    const cells = l.split(',');
    return cells[2] === boardTop[1] && cells[7] === boardTop[4];
  }),
  `board top row: ${boardTop?.slice(1, 5).join(' / ')}`);
await page.click('.tab[data-tab="setup"]');

check('the individual CSV ranks within each division, not across both',
  indLines[0].startsWith('rank_in_division'), indLines[0].split(',')[0]);
const firstOfEachDivision = ['A', 'B'].map((d) =>
  indLines.slice(1).find((l) => l.split(',')[1] === d)?.split(',')[0]);
check('each division starts again at rank 1',
  firstOfEachDivision.every((r) => r === undefined || r === '1'),
  firstOfEachDivision.join(' / '));

// ---- clear test data -------------------------------------------------
check('the wipe panel shows what would go',
  /\d+ sheets · \d+ guts answers/.test(await page.textContent('#wipeCounts')),
  await page.textContent('#wipeCounts'));
check('the wipe starts locked', await page.isDisabled('#wipeAll'));
await page.fill('#wipeConfirm', 'erase');
check('typing ERASE unlocks it', !(await page.isDisabled('#wipeAll')));
await page.click('#wipeAll');
await page.waitForTimeout(700);
check('answers are gone', (await page.textContent('#wipeCounts')) === 'Nothing to delete.');
await page.click('.tab[data-tab="key"]');
await page.waitForTimeout(300);
check('the answer key survives the wipe',
  (await page.textContent('#keyState')) === 'complete', await page.textContent('#keyState'));

// ---- theme + screenshots --------------------------------------------
await page.click('.tab[data-tab="setup"]');
await page.click('#seedDemo');
await page.waitForTimeout(3000);
await page.click('.tab[data-entry="individual"]');
await page.click('.tab[data-tab="progress"]');
await page.waitForTimeout(600);
const wantShots = process.env.SCREENSHOTS === '1';
if (wantShots) await page.screenshot({ path: 'docs/screenshot-portal.png' });
await page.click('.tab[data-tab="leaderboard"]');
await page.click('.tab[data-board="combined"]');
await page.waitForTimeout(400);
if (wantShots) await page.screenshot({ path: 'docs/screenshot-leaderboard.png' });

const shot = await ctx.newPage();
await shot.setViewportSize({ width: 1600, height: 900 });
await shot.goto(BOARD_URL, { waitUntil: 'networkidle' });
await shot.waitForTimeout(1500);
if (wantShots) await shot.screenshot({ path: 'docs/screenshot-guts-board.png' });
await shot.close();

// ---- half-updated cache ----------------------------------------------
// The bug this guards: a browser holding a new index.html and a stale
// script lost every control in the answer key tab, silently.
{
  const stale = await ctx.newPage();
  const staleErrors = [];
  stale.on('pageerror', (e) => staleErrors.push(String(e)));
  await stale.route(/index\.html/, async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace(/data-app-version="[^"]*"/, 'data-app-version="0.0.0"');
    await route.fulfill({ response: res, body });
  });
  // The context already has a name stored, so this tab signs straight in;
  // the banner is added before that happens and is still in the DOM.
  await stale.goto(`${BASE.replace('/?', '/index.html?')}`, { waitUntil: 'networkidle' });
  await stale.waitForSelector('#app:not(.hidden)');
  const warning = await stale.textContent('#gate .banner--error').catch(() => '');
  check('a half-updated page says so instead of misbehaving',
    warning.includes('half-updated'), warning.trim().slice(0, 60));

  // And the grid builder must survive a host that is not there.
  const survived = await stale.evaluate(() => {
    document.querySelector('#keyIndividualA')?.remove();
    return true;
  });
  await stale.click('.tab[data-tab="key"]');
  await stale.waitForTimeout(300);
  check('a missing grid does not take the rest of the tab with it',
    survived && (await stale.locator('#keyGuts .ans input').count()) === 28,
    `${await stale.locator('#keyGuts .ans input').count()} guts boxes still built`);
  check('and it does not throw', staleErrors.length === 0, staleErrors[0] ?? '');
  await stale.close();
}

check('no uncaught JavaScript errors', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
check('never touched a live Supabase project', liveRequests.length === 0,
  liveRequests.slice(0, 2).join(' | '));

await browser.close();
server.close();
console.log(out.join('\n'));
const checks = out.filter((l) => l.startsWith('PASS') || l.startsWith('FAIL'));
console.log(`\n${checks.filter((l) => l.startsWith('PASS')).length}/${checks.length} checks passed`);
