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

// ---- gate -------------------------------------------------------
check('gate is shown', await page.isVisible('#gate'));
check('?demo=1 forces the demo store even with credentials present',
  await page.isVisible('#gateDemo'));
check('password field hidden in demo mode', !(await page.isVisible('#passwordField')));

await page.fill('#graderName', 'Priya Raman');
await page.click('#gateEnter');
await page.waitForSelector('#app:not(.hidden)');
check('entered the app', await page.isVisible('#app'));
check('grader name is on the bar', (await page.textContent('#whoamiName')) === 'Priya Raman');

// ---- grade one proof --------------------------------------------
await page.fill('#contestantId', '12c');
check('ID is uppercased as you type', (await page.inputValue('#contestantId')) === '12C');
check('ID echo parses the team', (await page.textContent('#idEcho')).includes('Team 12, member C'));

await page.click('button.chip:has-text("A2")');
check('problem chip is pressed',
  (await page.getAttribute('button.chip:has-text("A2")', 'aria-pressed')) === 'true');

await page.keyboard.press('6');
check('number key sets the score',
  (await page.getAttribute('.score[aria-pressed="true"]', 'aria-pressed')) === 'true');
check('the right score is selected',
  (await page.textContent('.score[aria-pressed="true"]')) === '6');

await page.fill('#feedback', 'Induction is clean; the base case is asserted not proved.');
await page.click('#submitGrade');
await page.waitForTimeout(400);

const toastText = await page.textContent('.toast').catch(() => '');
check('a confirmation toast appears', toastText.includes('12C'), toastText);

// grader name must NOT have been disturbed by grading
check('grader name survives a submit', (await page.textContent('#whoamiName')) === 'Priya Raman');
check('contestant stays loaded for the next problem',
  (await page.inputValue('#contestantId')) === '12C');
const advanced = await page.getAttribute('button.chip:has-text("A1")', 'aria-pressed');
check('auto-advanced to the next ungraded problem', advanced === 'true', `A1 pressed=${advanced}`);
check('score pad was cleared', (await page.locator('.score[aria-pressed="true"]').count()) === 0);
check('feedback was cleared', (await page.inputValue('#feedback')) === '');

// ---- matrix -----------------------------------------------------
check('team 12 landed in Division A',
  await page.locator('#matrix .matrix__team:has-text("TEAM 12")').first().isVisible());
check('a score of 6 paints the cell amber, not green',
  (await page.locator('.cell--needs-second').count()) >= 1
  && (await page.locator('.cell--graded').count()) === 0);
check('progress bar rendered', await page.locator('.progress__fill').first().isVisible());

// A low score is settled by one read and should go straight to green.
await page.fill('#contestantId', '12C');
await page.click('button.chip:has-text("A3")');
await page.keyboard.press('2');
await page.click('#submitGrade');
await page.waitForTimeout(400);
check('a low score paints the cell green', (await page.locator('.cell--graded').count()) >= 1);

// second read flag: score a 7 and confirm the amber state
await page.fill('#contestantId', '12A');
await page.click('button.chip:has-text("A1")');
await page.keyboard.press('7');
await page.click('#submitGrade');
await page.waitForTimeout(400);
check('a high score is flagged for a second read',
  (await page.locator('.cell--needs-second').count()) >= 1);

// ---- suggestions ------------------------------------------------
const sugg = await page.locator('.suggest__item').count();
check('the queue has suggestions', sugg > 0, `${sugg} items`);
const myQueue = await page.locator('.suggest__item').allTextContents();
check('you are never offered a second read of your own work',
  !myQueue.some((t) => t.includes('second read')), myQueue[0]?.trim());

// ---- a second grader in another tab -----------------------------
const page2 = await ctx.newPage();
watch(page2, 'tab2');
// Both tabs share localStorage, so stamp a different grader id before the
// app boots — otherwise "tab 2" is the same person and none of the
// two-grader rules are actually exercised.
await page2.addInitScript(() => {
  localStorage.setItem('sfpo-grader-id', 'grader-dan');
  localStorage.setItem('sfpo-grader-name', 'Dan Whitfield');
});
await page2.goto(BASE, { waitUntil: 'networkidle' });
await page2.waitForSelector('#app:not(.hidden)', { timeout: 5000 });
check('tab 2 is a different grader',
  (await page2.textContent('#whoamiName')) === 'Dan Whitfield');
