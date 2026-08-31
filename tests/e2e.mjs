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

// ---- answer key ---------------------------------------------------
await page.click('.tab[data-tab="key"]');
await page.waitForTimeout(200);
const keyBoxes = await page.locator('#keyIndividual .ans input').count();
check('the key has one box per individual problem', keyBoxes === 20, String(keyBoxes));
const gutsSets = await page.locator('#keyGuts .keyset').count();
check('the guts key is grouped into 7 sets', gutsSets === 7, String(gutsSets));
const gutsBoxes = await page.locator('#keyGuts .ans input').count();
check('7 sets of 4 is 28 guts boxes', gutsBoxes === 28, String(gutsBoxes));

// Fill the key: individual problem n -> n, guts problem n -> n*2.
await page.evaluate(() => {
  document.querySelectorAll('#keyIndividual .ans input').forEach((input, i) => {
    input.value = String(i + 1);
    input.dispatchEvent(new Event('input'));
  });
  document.querySelectorAll('#keyGuts .ans input').forEach((input, i) => {
    input.value = String((i + 1) * 2);
    input.dispatchEvent(new Event('input'));
  });
});
const setPoints = await page.locator('#keyGuts .keyset__points input').nth(6).inputValue();
check('set 7 defaults to 7 points each', setPoints === '7', setPoints);
await page.click('#saveKey');
await page.waitForTimeout(500);
check('the key saves and reports complete',
  (await page.textContent('#keyState')) === 'complete', await page.textContent('#keyState'));

// ---- individual entry ---------------------------------------------
await page.fill('#individualId', '12c');
await page.waitForTimeout(200);
check('the ID uppercases itself', (await page.inputValue('#individualId')) === '12C');
check('typing 12C fills the team box', (await page.inputValue('#teamNo')) === '12');
check('typing 12C fills the member box', (await page.inputValue('#memberLetter')) === 'C');

await page.fill('#teamNo', '13');
await page.waitForTimeout(150);
check('the team box stays editable and updates the ID',
  (await page.inputValue('#individualId')) === '13C', await page.inputValue('#individualId'));
await page.fill('#individualId', '12C');
await page.waitForTimeout(150);

await page.selectOption('#divisionPick', 'A');
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
check('the sheet saves with its score', savedToast.includes('12C') && savedToast.includes('6 pts'),
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
  (await page.locator('.person--partial, .person--done').first().textContent()).includes('12C'));

// ---- guts ----------------------------------------------------------
await page.click('.tab[data-entry="guts"]');
await page.waitForTimeout(200);
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
await page.waitForTimeout(1400);
const running = await page.textContent('#clockBig');
check('starting the clock makes it count down', running !== '74:00', running);
await page.click('#clockPause');
await page.waitForTimeout(400);
const paused = await page.textContent('#clockBig');
await page.waitForTimeout(1400);
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
check('the public board shows the team and its score',
  boardText.includes('Cowbell') && boardText.includes('32'), boardText.slice(0, 120));
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
await page2.fill('#individualId', '20A');
await page2.waitForTimeout(700);

await page.click('.tab[data-entry="individual"]');
await page.fill('#individualId', '20A');
await page.waitForTimeout(900);
check('opening a sheet someone else holds warns you',
  (await page.textContent('#individualBanner')).includes('entering this sheet right now'),
  (await page.textContent('#individualBanner')).trim().slice(0, 70));
await page2.close();

// ---- disqualification ----------------------------------------------
await page.click('.tab[data-tab="setup"]');
await page.fill('#dqTeam', '12');
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
await page.screenshot({ path: 'docs/screenshot-portal.png' });
await page.click('.tab[data-tab="leaderboard"]');
await page.click('.tab[data-board="combined"]');
await page.waitForTimeout(400);
await page.screenshot({ path: 'docs/screenshot-leaderboard.png' });

const shot = await ctx.newPage();
await shot.setViewportSize({ width: 1600, height: 900 });
await shot.goto(BOARD_URL, { waitUntil: 'networkidle' });
await shot.waitForTimeout(1500);
await shot.screenshot({ path: 'docs/screenshot-guts-board.png' });
await shot.close();

check('no uncaught JavaScript errors', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
check('never touched a live Supabase project', liveRequests.length === 0,
  liveRequests.slice(0, 2).join(' | '));

await browser.close();
server.close();
console.log(out.join('\n'));
const checks = out.filter((l) => l.startsWith('PASS') || l.startsWith('FAIL'));
console.log(`\n${checks.filter((l) => l.startsWith('PASS')).length}/${checks.length} checks passed`);