await page2.fill('#contestantId', '12B');
await page2.click('button.chip:has-text("A3")');
await page2.waitForTimeout(700);

// Tab 2 has read nothing, so the high scores tab 1 entered are exactly
// what it should be sent to double-check, ahead of everything else.
const danQueue = await page2.locator('.suggest__item').allTextContents();
check('the other grader is sent the second reads first',
  (danQueue[0] ?? '').includes('needs a second read'), (danQueue[0] ?? '').trim());

await page.waitForTimeout(900);
const claimedCells = await page.locator('.cell--claimed').count();
check('tab 1 sees tab 2 holding a cell (live lock)', claimedCells >= 1, `${claimedCells} claimed`);

// tab 1 must not be offered the cell tab 2 holds
const queueItems = await page.locator('.suggest__item').allTextContents();
check('the held cell is kept out of the queue',
  !queueItems.some((t) => t.includes('12B') && t.includes('A3')));

// and opening it directly warns you
await page.fill('#contestantId', '12B');
await page.click('button.chip:has-text("A3")');
await page.waitForTimeout(300);
const banner = await page.textContent('#cellBanner').catch(() => '');
check('opening a held cell warns about the other grader',
  banner.includes('grading this right now'), banner.trim().slice(0, 80));
await page2.close();

// ---- guards against a mistyped ID -------------------------------
check('the "editing your read" tag is hidden when it is not your read',
  !(await page.isVisible('#editingTag')));

await page.fill('#contestantId', '12C');       // team 12 is Division A
await page.click('button.chip:has-text("B4")');
await page.waitForTimeout(300);
const mismatch = await page.textContent('#cellBanner');
check('scoring a B problem for a Division A team is called out',
  mismatch.includes('Division A, but B4 is a Division B problem'), mismatch.trim().slice(0, 70));
await page.click('#clearForm');

// ---- seed + leaderboards ----------------------------------------
await page.click('.tab[data-tab="setup"]');
await page.click('#seedDemo');
await page.waitForTimeout(2500);

await page.click('.tab[data-tab="leaderboard"]');
await page.waitForTimeout(400);
const combinedRows = await page.locator('#boards table tbody tr').count();
check('combined leaderboard has rows', combinedRows > 0, `${combinedRows} rows`);
const firstRow = await page.locator('#boards table tbody tr').first().textContent();
check('combined row shows proof + guts + total', /Team \d+/.test(firstRow), firstRow.trim());

await page.click('.tab[data-board="individual"]');
await page.waitForTimeout(300);
check('individual leaderboard renders',
  (await page.locator('#boards table tbody tr').count()) > 0);
await page.click('.tab[data-board="guts"]');
await page.waitForTimeout(300);
check('guts leaderboard renders',
  (await page.locator('#boards table tbody tr').count()) > 0);

// ---- guts CSV import --------------------------------------------
await page.click('.tab[data-tab="setup"]');
check('the team count defaults to 100', (await page.inputValue('#teamCount')) === '100',
  await page.inputValue('#teamCount'));
await page.click('#saveSettings');
await page.waitForTimeout(500);

await page.setInputFiles('#gutsFile', {
  name: 'guts.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from('team,score\n1,120\n2,118\nbadrow,5\n'),
});
await page.waitForTimeout(900);
const gutsResult = await page.textContent('#gutsResult');
check('guts CSV imports the good rows', gutsResult.includes('2 team(s)'), gutsResult.trim().slice(0, 90));
check('guts CSV reports the bad row', gutsResult.includes('skipped'));

// ---- exports ----------------------------------------------------
const readDownload = async (id) => {
  const dl = page.waitForEvent('download', { timeout: 5000 });
  await page.click(id);
  const d = await dl;
  const stream = await d.createReadStream();
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return { name: d.suggestedFilename(), text: Buffer.concat(chunks).toString('utf8') };
};

for (const [id, file] of [['#exportGrades', 'grades'], ['#exportCombined', 'combined']]) {
  const d = await readDownload(id);
  check(`${file} CSV downloads`, d.name.endsWith('.csv'), d.name);
  check(`${file} CSV has rows`, d.text.trim().split('\n').length > 1);
}

// Both divisions share one file, and A has three problems to B's five —
// so every row must still be the same width as the header.
const indiv = await readDownload('#exportIndividual');
const lines = indiv.text.replace(/^\uFEFF/, '').trim().split('\n');
const width = lines[0].split(',').length;
const ragged = lines.slice(1).filter((l) => l.split(',').length !== width);
check('individual CSV columns line up across both divisions',
  ragged.length === 0, `header ${width} cols, ${ragged.length} ragged rows`);
const divA = lines.slice(1).find((l) => l.split(',')[1] === 'A');
check('a Division A row keeps total, status and the DQ columns',
  /,\d+(\.\d+)?,(complete|in progress),(yes|no),[^,]*$/.test(divA), divA);

// ---- weighting ---------------------------------------------------
await page.click('.tab[data-tab="setup"]');
check('the weights default to 80/20',
  (await page.inputValue('#proofWeight')) === '80' && (await page.inputValue('#gutsWeight')) === '20',
  `${await page.inputValue('#proofWeight')}/${await page.inputValue('#gutsWeight')}`);
const preview = await page.textContent('#weightPreview');
check('the weighting preview spells out the split',
  preview.includes('80 from proofs and 20 from guts'), preview.trim().slice(0, 70));

await page.fill('#gutsWeight', '0');
await page.waitForTimeout(150);
check('changing a weight updates the preview live',
  (await page.textContent('#weightPreview')).includes('100 from proofs and 0 from guts'));
await page.fill('#gutsWeight', '20');

await page.click('.tab[data-tab="leaderboard"]');
await page.click('.tab[data-board="combined"]');
await page.waitForTimeout(300);
const caption = await page.textContent('#boards');
check('the leaderboard states the formula',
  caption.includes('80% of the proof score plus 20% of the guts score'),
  caption.trim().slice(0, 80));
const topCombined = await page.locator('#boards table tbody tr').first().textContent();
check('combined scores are on a 0-100 scale',
  /\d+\.\d{2}/.test(topCombined), topCombined.trim());

// ---- disqualification --------------------------------------------
const rankedBefore = await page.locator('#boards table tbody tr').count();
// Read the cell, not the row text — concatenated columns turn
// "Team 7" + "24.0" into a bogus "Team 724".
const topTeam = ((await page.locator('#boards table tbody tr').first()
  .locator('td').nth(1).textContent()).match(/(\d+)/) ?? [])[1];
check('there is a leader to disqualify', Boolean(topTeam), topCombined.trim());

await page.click('.tab[data-tab="setup"]');
await page.click('#dqAdd');
await page.waitForTimeout(300);
check('a DQ without a team number is refused',
  (await page.locator('.toast').last().textContent()).includes('team number'),
  await page.locator('.toast').last().textContent());

await page.fill('#dqTeam', topTeam);
await page.click('#dqAdd');
await page.waitForTimeout(300);
check('a DQ without a reason is refused',
  (await page.locator('.toast').last().textContent()).includes('reason'),
  await page.locator('.toast').last().textContent());

await page.fill('#dqReason', 'Outside collaboration');
await page.click('#dqAdd');
await page.waitForTimeout(600);
check('the DQ list shows the team and reason',
  (await page.textContent('#dqList')).includes(`Team ${topTeam}`)
  && (await page.textContent('#dqList')).includes('Outside collaboration'));

await page.click('.tab[data-tab="leaderboard"]');
await page.waitForTimeout(300);
const rankedAfter = await page.locator('#boards .table-wrap:not(.table-wrap--dq) tbody tr').count();
check('the disqualified team leaves the ranking', rankedAfter === rankedBefore - 1,
  `${rankedBefore} -> ${rankedAfter}`);
const dqTable = await page.locator('#boards .table-wrap--dq').first().textContent();
check('it appears in a disqualified table with its score and reason',
  dqTable.includes(`Team ${topTeam}`) && dqTable.includes('Outside collaboration'), dqTable.trim().slice(0, 80));

await page.click('.tab[data-tab="matrix"]');
await page.waitForTimeout(300);
check('the matrix marks the team DQ',
  (await page.locator('.matrix__team--dq').count()) >= 1);

const queueAfter = await page.locator('.suggest__item').allTextContents();
check('the queue stops offering that team',
  !queueAfter.some((t) => new RegExp(`^${topTeam}[A-D]`).test(t.trim())),
  queueAfter.slice(0, 2).join(' | '));

// Reinstating must restore the team exactly.
await page.click('.tab[data-tab="setup"]');
await page.click('#dqList button');
await page.waitForTimeout(600);
check('reinstating clears the DQ list',
  (await page.textContent('#dqList')).includes('No teams are disqualified'));
await page.click('.tab[data-tab="leaderboard"]');
await page.waitForTimeout(300);
check('the team is back in the ranking',
  (await page.locator('#boards .table-wrap:not(.table-wrap--dq) tbody tr').count()) === rankedBefore);

// ---- clearing test data -----------------------------------------
await page.click('.tab[data-tab="setup"]');
const before = await page.textContent('#wipeCounts');
check('the wipe panel shows what would be deleted',
  /\d+ grades · \d+ guts scores/.test(before), before.trim());
check('the wipe button starts locked', await page.isDisabled('#wipeAll'));

await page.fill('#wipeConfirm', 'erase please');
check('a wrong confirmation keeps it locked', await page.isDisabled('#wipeAll'));

await page.fill('#wipeConfirm', 'erase');
check('typing ERASE unlocks it (case-insensitive)', !(await page.isDisabled('#wipeAll')));
await page.click('#wipeAll');
await page.waitForTimeout(700);

check('grades are gone', (await page.textContent('#wipeCounts')) === 'Nothing to delete.');
check('the confirmation box resets', (await page.inputValue('#wipeConfirm')) === '');
await page.click('.tab[data-tab="matrix"]');
await page.waitForTimeout(300);
check('the matrix empties out', (await page.locator('.cell--graded').count()) === 0);
await page.click('.tab[data-tab="leaderboard"]');
await page.waitForTimeout(300);
check('the leaderboards empty out',
  (await page.locator('#boards table tbody tr').count()) === 0);

// Settings are configuration, not test data — they must survive the wipe.
await page.click('.tab[data-tab="setup"]');
check('the team count survives the wipe',
  (await page.inputValue('#teamCount')) === '100', await page.inputValue('#teamCount'));

// ---- theme + screenshots ----------------------------------------
await page.click('.tab[data-tab="matrix"]');
await page.waitForTimeout(400);
await page.screenshot({ path: 'docs/screenshot-light.png', fullPage: false });
await page.click('#themeToggle');
await page.waitForTimeout(350);
check('dark theme applies',
  (await page.getAttribute('html', 'data-theme')) === 'dark');
await page.screenshot({ path: 'docs/screenshot-dark.png', fullPage: false });
await page.click('#themeToggle');
await page.waitForTimeout(300);
await page.click('.tab[data-tab="leaderboard"]');
await page.waitForTimeout(400);
await page.screenshot({ path: 'docs/screenshot-leaderboard.png' });

check('no uncaught JavaScript errors', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
check('never touched the live Supabase project', liveRequests.length === 0,
  liveRequests.slice(0, 2).join(' | '));
if (resourceErrors.length) {
  out.push(`NOTE  ${resourceErrors.length} resource fetch(es) failed in this sandbox: `
    + [...new Set(resourceErrors.map((e) => e.split(': ').pop().split('?')[0]))].join(', '));
}

await browser.close();
server.close();
console.log(out.join('\n'));
const checks = out.filter((l) => l.startsWith('PASS') || l.startsWith('FAIL'));
console.log(`\n${checks.filter((l) => l.startsWith('PASS')).length}/${checks.length} checks passed`);
