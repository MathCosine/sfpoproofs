// =====================================================================
//  Cowconuts 2026 Annual Math Contest — staff portal
// =====================================================================

import { CONFIG, APP_VERSION, resolvedConfig, readOverride, writeOverride } from './config.js';
import { createStore } from './store.js';
import { toCsv, downloadCsv } from './csv.js';
import {
  parseIndividualId, isMemberNumber, teamKey, divisionOfTeam, teamNumberOf,
  parseAnswer, problemsInSet, gutsProblemCount,
  indexKey, keyGaps, individualKey, GUTS_DIVISION, divisionStatistics, awardLines,
  competitionRanks,
  TEAM_COUNTING_MEMBERS, individualMultiplier, combinedMaxPoints,
  awardLine, nameAllowed, parseNameList, parseRoster, indexRoster,
  graderActivity, sinceLabel, rosterRows, filterRoster,
  scoreSheet, individualStandings, indexGutsAnswers, scoreGutsTeam, gutsStandings,
  combinedStandings, splitByDivision, dqTeams, liveClaims, claimRef,
  gutsRemaining, shouldFreeze, formatClock, individualMaxPoints, gutsMaxPoints,
} from './scoring.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const forceDemo = new URLSearchParams(location.search).has('demo');
// Deliberately not location.search: the portal asks for a password, so a
// link carrying someone else's Supabase project would show the ordinary
// sign-in screen and post that password to whoever sent the link.
const cfg = resolvedConfig();
const store = createStore(cfg, { forceDemo });

const grader = {
  id: localStorage.getItem('contest-grader-id') || crypto.randomUUID(),
  name: localStorage.getItem('contest-grader-name') || '',
};
localStorage.setItem('contest-grader-id', grader.id);

const GUTS_N = gutsProblemCount(cfg);
const QUEUE_LIMIT = 12;

let data = {
  settings: null, state: null, key: [], teams: [],
  contestants: [], gutsAnswers: [], claims: [], graders: [],
};
let derived = null;
let entryMode = 'individual';
let activeTab = 'progress';
let activeBoard = 'combined';
const boardPage = { A: 0, B: 0 };
let held = null;           // { scope, ref }
let blockedBy = null;
let connected = false;
let clockTimer = null;
let freezing = false;
let isAdmin = false;

// ---------------------------------------------------------------------
function toast(message, kind = 'ok') {
  const node = el('div', `toast${kind === 'ok' ? '' : ` toast--${kind}`}`, message);
  $('#toasts').appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s ease';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 220);
  }, kind === 'error' ? 5200 : 2600);
}

// ---------------------------------------------------------------------
function recompute() {
  const s = data.settings ?? {};
  if (s.team_count) cfg.TEAM_COUNT = Number(s.team_count);
  if (s.individual_multiplier != null) cfg.INDIVIDUAL_MULTIPLIER = Number(s.individual_multiplier);

  const key = indexKey(data.key);
  const dq = dqTeams(data.teams);
  const claims = liveClaims(data.claims, cfg);
  const gutsByTeam = indexGutsAnswers(data.gutsAnswers);
  const individuals = individualStandings(data.contestants, key, cfg, dq);
  const guts = gutsStandings(data.teams, gutsByTeam, key, cfg, dq);
  const combined = combinedStandings(individuals, guts, key, cfg, data.teams);

  derived = {
    key, dq, claims, gutsByTeam, individuals, guts, combined,
    byId: new Map(individuals.map((p) => [p.individualId, p])),
    keyGapsIndividual: Object.fromEntries(cfg.DIVISIONS.map(
      (d) => [d, keyGaps(key, 'individual', cfg.INDIVIDUAL_PROBLEMS, d)])),
    keyGapsGuts: keyGaps(key, 'guts', GUTS_N, GUTS_DIVISION),
    teamsByNo: new Map(data.teams.map((t) => [String(t.team), t])),
    rosterNames: indexRoster(data.roster),
    queue: buildQueue(claims, dq, gutsByTeam),
  };
}

/**
 * What to enter next. Sheets in hand come first: any contestant a team
 * has started but not finished, then teams with guts sets missing.
 * Anything somebody else is holding is left out.
 */
function buildQueue(claims, dq, gutsByTeam) {
  const out = [];
  if (entryMode === 'individual') {
    const seenTeams = new Set(data.contestants.map((c) => String(c.team)));
    for (const team of [...seenTeams].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
      if (dq.has(team)) continue;
      for (const member of cfg.MEMBERS) {
        const id = `${team}${member}`;
        if (data.contestants.some((c) => c.individual_id === id)) continue;
        if (claims.has(`individual|${id}`)) continue;
        out.push({ kind: 'individual', id, label: id, why: `team ${team} is part-entered` });
      }
    }
  } else {
    for (const t of [...data.teams]
      .sort((a, b) => String(a.team).localeCompare(String(b.team), undefined, { numeric: true }))) {
      if (dq.has(String(t.team))) continue;
      const answers = gutsByTeam.get(String(t.team));
      for (let set = 1; set <= cfg.GUTS_SETS; set += 1) {
        const problems = problemsInSet(set, cfg);
        const done = problems.every((p) => answers?.get(p) != null);
        if (done) continue;
        if (claims.has(`guts|${t.team}:${set}`)) continue;
        out.push({
          kind: 'guts', team: String(t.team), set,
          label: `${t.team} · set ${set}`,
          why: t.name || 'no team name yet',
        });
        break;                       // one open set per team keeps it fair
      }
    }
  }
  return out.slice(0, QUEUE_LIMIT);
}

// ---------------------------------------------------------------------
// Answer boxes
// ---------------------------------------------------------------------

/**
 * A run of numbered boxes that behaves like a keypad: typing moves you
 * on, arrows and backspace move you back, and paste spreads a whole row
 * of numbers across the grid.
 */
function buildAnswerGrid(host, count, { offset = 0, onChange, columns = 5, onLast } = {}) {
  // A null host means the markup and this script disagree — usually a
  // half-updated cache. Returning empty keeps the rest of the tab alive
  // instead of throwing and leaving a panel with no controls at all.
  if (!host) return [];
  host.replaceChildren();
  const inputs = [];
  for (let i = 0; i < count; i += 1) {
    const wrap = el('div', 'ans');
    wrap.appendChild(el('span', 'ans__no', String(offset + i + 1)));
    const input = el('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.dataset.index = String(i);
    input.setAttribute('aria-label', `Problem ${offset + i + 1}`);

    input.addEventListener('input', () => {
      const parsed = parseAnswer(input.value);
      wrap.classList.toggle('ans--bad', !parsed.ok);
      wrap.classList.toggle('ans--filled', parsed.ok && parsed.value != null);
      onChange?.();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        // Enter off the last box lands on Save rather than going nowhere,
        // so a whole sheet is keyed and filed without touching the mouse.
        if (inputs[i + 1]) inputs[i + 1].focus();
        else onLast?.();
      }
      if (e.key === 'ArrowRight' && input.selectionStart === input.value.length) inputs[i + 1]?.focus();
      if (e.key === 'ArrowLeft' && input.selectionStart === 0) inputs[i - 1]?.focus();
      if (e.key === 'ArrowDown') { e.preventDefault(); inputs[i + columns]?.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); inputs[i - columns]?.focus(); }
      if (e.key === 'Backspace' && input.value === '') inputs[i - 1]?.focus();
    });
    input.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text') ?? '';
      const parts = text.split(/[\s,;\t\n]+/).filter(Boolean);
      if (parts.length < 2) return;
      e.preventDefault();
      parts.forEach((value, k) => {
        const target = inputs[i + k];
        if (!target) return;
        target.value = value.replace(/[^0-9]/g, '');
        target.dispatchEvent(new Event('input'));
      });
      inputs[Math.min(i + parts.length, inputs.length - 1)]?.focus();
    });
    wrap.appendChild(input);
    host.appendChild(wrap);
    inputs.push(input);
  }
  return inputs;
}

function readGrid(inputs) {
  const values = [];
  let bad = false;
  for (const input of inputs) {
    const parsed = parseAnswer(input.value);
    if (!parsed.ok) { bad = true; values.push(null); } else values.push(parsed.value);
  }
  return { values, bad };
}

function fillGrid(inputs, values) {
  inputs.forEach((input, i) => {
    const v = values?.[i];
    input.value = v == null ? '' : String(v);
    input.dispatchEvent(new Event('input'));
  });
}

// ---------------------------------------------------------------------
// Individual entry
// ---------------------------------------------------------------------

let sheetInputs = [];
let gutsInputs = [];
let gutsLoadedRef = null;

function currentIndividualId() {
  const division = $('#divisionPick').value;
  const teamNo = Number($('#teamNo').value);
  const member = $('#memberLetter').value.trim();
  if (!division || !Number.isInteger(teamNo) || teamNo < 1 || !isMemberNumber(member)) return null;
  const team = teamKey(division, teamNo);
  return { id: `${team}${member}`, division, team, teamNo, member };
}

/** Keep the ID box and the three fields showing the same thing. */
function syncIdFromFields() {
  const current = currentIndividualId();
  if (current) $('#individualId').value = current.id;
}

function onIdTyped() {
  const input = $('#individualId');
  input.value = input.value.toUpperCase();
  const parsed = parseIndividualId(input.value);
  const echo = $('#idEcho');
  echo.classList.remove('field__hint--error');

  if (parsed.ok) {
    $('#divisionPick').value = parsed.division;
    $('#teamNo').value = parsed.teamNo;
    $('#memberLetter').value = parsed.member;
    echo.textContent = `Division ${parsed.division}, team ${String(parsed.teamNo).padStart(2, '0')}, `
      + `member ${parsed.member}. All three stay editable.`;
    loadExistingSheet();
    claimCurrent();
  } else if (parsed.partial) {
    $('#divisionPick').value = parsed.division;
    if (parsed.teamNo) $('#teamNo').value = parsed.teamNo;
    echo.textContent = parsed.error;
  } else if (input.value.trim()) {
    echo.textContent = parsed.error;
    echo.classList.add('field__hint--error');
  } else {
    echo.textContent = 'Type A011 — division, team, member fill themselves in.';
  }
  refreshIndividualContext();
}

/**
 * Pull back a sheet that has already been entered, so it can be fixed —
 * and blank the boxes when the new ID has nothing saved. Returning early
 * instead left the last contestant's twenty answers sitting in the grid,
 * so moving from an entered sheet to an empty one and pressing Save
 * filed one person's paper under another person's ID.
 *
 * Only when the ID actually changes: a repeat call must not wipe what
 * somebody is part way through typing.
 *
 * `keepUnsaved` is for the division dropdown. Division is part of the ID,
 * but changing it means "this paper belongs to the other division", not
 * "show me a different contestant" — the sheet in hand stays in the boxes
 * and is re-marked against the other paper, which is how a sheet keyed
 * against the wrong one shows up as a wall of red. A contestant who does
 * have a saved sheet still wins: their answers are never overwritten
 * on screen by someone else's typing.
 */
let sheetLoadedFor = null;

function loadExistingSheet({ keepUnsaved = false } = {}) {
  const current = currentIndividualId();
  if (!current) { sheetLoadedFor = null; return; }
  if (current.id === sheetLoadedFor) return;
  sheetLoadedFor = current.id;
  const existing = data.contestants.find((c) => c.individual_id === current.id);
  if (!existing && keepUnsaved) return;
  fillGrid(sheetInputs, existing?.answers ?? []);
  // A saved sheet keeps whatever name it was saved with. A new one takes
  // the name from the participant list, and stays blank for anyone who
  // is not on it.
  $('#contestantName').value = existing?.name ?? derived.rosterNames.get(current.id) ?? '';
}

function refreshIndividualContext() {
  const current = currentIndividualId();
  const host = $('#individualBanner');
  host.replaceChildren();
  $('#sheetState').textContent = '';
  $('#sheetState').hidden = true;

  const division = $('#divisionPick').value;
  const gaps = division ? (derived?.keyGapsIndividual?.[division] ?? []) : [];
  $('#answersHint').textContent = !division
    ? `— out of ${cfg.INDIVIDUAL_PROBLEMS}`
    : gaps.length
      ? `— ${gaps.length} of ${cfg.INDIVIDUAL_PROBLEMS} not in the Division ${division} key yet`
      : `— out of ${cfg.INDIVIDUAL_PROBLEMS}, Division ${division} key`;

  if (!current) return;

  const team = derived.teamsByNo.get(current.team);

  const claim = derived.claims.get(`individual|${current.id}`) ?? blockedBy;
  if (claim && claim.grader_id !== grader.id) {
    const b = el('div', 'banner banner--warn');
    const d = el('div');
    d.append(el('b', null, `${claim.grader_name} is entering this sheet right now`),
      el('span', null, 'Take another one from the list so it is not keyed twice.'));
    b.append(el('div', null, '✋'), d);
    host.appendChild(b);
  }

  if (derived.dq.has(current.team)) {
    const b = el('div', 'banner banner--error');
    const d = el('div');
    d.append(el('b', null, `Team ${current.team} is disqualified`),
      el('span', null, team?.dq_reason || 'It will not appear in the standings.'));
    b.append(el('div', null, '⛔'), d);
    host.appendChild(b);
  }

  if (current.teamNo > cfg.TEAM_COUNT) {
    const b = el('div', 'banner banner--warn');
    const d = el('div');
    d.append(el('b', null, `Team ${current.team} is above your team count of ${cfg.TEAM_COUNT}`),
      el('span', null, 'Usually a mistyped number. It will still save if that is really the team.'));
    b.append(el('div', null, '⚠'), d);
    host.appendChild(b);
  }

  // A team fields four. A mistyped fifth member would be saved, scored,
  // and would then compete for one of the three counting places — a
  // wrong team total with nothing on screen to explain it.
  if (!cfg.MEMBERS.includes(current.member)) {
    const b = el('div', 'banner banner--warn');
    const d = el('div');
    d.append(el('b', null, `Member ${current.member} is outside the team of ${cfg.MEMBERS.length}`),
      el('span', null, 'Usually a mistyped ID. Saving it would let a fifth score count '
        + 'towards the team total.'));
    b.append(el('div', null, '⚠'), d);
    host.appendChild(b);
  }

  const existing = data.contestants.find((c) => c.individual_id === current.id);
  if (existing) {
    const person = derived.byId.get(current.id);
    $('#sheetState').hidden = false;
    $('#sheetState').textContent = `already entered · ${person?.score ?? 0} pts`;
    const b = el('div', 'banner banner--info');
    const d = el('div');
    d.append(el('b', null, `Entered by ${existing.entered_by_name || 'someone'}`),
      el('span', null, 'Saving again replaces that sheet.'));
    b.append(el('div', null, '✎'), d);
    host.appendChild(b);
  }
  markSheetAgainstKey();
}

/** Tint each box green/red once the key knows that problem. */
function markSheetAgainstKey() {
  const { values } = readGrid(sheetInputs);
  const division = $('#divisionPick').value;
  const result = scoreSheet(values, derived.key, cfg, division);
  sheetInputs.forEach((input, i) => {
    const wrap = input.parentElement;
    wrap.classList.remove('ans--correct', 'ans--wrong', 'ans--unkeyed');
    if (values[i] == null) return;
    const mark = result.marks[i];
    if (mark === 'correct') wrap.classList.add('ans--correct');
    else if (mark === 'wrong') wrap.classList.add('ans--wrong');
    else if (mark === 'unkeyed') wrap.classList.add('ans--unkeyed');
  });
  $('#myCount').textContent = division
    ? `${result.correct} correct · ${result.score} pts`
    : 'pick a division to score';
}

async function saveSheet() {
  const current = currentIndividualId();
  if (!current) {
    const member = $('#memberLetter').value.trim();
    if (!$('#divisionPick').value) {
      toast('Pick a division.', 'error');
      $('#divisionPick').focus();
    } else if (member && !isMemberNumber(member)) {
      toast('Member is 1 to 4.', 'error');
      $('#memberLetter').focus();
    } else {
      toast('Enter an individual ID, like A011.', 'error');
      $('#individualId').focus();
    }
    return;
  }
  const division = current.division;
  const { values, bad } = readGrid(sheetInputs);
  if (bad) { toast('One of the answers is not a whole number.', 'error'); return; }

  const button = $('#saveSheet');
  button.disabled = true;
  // Read the row before clearing the form, not after.
  const row = {
    individual_id: current.id,
    team: current.team,
    member: current.member,
    division,
    name: $('#contestantName').value.trim(),
    answers: values,
    entered_by: grader.id,
    entered_by_name: grader.name,
    entered_at: new Date().toISOString(),
  };
  try {
    await store.saveContestant(row);
    const result = scoreSheet(values, derived.key, cfg, division);
    toast(`${current.id} saved · ${result.correct}/${cfg.INDIVIDUAL_PROBLEMS} · ${result.score} pts`);
    await releaseHeld();
    clearSheet({ keepTeam: true });
    applyWrite([['contestants', row]]);
  } catch (err) {
    toast(err.message || 'Could not save that sheet.', 'error');
  } finally {
    button.disabled = false;
  }
}

function clearSheet({ keepTeam = false } = {}) {
  releaseHeld();
  sheetLoadedFor = null;
  $('#individualId').value = '';
  if (!keepTeam) { $('#teamNo').value = ''; $('#divisionPick').value = ''; }
  $('#memberLetter').value = '';
  $('#contestantName').value = '';
  fillGrid(sheetInputs, []);
  $('#idEcho').textContent = 'Type A011 — division, team, member fill themselves in.';
  refreshIndividualContext();
  $('#individualId').focus();
}

// ---------------------------------------------------------------------
// Guts entry
// ---------------------------------------------------------------------

/** Clear the per-team guts fields so one team's details never carry to the next. */
function resetGutsTeamFields() {
  $('#gutsTeamName').dataset.dirty = '';
  $('#gutsTeamName').value = '';
  gutsLoadedRef = null;
}

function currentGuts() {
  const division = $('#gutsDivision').value;
  const teamNo = Number($('#gutsTeam').value);
  const set = Number($('#gutsSet').value);
  if (!division || !Number.isInteger(teamNo) || teamNo < 1 || !set) return null;
  return { team: teamKey(division, teamNo), division, teamNo, set };
}

function refreshGutsContext({ keepUnsaved = false, picked = false } = {}) {
  const host = $('#gutsBanner');
  host.replaceChildren();
  const current = currentGuts();
  const gaps = derived?.keyGapsGuts ?? [];
  $('#gutsState').textContent = gaps.length ? `${gaps.length} guts answers unkeyed` : 'key complete';

  if (!current) { $('#gutsPointsHint').textContent = ''; $('#gutsProgress').textContent = ''; return; }

  const problems = problemsInSet(current.set, cfg);
  const points = derived.key.guts.get(problems[0])?.points ?? 1;
  $('#gutsPointsHint').textContent =
    `— problems ${problems[0]}–${problems[problems.length - 1]}, ${points} point(s) each`;

  const team = derived.teamsByNo.get(current.team);
  const nameInput = $('#gutsTeamName');
  if (team?.name && !nameInput.dataset.dirty) nameInput.value = team.name;
  $('#gutsNameHint').textContent = team?.name
    ? 'Recorded already — edit only if it is wrong.'
    : 'First time this team is scored, so give it a name for the public board.';
  // Load the stored answers only when the selection actually changes.
  // This used to run on every render, which meant another scorer saving
  // anything at all wiped whatever you were half way through typing.
  const answers = derived.gutsByTeam.get(current.team);
  const ref = `${current.team}:${current.set}`;
  // The focus guard is there to stop a background render overwriting what
  // somebody is typing. It must not stop the scorer's own change of team
  // or set — `picked` says the selection was just changed on purpose.
  const typing = document.activeElement?.closest('#gutsGrid');
  if (ref !== gutsLoadedRef && (picked || !typing)) {
    gutsLoadedRef = ref;
    const stored = problems.map((p) => answers?.get(p) ?? null);
    if (stored.some((v) => v != null) || !keepUnsaved) fillGrid(gutsInputs, stored);
  }

  const result = scoreGutsTeam(answers, derived.key, cfg);
  $('#gutsProgress').textContent =
    `${result.perSet.filter((s) => s.complete).length}/${cfg.GUTS_SETS} sets · ${result.score} pts`;

  const claim = derived.claims.get(`guts|${current.team}:${current.set}`) ?? blockedBy;
  if (claim && claim.grader_id !== grader.id) {
    const b = el('div', 'banner banner--warn');
    const d = el('div');
    d.append(el('b', null, `${claim.grader_name} is entering this set right now`),
      el('span', null, 'Pick a different team or set.'));
    b.append(el('div', null, '✋'), d);
    host.appendChild(b);
  }
  if (derived.dq.has(current.team)) {
    const b = el('div', 'banner banner--error');
    const d = el('div');
    d.append(el('b', null, `Team ${current.team} is disqualified`),
      el('span', null, 'It is off the public board.'));
    b.append(el('div', null, '⛔'), d);
    host.appendChild(b);
  }
}

async function saveGutsSet() {
  const current = currentGuts();
  if (!current) {
    toast($('#gutsDivision').value ? 'Enter a team number and pick a set.' : 'Pick a division.',
      'error');
    $($('#gutsDivision').value ? '#gutsTeam' : '#gutsDivision').focus();
    return;
  }
  const { values, bad } = readGrid(gutsInputs);
  if (bad) { toast('One of the answers is not a whole number.', 'error'); return; }

  const team = derived.teamsByNo.get(current.team);
  const typedName = $('#gutsTeamName').value.trim();
  if (!team?.name && !typedName) {
    toast('Give the team a name — it is what the public board shows.', 'error');
    $('#gutsTeamName').focus();
    return;
  }
  // Without a division a team ranks in neither table, and a guts-only
  // team would otherwise never be asked for one.


  const problems = problemsInSet(current.set, cfg);
  const button = $('#saveGuts');
  button.disabled = true;
  try {
    await store.saveGutsSet(
      current.team,
      problems.map((p, i) => ({ problem: p, answer: values[i] })),
      grader.id, grader.name,
      typedName || null,
    );
    if (current.division !== team?.division) {
      await store.setTeam(current.team, { division: current.division });
    }
    toast(`Team ${current.team} set ${current.set} saved.`);
    await releaseHeld();
    $('#gutsTeamName').dataset.dirty = '';
    const next = current.set < cfg.GUTS_SETS ? current.set + 1 : current.set;
    $('#gutsSet').value = String(next);
    gutsLoadedRef = null;
    fillGrid(gutsInputs, []);
    applyWrite([
      ...problems.map((p, i) => ['guts_answers', {
        team: current.team,
        problem: p,
        answer: values[i],
        entered_by: grader.id,
        entered_by_name: grader.name,
      }]),
      ['teams', {
        ...(team ?? {}),
        team: current.team,
        division: current.division,
        name: typedName || team?.name || '',
      }],
    ]);
    gutsInputs[0]?.focus();
  } catch (err) {
    toast(err.message || 'Could not save that set.', 'error');
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------

function wantedClaim() {
  if (entryMode === 'individual') {
    const current = currentIndividualId();
    return current ? claimRef.individual(current.id) : null;
  }
  const current = currentGuts();
  return current ? claimRef.guts(current.team, current.set) : null;
}

let claiming = false;
// When the lock we hold was last written, so the renewal below can wait
// until it is actually near expiry.
let lastClaimAt = 0;

async function claimCurrent() {
  const want = wantedClaim();
  if (!want || claiming) return;
  if (held && held.scope === want.scope && held.ref === want.ref) return;
  claiming = true;
  try {
    // Let go of the sheet we were on before taking the next. Without
    // this a scorer flicking through IDs leaves every one of them locked
    // for the full two minutes, and everybody else is told those sheets
    // are being entered right now when nobody is on them.
    await releaseHeld();
    const result = await store.claim(want.scope, want.ref, grader, cfg.CLAIM_TTL_MS);
    if (result?.ok === false) {
      blockedBy = result.heldBy ?? null;
      held = null;
      claiming = false;
      refreshIndividualContext();
      return;
    }
    blockedBy = null;
    held = want;
    lastClaimAt = Date.now();
  } catch { /* a lost claim must never block entry */ } finally {
    claiming = false;
  }
}

async function releaseHeld() {
  blockedBy = null;
  if (!held) return;
  const { scope, ref } = held;
  held = null;
  try { await store.releaseClaim(scope, ref, grader.id); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------

function renderSuggestions() {
  const host = $('#suggestList');
  host.replaceChildren();
  $('#queueCount').textContent = derived.queue.length >= QUEUE_LIMIT
    ? `${QUEUE_LIMIT}+` : String(derived.queue.length);
  if (!derived.queue.length) {
    host.appendChild(el('div', 'empty', entryMode === 'individual'
      ? 'Nothing outstanding. Enter any ID directly above.'
      : 'Every team has a complete set of guts answers.'));
    return;
  }
  for (const item of derived.queue) {
    const btn = el('button', 'suggest__item');
    btn.type = 'button';
    btn.append(el('span', 'suggest__id', item.label), el('span', 'suggest__why', item.why));
    btn.addEventListener('click', () => {
      if (item.kind === 'individual') {
        $('#individualId').value = item.id;
        onIdTyped();
        sheetInputs[0]?.focus();
      } else {
        $('#gutsDivision').value = divisionOfTeam(item.team) ?? '';
        $('#gutsTeam').value = String(teamNumberOf(item.team) ?? '');
        $('#gutsSet').value = String(item.set);
        resetGutsTeamFields();
        refreshGutsContext({ picked: true });
        claimCurrent();
        gutsInputs[0]?.focus();
      }
    });
    host.appendChild(btn);
  }
}

// ---------------------------------------------------------------------
// Progress — individual by individual, never twenty boxes
// ---------------------------------------------------------------------

// The progress panel is the expensive one: 400 chips and 700 pips at
// full scale, rebuilt on every realtime event. Build the DOM when the
// roster's shape changes, and only repaint after that — the same trick
// the coverage matrix used, measured at 55ms down to single figures.
let progressShape = null;
const progressChips = new Map();     // individualId -> element
const progressPips = new Map();      // "team:set"   -> element
const progressTeams = new Map();     // team         -> { card, head }

function progressSignature() {
  const teams = [...new Set([
    ...data.teams.map((t) => String(t.team)),
    ...data.contestants.map((c) => String(c.team)),
  ])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return teams.map((t) => `${t}${derived.teamsByNo.get(t)?.name ?? ''}`).join(',');
}

function buildProgress(teams) {
  const host = $('#progressPanel');
  // This rebuilds whenever a team first appears, which during a contest is
  // every few minutes. Without keeping the scroll, the roster someone is
  // reading jumps back to the top each time a colleague saves a sheet.
  const keepScroll = host.querySelector('.roster')?.scrollTop ?? 0;
  host.replaceChildren();
  progressChips.clear();
  progressPips.clear();
  progressTeams.clear();

  const bar = el('div', 'matrix__bar');
  bar.append(el('span', 'tag tag--a', ''), el('span', 'muted', ''), el('span', 'spacer'),
    el('span', 'muted', ''));
  host.appendChild(bar);
  progressTeams.set('__bar', bar);

  if (!teams.length) {
    host.appendChild(el('div', 'empty',
      'Nothing entered yet. Type an individual ID on the left to begin.'));
    return;
  }

  const roster = el('div', 'roster');
  for (const teamNo of teams) {
    const card = el('div', 'rosterteam');
    const head = el('div', 'rosterteam__head');
    head.append(el('span', null, `TEAM ${teamNo}`), el('span', 'rosterteam__name'),
      el('span', 'tag'), el('span', 'tag tag--flag', 'DQ'), el('span', 'spacer'));
    const pips = el('div', 'setpips');
    for (let set = 1; set <= cfg.GUTS_SETS; set += 1) {
      const pip = el('div', 'setpip', String(set));
      progressPips.set(`${teamNo}:${set}`, pip);
      pips.appendChild(pip);
    }
    head.appendChild(pips);
    card.appendChild(head);

    const people = el('div', 'people');
    for (const member of cfg.MEMBERS) {
      const id = `${teamNo}${member}`;
      const chip = el('button', 'person');
      chip.type = 'button';
      chip.dataset.id = id;
      chip.append(el('span', null, id), el('span', 'person__score'));
      progressChips.set(id, chip);
      people.appendChild(chip);
    }
    card.appendChild(people);
    progressTeams.set(teamNo, { card, head });
    roster.appendChild(card);
  }
  host.appendChild(roster);
  roster.scrollTop = keepScroll;
}

function paintProgress(teams) {
  const bar = progressTeams.get('__bar');
  if (bar) {
    const done = derived.individuals.filter((p) => p.answered > 0).length;
    const gutsDone = derived.guts.reduce(
      (n, g) => n + g.perSet.filter((x) => x.complete).length, 0);
    const [tag, sheets, , sets] = bar.children;
    tag.textContent = `${teams.length} of ${cfg.TEAM_COUNT} teams`;
    sheets.textContent = `${done} sheets entered`;
    sets.textContent = `${gutsDone}/${teams.length * cfg.GUTS_SETS} guts sets`;
  }

  for (const teamNo of teams) {
    const entry = progressTeams.get(teamNo);
    if (!entry) continue;
    const team = derived.teamsByNo.get(teamNo);
    entry.card.classList.toggle('rosterteam--dq', Boolean(team?.disqualified));
    const [, name, division, dq] = entry.head.children;
    name.textContent = team?.name ?? '';
    division.textContent = team?.division ?? '';
    division.className = team?.division ? `tag tag--${team.division.toLowerCase()}` : 'tag';
    division.hidden = !team?.division;
    dq.hidden = !team?.disqualified;

    const result = scoreGutsTeam(derived.gutsByTeam.get(teamNo), derived.key, cfg);
    for (const set of result.perSet) {
      const pip = progressPips.get(`${teamNo}:${set.set}`);
      if (!pip) continue;
      let cls = 'setpip';
      if (set.complete) cls += ' setpip--done';
      else if (set.answered) cls += ' setpip--partial';
      else if (derived.claims.has(`guts|${teamNo}:${set.set}`)) cls += ' setpip--claimed';
      if (pip.className !== cls) pip.className = cls;
      pip.title = `Guts set ${set.set} — ${set.answered}/${cfg.GUTS_PER_SET} entered, ${set.score} pts`;
    }

    for (const member of cfg.MEMBERS) {
      const id = `${teamNo}${member}`;
      const chip = progressChips.get(id);
      if (!chip) continue;
      const person = derived.byId.get(id);
      const claimed = derived.claims.get(`individual|${id}`);
      let cls = 'person';
      if (person?.disqualified) cls += ' person--out';
      else if (person && person.answered === cfg.INDIVIDUAL_PROBLEMS) cls += ' person--done';
      else if (person && person.answered > 0) cls += ' person--partial';
      else if (claimed) cls += ' person--claimed';
      if (chip.className !== cls) chip.className = cls;
      const score = person ? String(person.score) : '';
      if (chip.lastChild.textContent !== score) chip.lastChild.textContent = score;
      const rosterName = derived.rosterNames.get(id) ?? '';
      chip.title = person
        ? `${person.name || rosterName || id} — ${person.answered}/${cfg.INDIVIDUAL_PROBLEMS} `
          + `answered, ${person.score} pts`
          + (person.disqualified ? ` · disqualified: ${person.dqReason || 'no reason recorded'}` : '')
        : (claimed ? `${claimed.grader_name} is entering this`
          : `${rosterName ? `${rosterName} — ` : ''}not entered`);
    }
  }
}

function renderProgress() {
  const teams = [...new Set([
    ...data.teams.map((t) => String(t.team)),
    ...data.contestants.map((c) => String(c.team)),
  ])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const shape = progressSignature();
  if (shape !== progressShape) {
    progressShape = shape;
    buildProgress(teams);
  }
  paintProgress(teams);
}

// ---------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------

function table(headers, rows) {
  const wrap = el('div', 'table-wrap');
  const t = el('table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of headers) hr.appendChild(el('th', h.num ? 'num' : null, h.label ?? h));
  thead.appendChild(hr);
  t.appendChild(thead);
  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const cell of row) {
      const td = el('td', cell.cls ?? null);
      if (cell.node) td.appendChild(cell.node); else td.textContent = cell.text ?? cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  wrap.appendChild(t);
  return wrap;
}
const rankCls = (place) => `rank${place <= 3 ? ` rank--${place}` : ''}`;

// Whether the awards list carries its place numbers. A view preference,
// so it lives in this browser and never in the contest.
let awardPlaces = (() => {
  try { return localStorage.getItem('contest-award-places') === 'on'; } catch { return false; }
})();

/**
 * Ten at a time, with arrows. A hundred rows of a leaderboard is not
 * something anyone reads; the top ten is, and the rest is there when
 * somebody asks about a particular team.
 */
function pager(division, total) {
  const size = cfg.LEADERBOARD_PAGE;
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(boardPage[division], pages - 1);
  boardPage[division] = page;

  // Nothing to page through: a row of dead arrows under a six-row table
  // is just furniture.
  if (pages < 2) return { bar: null, page: 0, size };

  const bar = el('div', 'pager');
  const back = el('button', 'btn btn--ghost', '←');
  const next = el('button', 'btn btn--ghost', '→');
  back.type = 'button';
  next.type = 'button';
  back.disabled = page === 0;
  next.disabled = page >= pages - 1;
  back.setAttribute('aria-label', `Previous ten in Division ${division}`);
  next.setAttribute('aria-label', `Next ten in Division ${division}`);
  back.addEventListener('click', () => { boardPage[division] -= 1; renderBoards(); });
  next.addEventListener('click', () => { boardPage[division] += 1; renderBoards(); });

  const from = total ? page * size + 1 : 0;
  const to = Math.min(total, (page + 1) * size);
  bar.append(back, el('span', 'pager__where', total ? `${from}–${to} of ${total}` : 'none'), next);
  return { bar, page, size };
}

/**
 * Copy one contestant's award line. The all-ten button below gives you
 * the whole list; this is for reading names out one at a time.
 */
function rowCopyButton(person) {
  const btn = el('button', 'rowcopy', 'Copy');
  btn.type = 'button';
  btn.title = `Copy ${person.individualId}'s ID, name and score`;
  btn.addEventListener('click', () => {
    copyText(awardLine(person), `Copied ${person.individualId}.`);
  });
  return btn;
}

/** Put text on the clipboard, with the old-browser fallback. */
async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(done); } catch { toast('Could not copy.', 'error'); }
    ta.remove();
  }
}

/** One award line per contestant, copied straight onto a slide. */
function copyButton(rows) {
  const btn = el('button', 'btn btn--ghost', 'Copy for slides');
  btn.type = 'button';
  btn.addEventListener('click', () => {
    // Confirm with a toast, not by relabelling the button: a background
    // render rebuilds this button and would wipe the confirmation.
    copyText(rows.map((r) => r.text).join('\n\n'), `Copied ${rows.length} for slides.`);
  });
  return btn;
}

function renderBoards() {
  const host = $('#boards');
  host.replaceChildren();

  const note = el('p', 'field__hint');
  note.style.marginBottom = '14px';
  if (activeBoard === 'combined') {
    const mult = individualMultiplier(cfg);
    note.textContent = `Combined = the team's individual total × ${mult}, plus its guts score. `
      + 'The individual total is the best three of four members. A perfect team scores '
      + cfg.DIVISIONS.map((d) => `${combinedMaxPoints(derived.key, cfg, d)} in ${d}`).join(' and ')
      + ` — ${individualMaxPoints(derived.key, cfg, 'A') * mult} from the individual round `
      + `and ${gutsMaxPoints(derived.key, cfg)} from guts.`;
  } else if (activeBoard === 'individual') {
    note.textContent = `One row per contestant, out of ${cfg.INDIVIDUAL_PROBLEMS}.`;
  } else {
    note.textContent = 'Team guts scores, with points rising by set.';
  }
  host.appendChild(note);

  // A team with no division appears in neither table. That is easy to
  // miss at the end of a contest, so say it rather than let the team
  // quietly go missing from the results.
  const orphans = splitByDivision(
    activeBoard === 'individual' ? derived.individuals
      : activeBoard === 'guts' ? derived.guts : derived.combined,
  ).unassigned;
  if (orphans.length) {
    const warn = el('div', 'banner banner--warn');
    const d = el('div');
    const who = activeBoard === 'individual' ? 'contestant' : 'team';
    d.append(
      el('b', null, orphans.length === 1
        ? `One ${who} has no division and is not ranked below`
        : `${orphans.length} ${who}s have no division and are not ranked below`),
      el('span', null, activeBoard === 'individual'
        ? 'Open each one and pick a division, then save.'
        : `Team${orphans.length === 1 ? '' : 's'} `
          + `${orphans.slice(0, 8).map((r) => r.team).join(', ')}`
          + `${orphans.length > 8 ? '…' : ''} — set a division from the Guts tab.`),
    );
    warn.append(el('div', null, '⚠'), d);
    host.appendChild(warn);
  }

  for (const division of ['A', 'B']) {
    const heading = el('h3', null, `Division ${division}`);
    heading.style.cssText = 'font-size:13px;text-transform:uppercase;letter-spacing:.07em;margin:18px 0 9px';
    host.appendChild(heading);

    const source = activeBoard === 'combined' ? derived.combined
      : activeBoard === 'individual' ? derived.individuals : derived.guts;
    const all = splitByDivision(source)[division];
    const ranked = all.filter((r) => !r.disqualified);
    const out = all.filter((r) => r.disqualified);

    if (!ranked.length && !out.length) { host.appendChild(el('div', 'empty', 'Nothing here yet.')); continue; }

    const { bar, page, size } = pager(division, ranked.length);
    const shown = ranked.slice(page * size, (page + 1) * size);
    const offset = page * size;
    // Worked out across the division rather than down the page, so the
    // eleventh row is eleventh and a tie keeps its shared place.
    const places = competitionRanks(ranked,
      activeBoard === 'combined' ? (r) => r.total : (r) => r.score);

    if (activeBoard === 'combined') {
      const cell = (r) => {
        const n = el('span', 'mono', String(r.total));
        n.title = `${r.individual} × ${r.multiplier} = ${r.individual * r.multiplier}\n`
          + `+ ${r.guts ?? 0} from guts\n= ${r.total} out of ${r.max}`;
        return n;
      };
      const row = (r, place) => [
        { text: place == null ? 'DQ' : String(place),
          cls: place == null ? 'rank' : rankCls(place) },
        { text: r.name ? `${r.team} · ${r.name}` : `Team ${r.team}` },
        { text: String(r.individual), cls: 'num' },
        { text: r.guts == null ? '—' : String(r.guts), cls: 'num' },
        { node: cell(r), cls: 'num' },
        { text: `${r.entered} entered`, cls: 'muted' },
      ];
      const header = ['#', 'Team', { label: 'Individual', num: true }, { label: 'Guts', num: true },
        { label: 'Combined', num: true }, 'Sheets'];
      if (shown.length) host.appendChild(table(header, shown.map((r, i) => row(r, places[offset + i]))));
      if (bar) host.appendChild(bar);
      if (out.length) {
        const w = table(header, out.map((r) => row(r, null)));
        w.classList.add('table-wrap--dq');
        host.appendChild(w);
      }
    } else if (activeBoard === 'individual') {
      const row = (r, place) => [
        { text: place == null ? 'DQ' : String(place),
          cls: place == null ? 'rank' : rankCls(place) },
        { text: r.individualId },
        { text: r.name || '—' },
        { text: String(r.correct), cls: 'num' },
        { text: String(r.score), cls: 'num' },
        { text: `${r.answered}/${cfg.INDIVIDUAL_PROBLEMS}`, cls: 'muted' },
        { node: rowCopyButton(r) },
      ];
      const header = ['#', 'ID', 'Name', { label: 'Correct', num: true },
        { label: 'Points', num: true }, 'Answered', ''];
      if (shown.length) host.appendChild(table(header, shown.map((r, i) => row(r, places[offset + i]))));
      if (bar) host.appendChild(bar);
      if (page === 0 && shown.length) {
        const copyRow = el('div', 'chip-row');
        copyRow.style.marginTop = '8px';
        const toggle = el('label', 'muted');
        toggle.style.cssText = 'display:inline-flex;align-items:center;gap:6px;cursor:pointer';
        const box = el('input');
        box.type = 'checkbox';
        box.checked = awardPlaces;
        box.addEventListener('change', () => {
          awardPlaces = box.checked;
          try { localStorage.setItem('contest-award-places', awardPlaces ? 'on' : 'off'); }
          catch { /* a browser with storage turned off still gets the toggle */ }
          renderBoards();
        });
        toggle.append(box, document.createTextNode('with places'));
        copyRow.append(
          copyButton(awardLines(derived.individuals, division, cfg.LEADERBOARD_PAGE,
            { withPlaces: awardPlaces })),
          toggle,
          el('span', 'muted', awardPlaces
            ? 'place, ID, name and score for the top ten — tied scores share a place'
            : 'ID, name and score for the top ten, ready to paste'));
        host.appendChild(copyRow);
      }
      if (out.length) {
        const w = table(header, out.map((r) => row(r, null)));
        w.classList.add('table-wrap--dq');
        host.appendChild(w);
      }
    } else {
      const row = (r, place) => [
        { text: place == null ? 'DQ' : String(place),
          cls: place == null ? 'rank' : rankCls(place) },
        { text: r.name ? `${r.team} · ${r.name}` : `Team ${r.team}` },
        { text: String(r.correct), cls: 'num' },
        { text: String(r.score), cls: 'num' },
        { text: `${r.perSet.filter((s) => s.complete).length}/${cfg.GUTS_SETS}`, cls: 'muted' },
      ];
      const header = ['#', 'Team', { label: 'Correct', num: true },
        { label: 'Points', num: true }, 'Sets'];
      if (shown.length) host.appendChild(table(header, shown.map((r, i) => row(r, places[offset + i]))));
      if (bar) host.appendChild(bar);
      if (out.length) {
        const w = table(header, out.map((r) => row(r, null)));
        w.classList.add('table-wrap--dq');
        host.appendChild(w);
      }
    }
  }
}

// ---------------------------------------------------------------------
// Answer key
// ---------------------------------------------------------------------

const keyIndividualInputs = {};     // division -> inputs
let keyGutsInputs = [];
let keyPointInputs = [];
let activeKeyDivision = 'A';
let keyDirty = false;
let keyLoadedSignature = null;

function markKeyDirty() { keyDirty = true; }

function settleKey() {
  keyDirty = false;
  keyLoadedSignature = null;   // force one reload from what was just saved
}

function buildKeyEditor() {
  $('#tab-key').addEventListener('input', markKeyDirty);
  for (const division of cfg.DIVISIONS) {
    keyIndividualInputs[division] = buildAnswerGrid(
      $(`#keyIndividual${division}`), cfg.INDIVIDUAL_PROBLEMS);
  }

  const host = $('#keyGuts');
  host.replaceChildren();
  keyGutsInputs = [];
  keyPointInputs = [];
  for (let set = 1; set <= cfg.GUTS_SETS; set += 1) {
    const box = el('div', 'keyset');
    const head = el('div', 'keyset__head');
    const problems = problemsInSet(set, cfg);
    head.append(el('b', null, `Set ${set}`),
      el('span', 'muted', `problems ${problems[0]}–${problems[problems.length - 1]}`));
    const pointsWrap = el('div', 'keyset__points');
    const points = el('input', 'input');
    points.type = 'number';
    points.min = '0';
    points.step = '1';
    points.setAttribute('aria-label', `Points per problem in set ${set}`);
    pointsWrap.append(el('span', null, 'points each'), points);
    head.appendChild(pointsWrap);
    box.appendChild(head);
    keyPointInputs.push(points);

    const grid = el('div', 'answers answers--guts');
    box.appendChild(grid);
    keyGutsInputs.push(...buildAnswerGrid(grid, cfg.GUTS_PER_SET,
      { offset: problems[0] - 1, columns: cfg.GUTS_PER_SET }));
    host.appendChild(box);
  }
}

/**
 * A signature of the key as saved. When it changes, somebody else edited
 * the key and the editor should show the new one; when it has not, a
 * render must leave the boxes completely alone.
 */
function savedKeySignature() {
  return data.key
    .map((r) => `${r.round}${r.division ?? '*'}${r.problem}=${r.answer ?? ''}:${r.points}`)
    .sort()
    .join('|');
}

function fillKeyEditor() {
  // The status line always reflects the saved key.
  const perDivision = cfg.DIVISIONS.map((d) => derived.keyGapsIndividual[d].length);
  const gaps = perDivision.reduce((a, b) => a + b, 0) + derived.keyGapsGuts.length;
  $('#keyState').textContent = gaps ? `${gaps} unset` : 'complete';
  $('#keyState').className = gaps ? 'tag tag--flag' : 'tag tag--live';
  $('#keyDivState').textContent = cfg.DIVISIONS
    .map((d, i) => `${d}: ${perDivision[i] ? `${perDivision[i]} unset` : 'complete'}`)
    .join(' · ');

  // Never overwrite unsaved edits. Focus is not enough of a guard: you
  // lose focus every time you click the other division's tab, or pause,
  // and any other scorer saving a sheet fires a render. Keep the boxes
  // until the saved key actually changes underneath them.
  const signature = savedKeySignature();
  if (keyDirty || signature === keyLoadedSignature) return;
  keyLoadedSignature = signature;

  for (const division of cfg.DIVISIONS) {
    const table = individualKey(derived.key, division);
    for (let p = 1; p <= cfg.INDIVIDUAL_PROBLEMS; p += 1) {
      const input = keyIndividualInputs[division][p - 1];
      const value = table.get(p)?.answer;
      input.value = value == null ? '' : String(value);
      input.dispatchEvent(new Event('input'));
    }
  }
  for (let p = 1; p <= GUTS_N; p += 1) {
    const input = keyGutsInputs[p - 1];
    const value = derived.key.guts.get(p)?.answer;
    input.value = value == null ? '' : String(value);
    input.dispatchEvent(new Event('input'));
  }
  for (let set = 1; set <= cfg.GUTS_SETS; set += 1) {
    keyPointInputs[set - 1].value = derived.key.guts.get(problemsInSet(set, cfg)[0])?.points ?? 1;
  }
}

/**
 * Read the whole key out of the editor. `blank: true` returns the same
 * rows with every answer emptied — that is what clearing writes, so the
 * two paths can never disagree about the key's shape.
 * Returns null (after a toast) if anything typed is not a whole number.
 */
function buildKeyRows({ blank = false } = {}) {
  const rows = [];
  for (const division of cfg.DIVISIONS) {
    for (let p = 1; p <= cfg.INDIVIDUAL_PROBLEMS; p += 1) {
      let answer = null;
      if (!blank) {
        const parsed = parseAnswer(keyIndividualInputs[division][p - 1].value);
        if (!parsed.ok) {
          toast(`Division ${division} problem ${p}: whole numbers only.`, 'error');
          return null;
        }
        answer = parsed.value;
      }
      rows.push({
        round: 'individual', division, problem: p, answer, points: cfg.INDIVIDUAL_POINTS,
      });
    }
  }
  for (let set = 1; set <= cfg.GUTS_SETS; set += 1) {
    // Point values are contest configuration, not answers, so a clear keeps them.
    const points = Number(keyPointInputs[set - 1].value);
    if (!Number.isFinite(points) || points < 0) {
      toast(`Set ${set}: points must be zero or more.`, 'error');
      return null;
    }
    for (const p of problemsInSet(set, cfg)) {
      let answer = null;
      if (!blank) {
        const parsed = parseAnswer(keyGutsInputs[p - 1].value);
        if (!parsed.ok) { toast(`Guts problem ${p}: whole numbers only.`, 'error'); return null; }
        answer = parsed.value;
      }
      rows.push({ round: 'guts', division: GUTS_DIVISION, problem: p, answer, points });
    }
  }
  return rows;
}

async function saveKey() {
  const rows = buildKeyRows();
  if (!rows) return;
  try {
    await store.saveKey(rows);
    settleKey();
    await refresh();
    toast('Answer key saved. Every score just recalculated.');
  } catch (err) {
    toast(err.message || 'Could not save the key.', 'error');
  }
}

// ---------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------

function renderClock() {
  const state = data.state;
  const remaining = gutsRemaining(state);
  const text = formatClock(remaining);
  $('#clockTime').textContent = text;
  $('#clockBig').textContent = text;

  // Only one of Start and Pause ever applies. Greying the other out means
  // there is nothing to fumble over while a room is watching.
  const running = Boolean(state?.guts_running);
  $('#clockStart').disabled = running;
  $('#clockPause').disabled = !running;

  const chip = $('#clockChip');
  chip.className = 'clockchip';
  if (state?.guts_frozen) chip.classList.add('clockchip--frozen');
  else if (!state?.guts_running) chip.classList.add('clockchip--stopped');

  const host = $('#freezeState');
  host.replaceChildren();
  const frozen = Boolean(state?.guts_frozen);
  const b = el('div', `banner ${frozen ? 'banner--warn' : 'banner--ok'}`);
  const d = el('div');
  d.append(
    el('b', null, frozen ? 'The public board is frozen' : 'The public board is live'),
    el('span', null, frozen
      ? 'It is showing the standings from the moment it froze. Unfreeze to reveal the rest.'
      : `It will freeze itself with ${state?.freeze_minutes ?? cfg.FREEZE_MINUTES} minutes left.`),
  );
  b.appendChild(d);
  host.appendChild(b);
  $('#freezeToggle').textContent = frozen ? 'Unfreeze and reveal' : 'Freeze now';
  $('#freezeToggle').className = frozen ? 'btn btn--go' : 'btn btn--warn';

  // Auto-freeze at the threshold. The portal is the thing that is always
  // open on contest day, so it is what closes the board.
  if (!frozen && !freezing && shouldFreeze(state)) {
    freezing = true;
    store.setFrozen(true)
      .then(refresh)
      .catch(() => {})
      .finally(() => { freezing = false; });
  }
}

function startClockTicker() {
  clearInterval(clockTimer);
  clockTimer = setInterval(renderClock, 1000);
}

async function clockAction(action) {
  const state = data.state ?? {};
  const remaining = gutsRemaining(state);
  const patch = {};
  if (action === 'start') {
    patch.guts_running = true;
    patch.guts_ends_at = new Date(Date.now() + remaining * 1000).toISOString();
  } else if (action === 'pause') {
    patch.guts_running = false;
    patch.guts_remaining = remaining;
    patch.guts_ends_at = null;
  } else if (action === 'reset') {
    patch.guts_running = false;
    patch.guts_remaining = Number(state.guts_duration ?? cfg.GUTS_DURATION);
    patch.guts_ends_at = null;
  } else {
    const delta = action === 'plus' ? 60 : -60;
    const next = Math.max(0, remaining + delta);
    if (state.guts_running) patch.guts_ends_at = new Date(Date.now() + next * 1000).toISOString();
    else patch.guts_remaining = next;
  }
  try {
    await store.saveState(patch);
    await refresh();
  } catch (err) {
    toast(err.message || 'Could not change the clock.', 'error');
  }
}

// ---------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------

function renderWeightPreview() {
  const mult = Number($('#individualMultiplier').value);
  const host = $('#weightPreview');
  host.replaceChildren();
  const d = el('div');
  if (!Number.isFinite(mult) || mult < 0) {
    host.className = 'banner banner--error';
    d.append(el('b', null, 'That multiplier is not a number'),
      el('span', null, 'Use zero or more — three is the contest default.'));
  } else {
    const ind = individualMaxPoints(derived.key, cfg, 'A') * mult;
    const guts = gutsMaxPoints(derived.key, cfg);
    host.className = 'banner banner--info';
    d.append(el('b', null, `A perfect team scores ${ind + guts}: ${ind} from the individual `
      + `round and ${guts} from guts.`),
      el('span', null, 'The individual total is the best three of four members, counted '
        + `${mult} time${mult === 1 ? '' : 's'}. Raw points — nothing is scaled.`));
  }
  host.appendChild(d);
}

// The last name we ourselves wrote to the register. Anything different
// showing up there was written by somebody else — an admin correcting it.
let lastPushedName = null;

function pushHeartbeat() {
  lastPushedName = grader.name;
  return store.heartbeat(grader).catch(() => {});
}

/**
 * An admin correcting a name in the Scorers panel has to reach the person
 * it belongs to. Without this their next heartbeat, twenty seconds later,
 * would write the old name straight back over the correction.
 */
function adoptRename() {
  const mine = data.graders.find((g) => g.grader_id === grader.id);
  if (!mine?.name || mine.name === grader.name || mine.name === lastPushedName) return;
  grader.name = mine.name;
  localStorage.setItem('contest-grader-name', grader.name);
  $('#whoamiName').textContent = grader.name;
  toast(`A director corrected your name to ${grader.name}.`, 'info');
}

/**
 * The scorer register. Rebuilt only when the register itself changes, so
 * a name being typed into one of these boxes is never wiped by somebody
 * else's save landing in the background.
 */
let graderRowsSignature = null;

function renderGraders() {
  const host = $('#graderList');
  const rows = graderActivity(data.graders, data.contestants, data.gutsAnswers, cfg);
  const signature = rows.map((r) => `${r.graderId}|${r.name}|${r.online}|${r.sheets}|${r.sets}`)
    .join(',');
  const gone = rows.filter((r) => !r.online).length;
  $('#graderState').textContent = rows.length
    ? `${rows.length - gone} here, ${gone} gone.`
    : '';
  if (signature === graderRowsSignature) return;
  graderRowsSignature = signature;
  host.replaceChildren();

  if (!rows.length) {
    host.appendChild(el('p', 'field__hint', 'Nobody has signed in yet.'));
    return;
  }

  for (const person of rows) {
    const row = el('div', `grader-row${person.online ? '' : ' grader-row--off'}`);
    const who = el('div', 'grader-row__who');
    who.append(el('span', 'grader-row__name', person.name || '(no name)'),
      el('span', 'grader-row__seen',
        person.online ? 'here now' : `last seen ${sinceLabel(person.idleMs)}`));

    const field = el('input', 'input');
    field.value = person.name;
    field.setAttribute('aria-label', `Name for ${person.name || person.graderId}`);
    field.addEventListener('input', () => { field.dataset.dirty = '1'; });

    const save = el('button', 'btn btn--ghost', 'Rename');
    save.type = 'button';
    save.addEventListener('click', async () => {
      const next = field.value.trim();
      if (!next) { toast('A scorer needs a name.', 'error'); return; }
      if (next === person.name) { toast('That is already their name.', 'info'); return; }
      save.disabled = true;
      try {
        await store.renameGrader(person.graderId, next);
        graderRowsSignature = null;
        await refresh();
        toast(`Renamed to ${next} on ${person.sheets} sheet(s) and ${person.sets} set(s).`);
      } catch (err) {
        save.disabled = false;
        toast(err.message || 'Could not rename that scorer.', 'error');
      }
    });

    const drop = el('button', 'btn btn--ghost', 'Remove');
    drop.type = 'button';
    drop.addEventListener('click', async () => {
      if (drop.dataset.armed !== '1') {
        drop.dataset.armed = '1';
        drop.textContent = 'Click again';
        setTimeout(() => { drop.dataset.armed = ''; drop.textContent = 'Remove'; }, 4000);
        return;
      }
      drop.disabled = true;
      try {
        await store.removeGrader(person.graderId);
        graderRowsSignature = null;
        await refresh();
        toast(`${person.name || 'That scorer'} removed. Their entries are untouched.`, 'info');
      } catch (err) {
        drop.disabled = false;
        toast(err.message || 'Could not remove that scorer.', 'error');
      }
    });

    row.append(who, field, save, drop,
      el('span', 'grader-row__did',
        `${person.sheets} sheet${person.sheets === 1 ? '' : 's'} · `
        + `${person.sets} set${person.sets === 1 ? '' : 's'}`));
    host.appendChild(row);
  }
}

/**
 * The participant list, editable a line at a time. Only rebuilt when the
 * list or the search changes, so a name being typed here is never wiped
 * by somebody else's save landing in the background.
 */
const ROSTER_SHOWN = 40;
let rosterShape = null;
const rosterFields = new Map();      // individual_id -> input

function renderRoster() {
  const host = $('#rosterList');
  const all = rosterRows(data.roster);
  const search = $('#rosterSearch').value;
  const shown = filterRoster(all, search).slice(0, ROSTER_SHOWN);

  $('#rosterState').textContent = all.length
    ? `${all.length} participant${all.length === 1 ? '' : 's'}`
    : 'none';

  // Rebuild only when the rows on screen change. A name being corrected
  // changes the data but not the shape, and rebuilding for that took the
  // cursor out from under whoever was typing the next one.
  const shape = `${search}|${all.length}|${shown.map((r) => r.individualId).join(',')}`;
  if (shape !== rosterShape) {
    rosterShape = shape;
    rosterFields.clear();
    host.replaceChildren();

    if (!all.length) {
      // Says which of the two it is: nothing imported yet, or the table
      // the schema adds is not in this database yet.
      if (data.missingTables?.includes('roster')) {
        const warn = el('div', 'banner banner--warn');
        const d = el('div');
        d.append(el('b', null, 'This database has no participant table yet'),
          el('span', null, 'Run supabase/schema.sql in the Supabase SQL Editor, then '
            + 'reload. Everything else on this page works without it.'));
        warn.append(el('div', null, '⚠'), d);
        host.appendChild(warn);
        return;
      }
      host.appendChild(el('p', 'field__hint',
        'Nobody loaded yet. Add one above, or import a list below.'));
      return;
    }
    if (!shown.length) {
      host.appendChild(el('p', 'field__hint', `Nobody matches “${search.trim()}”.`));
      return;
    }

    const list = el('div', 'roster-list');
    for (const person of shown) {
      const row = el('div', 'roster-row');
      const field = el('input', 'input');
      field.value = person.name;
      field.placeholder = 'no name';
      field.setAttribute('aria-label', `Name for ${person.individualId}`);
      rosterFields.set(person.individualId, field);

      const save = async () => {
        const next = field.value.trim();
        const current = rosterRows(data.roster)
          .find((r) => r.individualId === person.individualId);
        if (!current || next === current.name) return;
        try {
          const written = {
            individual_id: person.individualId,
            name: next,
            division: person.division,
            team: person.team,
          };
          await store.saveRoster([written]);
          applyWrite([['roster', written]]);
        } catch (err) {
          toast(err.message || 'Could not save that name.', 'error');
        }
      };
      // Saves when you leave the box or press Enter, so a list can be
      // corrected by tabbing straight down it.
      field.addEventListener('change', save);
      field.addEventListener('keydown', (e) => { if (e.key === 'Enter') field.blur(); });

      const drop = el('button', 'btn btn--ghost', 'Remove');
      drop.type = 'button';
      drop.addEventListener('click', async () => {
        drop.disabled = true;
        try {
          await store.removeRosterEntry(person.individualId);
          rosterShape = null;
          applyWrite([['roster', { individual_id: person.individualId }, 'DELETE']]);
          toast(`${person.individualId} removed from the participant list.`, 'info');
        } catch (err) {
          drop.disabled = false;
          toast(err.message || 'Could not remove that participant.', 'error');
        }
      });

      row.append(el('span', 'roster-row__id', person.individualId),
        el('span', 'roster-row__team', `team ${person.team}`), field, drop);
      list.appendChild(row);
    }
    host.appendChild(list);
    const matches = filterRoster(all, search).length;
    if (matches > ROSTER_SHOWN) {
      host.appendChild(el('p', 'roster-more',
        `Showing ${ROSTER_SHOWN} of ${matches}. Search to narrow it down.`));
    }
  }

  // Repaint: anybody else's correction lands here, but never on top of a
  // box somebody is currently typing in.
  for (const person of shown) {
    const field = rosterFields.get(person.individualId);
    if (field && field !== document.activeElement && field.value !== person.name) {
      field.value = person.name;
    }
  }
}

/** Say how many names each list holds, and that empty means everybody. */
function renderStaffCounts() {
  for (const [which, label] of [['admin', 'admin'], ['grader', 'staff']]) {
    const names = parseNameList($(`#${which}Names`).value);
    $(`#${which}NamesCount`).textContent = names.length
      ? `${names.length} name${names.length === 1 ? '' : 's'} — only these may sign in.`
      : `Empty: anyone with the ${label} password.`;
  }
}

function renderDqList() {
  const host = $('#dqList');
  host.replaceChildren();

  const people = data.contestants.filter((c) => c.disqualified)
    .sort((a, b) => a.individual_id.localeCompare(b.individual_id, undefined, { numeric: true }));
  const out = data.teams.filter((t) => t.disqualified)
    .sort((a, b) => String(a.team).localeCompare(String(b.team), undefined, { numeric: true }));
  if (!out.length && !people.length) {
    host.appendChild(el('p', 'field__hint', 'Nobody is disqualified.'));
    return;
  }

  for (const person of people) {
    const row = el('div', 'dq-row');
    const info = el('div');
    info.append(el('b', null, `${person.individual_id}${person.name ? ` · ${person.name}` : ''}`),
      el('span', 'muted', `contestant only — ${person.dq_reason || 'no reason recorded'}`));
    const undo = el('button', 'btn btn--ghost', 'Reinstate');
    undo.type = 'button';
    undo.addEventListener('click', async () => {
      undo.disabled = true;
      try {
        await store.setContestant(person.individual_id,
          { disqualified: false, dq_reason: '', dq_by: '', dq_at: null });
        await refresh();
        toast(`${person.individual_id} is back in the results.`);
      } catch (err) {
        undo.disabled = false;
        toast(err.message || 'Could not reinstate that contestant.', 'error');
      }
    });
    row.append(info, undo);
    host.appendChild(row);
  }

  for (const team of out) {
    const row = el('div', 'dq-row');
    const info = el('div');
    info.append(el('b', null, `Team ${team.team}${team.name ? ` · ${team.name}` : ''}`),
      el('span', 'muted', team.dq_reason || 'no reason recorded'));
    const undo = el('button', 'btn btn--ghost', 'Reinstate');
    undo.type = 'button';
    undo.addEventListener('click', async () => {
      undo.disabled = true;
      try {
        await store.setTeam(team.team, { disqualified: false, dq_reason: '', dq_by: '', dq_at: null });
        await refresh();
        toast(`Team ${team.team} is back in the standings.`);
      } catch (err) { toast(err.message || 'Could not reinstate.', 'error'); undo.disabled = false; }
    });
    row.append(info, undo);
    host.appendChild(row);
  }
}

/**
 * Rank inside each division, not across both. The divisions are separate
 * contests — a single global rank column would have read as a combined
 * placing that nobody is actually competing for.
 */
function rankedByDivision(rows, valueOf = (r) => r.score) {
  const out = [];
  for (const division of [...cfg.DIVISIONS, null]) {
    const group = division === null
      ? rows.filter((r) => r.division !== 'A' && r.division !== 'B')
      : rows.filter((r) => r.division === division);
    const ranked = group.filter((r) => !r.disqualified);
    const places = competitionRanks(ranked, valueOf);
    const place = new Map(ranked.map((r, i) => [r, places[i]]));
    for (const row of group) {
      out.push([row, row.disqualified ? 'DQ' : String(place.get(row))]);
    }
  }
  return out;
}

function exportIndividualCsv() {
  const rows = rankedByDivision(derived.individuals).map(([r, rank]) => [
    rank, r.division ?? '', r.individualId, r.team, r.member, r.name,
    r.correct, r.score, r.answered, r.enteredBy, r.disqualified ? 'yes' : 'no',
    ...r.marks.map((m) => m[0].toUpperCase()),
  ]);
  downloadCsv('cowconuts-2026-individual.csv', toCsv(
    ['rank_in_division', 'division', 'individual_id', 'team', 'member', 'name', 'correct',
      'points', 'answered', 'entered_by', 'disqualified',
      ...Array.from({ length: cfg.INDIVIDUAL_PROBLEMS }, (_, i) => `q${i + 1}`)],
    rows));
}

function exportGutsCsv() {
  const rows = rankedByDivision(derived.guts).map(([r, rank]) => [
    rank, r.division ?? '', r.team, r.name, r.correct, r.score,
    r.disqualified ? 'yes' : 'no', ...r.perSet.map((s) => s.score),
  ]);
  downloadCsv('cowconuts-2026-guts.csv', toCsv(
    ['rank_in_division', 'division', 'team', 'team_name', 'correct', 'points', 'disqualified',
      ...Array.from({ length: cfg.GUTS_SETS }, (_, i) => `set${i + 1}`)],
    rows));
}

/**
 * Everything a problem-setting committee asks for afterwards: how each
 * problem behaved, how the cohort scored, and the shape of the spread.
 */
function exportStatsCsv() {
  const rows = [];
  for (const division of cfg.DIVISIONS) {
    const st = divisionStatistics(derived.individuals, derived.guts, division, cfg, derived.key);
    const round = (v) => Number(v).toFixed(3).replace(/\.?0+$/, '');
    rows.push(['DIVISION', division, '', '', '', '']);
    rows.push(['summary', 'contestants', st.contestants.n, '', '', '']);
    for (const [label, v] of [['mean', st.contestants.mean], ['median', st.contestants.median],
      ['stdev', st.contestants.stdev], ['min', st.contestants.min], ['max', st.contestants.max],
      ['q1', st.contestants.q1], ['q3', st.contestants.q3]]) {
      rows.push(['summary', `individual ${label}`, round(v), '', '', '']);
    }
    for (const [label, v] of [['n', st.guts.n], ['mean', st.guts.mean],
      ['median', st.guts.median], ['stdev', st.guts.stdev],
      ['min', st.guts.min], ['max', st.guts.max]]) {
      rows.push(['summary', `guts ${label}`, round(v), '', '', '']);
    }
    if (st.mostSolved) {
      rows.push(['extreme', 'most solved',
        `problem ${st.mostSolved.problem}`, st.mostSolved.correct,
        `${round(st.mostSolved.pctCorrect)}%`, '']);
    }
    if (st.fewestSolved) {
      rows.push(['extreme', 'fewest solved',
        `problem ${st.fewestSolved.problem}`, st.fewestSolved.correct,
        `${round(st.fewestSolved.pctCorrect)}%`, '']);
    }
    rows.push(['', '', '', '', '', '']);
    rows.push(['problem', 'number', 'correct', 'answered', 'blank', 'percent correct']);
    for (const pr of st.problems) {
      rows.push(['problem', pr.problem, pr.correct, pr.answered, pr.blank,
        round(pr.pctCorrect)]);
    }
    rows.push(['', '', '', '', '', '']);
    rows.push(['distribution', 'score', 'contestants', '', '', '']);
    for (const bucket of st.distribution) {
      rows.push(['distribution', bucket.score, bucket.count, '', '', '']);
    }
    rows.push(['', '', '', '', '', '']);
  }
  downloadCsv('cowconuts-2026-statistics.csv', toCsv(
    ['section', 'label', 'value', 'a', 'b', 'c'], rows));
}

function exportCombinedCsv() {
  const rows = [];
  // Combined teams are placed on their combined total, and tied teams
  // share a place, exactly as the board on screen shows them.
  for (const [r, place] of rankedByDivision(derived.combined, (t) => t.total)) {
    rows.push([place, r.division ?? '', r.team, r.name,
      r.individual, r.indMax, r.multiplier,
      r.guts ?? '', r.gutsMax,
      r.total, r.max, r.disqualified ? 'yes' : 'no',
      r.members.map((m) => `${m.individualId}:${m.score}`).join(' ')]);
  }
  downloadCsv('cowconuts-2026-combined.csv', toCsv(
    ['rank_in_division', 'division', 'team', 'team_name', 'individual_total', 'individual_max',
      'multiplier', 'guts_total', 'guts_max', 'combined', 'combined_max', 'disqualified',
      'member_breakdown'],
    rows));
}

// ---------------------------------------------------------------------
// Render / refresh
// ---------------------------------------------------------------------

/** Reflect who is signed in: graders read the key, admins edit it. */
function applyRole() {
  $('#adminLocked').classList.toggle('hidden', isAdmin);
  $('#adminBody').classList.toggle('hidden', !isAdmin);
  $('#keyActions').classList.toggle('hidden', !isAdmin);
  $('#keyReadOnly').classList.toggle('hidden', isAdmin);
  for (const input of $$('#tab-key input')) input.readOnly = !isAdmin;
  const badge = $('#roleBadge');
  if (badge) {
    badge.textContent = isAdmin ? 'admin' : 'scorer';
    badge.className = `tag ${isAdmin ? 'tag--flag' : 'tag--off'}`;
  }
}

function render() {
  recompute();
  renderSuggestions();
  if (activeTab === 'progress') renderProgress();
  if (activeTab === 'leaderboard') renderBoards();
  if (activeTab === 'key') fillKeyEditor();
  renderClock();
  renderWeightPreview();
  adoptRename();
  renderGraders();
  renderRoster();
  renderDqList();
  applyRole();

  if (entryMode === 'individual') { markSheetAgainstKey(); refreshIndividualContext(); }
  else refreshGutsContext();

  const online = data.graders.filter(
    (g) => Date.now() - new Date(g.last_seen).getTime() < cfg.CLAIM_TTL_MS);
  $('#onlineCount').textContent = String(Math.max(online.length, 1));

  $('#wipeCounts').textContent = data.contestants.length || data.gutsAnswers.length
    ? `${data.contestants.length} sheets · ${data.gutsAnswers.length} guts answers · `
      + `${data.teams.length} teams · ${data.claims.length} open locks`
    : 'Nothing to delete.';

  // Same rule as the answer key: an edit you have not saved yet survives
  // a background render, however long you leave it sitting there.
  for (const [id, value] of [
    ['#teamCount', cfg.TEAM_COUNT],
    ['#individualMultiplier', individualMultiplier(cfg)],
    ['#adminNames', data.settings?.admin_names ?? ''],
    ['#graderNames', data.settings?.grader_names ?? ''],
    ['#durationMinutes', Math.round((data.state?.guts_duration ?? cfg.GUTS_DURATION) / 60)],
    ['#freezeMinutes', data.state?.freeze_minutes ?? cfg.FREEZE_MINUTES],
  ]) {
    const input = $(id);
    if (input && !input.dataset.dirty && input !== document.activeElement) {
      input.value = value;
    }
  }
  // After the boxes are filled, never before: these counts read them.
  renderStaffCounts();
}

/**
 * After a write, fold the row we just sent into the cached snapshot and
 * repaint — instead of `refresh()`, which pulls all eight tables back
 * down. At a hundred teams that is ten round trips and the whole contest
 * after every saved sheet, which is what made the portal feel slow.
 */
function applyWrite(patches) {
  for (const [table, row, eventType] of patches) {
    data = store.patchLocal(table, row, eventType ?? 'UPDATE');
  }
  render();
}

async function refresh() {
  try {
    data = await store.load();
    connected = true;
  } catch (err) {
    connected = false;
    toast(err.message || 'Lost the connection.', 'error');
  }
  updateBadge();
  render();
}

function updateBadge() {
  const dot = $('#connDot');
  const label = $('#connLabel');
  dot.className = 'dot';
  if (store.mode === 'demo') { dot.classList.add('dot--demo'); label.textContent = 'demo mode'; }
  else if (connected) { dot.classList.add('dot--live'); label.textContent = 'live'; }
  else { dot.classList.add('dot--down'); label.textContent = 'offline'; }
}

// ---------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------

function setEntryMode(mode) {
  entryMode = mode;
  releaseHeld();
  for (const tab of $$('.tab[data-entry]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.entry === mode));
  }
  $('#entry-individual').classList.toggle('hidden', mode !== 'individual');
  $('#entry-guts').classList.toggle('hidden', mode !== 'guts');
  render();
}

function wire() {
  $('#progressPanel').addEventListener('click', (e) => {
    const chip = e.target.closest('.person');
    if (!chip) return;
    setEntryMode('individual');
    $('#individualId').value = chip.dataset.id;
    onIdTyped();
  });

  for (const tab of $$('.tab[data-entry]')) {
    tab.addEventListener('click', () => setEntryMode(tab.dataset.entry));
  }
  for (const tab of $$('.tab[data-tab]')) {
    tab.addEventListener('click', () => {
      activeTab = tab.dataset.tab;
      for (const t of $$('.tab[data-tab]')) t.setAttribute('aria-selected', String(t === tab));
      for (const id of ['progress', 'leaderboard', 'key', 'run', 'setup']) {
        $(`#tab-${id}`).classList.toggle('hidden', id !== activeTab);
      }
      render();
    });
  }
  for (const btn of $$('.tab[data-board]')) {
    btn.addEventListener('click', () => {
      activeBoard = btn.dataset.board;
      boardPage.A = 0;
      boardPage.B = 0;
      for (const b of $$('.tab[data-board]')) b.setAttribute('aria-selected', String(b === btn));
      renderBoards();
    });
  }

  sheetInputs = buildAnswerGrid($('#answerGrid'), cfg.INDIVIDUAL_PROBLEMS,
    { onChange: () => markSheetAgainstKey(), onLast: () => $('#saveSheet').focus() });

  const setSelect = $('#gutsSet');
  for (let set = 1; set <= cfg.GUTS_SETS; set += 1) {
    setSelect.appendChild(new Option(`Set ${set}`, String(set)));
  }
  gutsInputs = buildAnswerGrid($('#gutsGrid'), cfg.GUTS_PER_SET,
    { columns: cfg.GUTS_PER_SET, onLast: () => $('#saveGuts').focus() });

  $('#individualId').addEventListener('input', onIdTyped);
  for (const id of ['#teamNo', '#memberLetter']) {
    $(id).addEventListener('input', () => {
      syncIdFromFields();
      if (currentIndividualId()) { loadExistingSheet(); claimCurrent(); }
      refreshIndividualContext();
    });
  }
  // Division is part of the ID and decides which paper the sheet is
  // marked against, so changing it rebuilds both.
  $('#divisionPick').addEventListener('change', () => {
    syncIdFromFields();
    loadExistingSheet({ keepUnsaved: true });
    claimCurrent();
    markSheetAgainstKey();
    refreshIndividualContext();
  });
  $('#saveSheet').addEventListener('click', saveSheet);
  $('#clearSheet').addEventListener('click', () => clearSheet());

  $('#gutsTeam').addEventListener('input', () => {
    resetGutsTeamFields();
    refreshGutsContext({ picked: true });
    claimCurrent();
  });
  // Division is half of the team key, so changing it selects a different
  // team entirely. Without this the previous team's answers stayed in the
  // boxes and Save filed them under the other division's team.
  $('#gutsDivision').addEventListener('change', () => {
    resetGutsTeamFields();
    refreshGutsContext({ keepUnsaved: true, picked: true });
    claimCurrent();
  });
  $('#gutsSet').addEventListener('change',
    () => { refreshGutsContext({ picked: true }); claimCurrent(); });
  $('#gutsTeamName').addEventListener('input', () => { $('#gutsTeamName').dataset.dirty = '1'; });
  $('#saveGuts').addEventListener('click', saveGutsSet);
  $('#clearGuts').addEventListener('click', () => {
    gutsLoadedRef = null;
    fillGrid(gutsInputs, []);
  });

  document.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return;
    e.preventDefault();
    // Save whatever the cursor is actually in.
    if (document.activeElement?.closest('#tab-key')) saveKey();
    else if (entryMode === 'individual') saveSheet();
    else saveGutsSet();
  });

  buildKeyEditor();

  // Clearing the key rescores every sheet in the contest to zero, so it
  // takes two deliberate clicks rather than one stray one.
  let clearArmed = null;
  const disarmClear = () => {
    clearTimeout(clearArmed);
    clearArmed = null;
    $('#clearKey').textContent = 'Clear answer key';
    $('#clearKey').className = 'btn btn--danger';
    $('#clearKeyHint').textContent = '';
  };
  $('#clearKey').addEventListener('click', async () => {
    if (!clearArmed) {
      clearArmed = setTimeout(disarmClear, 5000);
      $('#clearKey').textContent = 'Click again to clear';
      $('#clearKey').className = 'btn btn--warn is-pressed';
      $('#clearKeyHint').textContent =
        'Every answer in both divisions and guts is emptied. Guts point values are kept.';
      return;
    }
    disarmClear();
    try {
      await store.saveKey(buildKeyRows({ blank: true }));
      settleKey();
      await refresh();
      toast('Answer key cleared. Nothing is scored until you set it again.', 'info');
    } catch (err) {
      toast(err.message || 'Could not clear the key.', 'error');
    }
  });

  for (const btn of $$('.tab[data-keydiv]')) {
    btn.addEventListener('click', () => {
      activeKeyDivision = btn.dataset.keydiv;
      for (const b of $$('.tab[data-keydiv]')) {
        b.setAttribute('aria-selected', String(b === btn));
      }
      for (const division of cfg.DIVISIONS) {
        $(`#keyIndividual${division}`).classList.toggle('hidden', division !== activeKeyDivision);
      }
    });
  }
  $('#saveKey').addEventListener('click', saveKey);

  $('#clockStart').addEventListener('click', () => clockAction('start'));
  $('#clockPause').addEventListener('click', () => clockAction('pause'));
  $('#clockPlus').addEventListener('click', () => clockAction('plus'));
  $('#clockMinus').addEventListener('click', () => clockAction('minus'));
  $('#clockReset').addEventListener('click', () => clockAction('reset'));
  $('#saveClock').addEventListener('click', async () => {
    const minutes = Number($('#durationMinutes').value);
    if (!Number.isFinite(minutes) || minutes < 1) { toast('Length must be at least a minute.', 'error'); return; }
    const running = Boolean(data.state?.guts_running);
    await store.saveState({
      guts_duration: Math.round(minutes * 60),
      freeze_minutes: Math.max(0, Number($('#freezeMinutes').value) || 0),
      ...(running ? {} : { guts_remaining: Math.round(minutes * 60) }),
    });
    for (const id of ['#durationMinutes', '#freezeMinutes']) delete $(id).dataset.dirty;
    await refresh();
    toast('Clock settings saved.');
  });
  $('#freezeToggle').addEventListener('click', async () => {
    await store.setFrozen(!data.state?.guts_frozen);
    await refresh();
  });
  $('#publicLink').href = forceDemo ? 'guts.html?demo=1' : 'guts.html';

  for (const id of ['#teamCount', '#individualMultiplier', '#adminNames', '#graderNames',
    '#durationMinutes', '#freezeMinutes']) {
    $(id).addEventListener('input', () => { $(id).dataset.dirty = '1'; });
  }
  $('#individualMultiplier').addEventListener('input', renderWeightPreview);
  for (const which of ['admin', 'grader']) {
    $(`#${which}Names`).addEventListener('input', renderStaffCounts);
  }
  $('#saveSettings').addEventListener('click', async () => {
    const mult = Number($('#individualMultiplier').value);
    if (!Number.isFinite(mult) || mult < 0) {
      toast('The multiplier has to be zero or more.', 'error');
      return;
    }
    await store.saveSettings({
      team_count: Number($('#teamCount').value) || cfg.TEAM_COUNT,
      individual_multiplier: mult,
    });
    for (const id of ['#teamCount', '#individualMultiplier']) delete $(id).dataset.dirty;
    await refresh();
    toast('Settings saved for everyone.');
  });

  $('#saveStaff').addEventListener('click', async () => {
    const admins = $('#adminNames').value;
    const graders = $('#graderNames').value;
    await store.saveSettings({ admin_names: admins, grader_names: graders });
    for (const id of ['#adminNames', '#graderNames']) delete $(id).dataset.dirty;
    await refresh();
    const counted = (t) => parseNameList(t).length;
    toast(`Sign-in lists saved — ${counted(admins)} admins, ${counted(graders)} scorers.`);
  });

  $('#clearIdleGraders').addEventListener('click', async () => {
    const button = $('#clearIdleGraders');
    // Ten minutes, not the two the lock uses: somebody stepping out for a
    // coffee has not left, and forgetting them mid-contest is startling.
    const IDLE_MINUTES = 10;
    if (button.dataset.armed !== '1') {
      button.dataset.armed = '1';
      button.textContent = `Click again — anyone quiet for ${IDLE_MINUTES} min`;
      setTimeout(() => {
        button.dataset.armed = '';
        button.textContent = 'Forget everyone who has left';
      }, 4000);
      return;
    }
    button.dataset.armed = '';
    button.textContent = 'Forget everyone who has left';
    button.disabled = true;
    try {
      const gone = await store.clearIdleGraders(IDLE_MINUTES * 60);
      graderRowsSignature = null;
      await refresh();
      toast(gone
        ? `Forgot ${gone} scorer${gone === 1 ? '' : 's'}. Nothing they entered was touched.`
        : 'Everyone on the list has been active in the last ten minutes.', 'info');
    } catch (err) {
      toast(err.message || 'Could not clear the list.', 'error');
    } finally {
      button.disabled = false;
    }
  });

  $('#rosterSearch').addEventListener('input', renderRoster);

  const addParticipant = async () => {
    const parsed = parseIndividualId($('#rosterAddId').value);
    if (!parsed.ok) { toast('Enter an ID like A011.', 'error'); $('#rosterAddId').focus(); return; }
    const button = $('#rosterAdd');
    button.disabled = true;
    try {
      const row = {
        individual_id: parsed.id,
        name: $('#rosterAddName').value.trim(),
        division: parsed.division,
        team: parsed.team,
      };
      await store.saveRoster([row]);
      $('#rosterAddId').value = '';
      $('#rosterAddName').value = '';
      rosterShape = null;
      applyWrite([['roster', row]]);
      toast(`${parsed.id} added to team ${parsed.team}.`);
      $('#rosterAddId').focus();
    } catch (err) {
      toast(err.message || 'Could not add that participant.', 'error');
    } finally {
      button.disabled = false;
    }
  };
  $('#rosterAdd').addEventListener('click', addParticipant);
  for (const id of ['#rosterAddId', '#rosterAddName']) {
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') addParticipant(); });
  }
  $('#rosterAddId').addEventListener('input', () => {
    const parsed = parseIndividualId($('#rosterAddId').value);
    $('#rosterAddHint').textContent = parsed.ok
      ? `Division ${parsed.division}, team ${parsed.team}, member ${parsed.member}.`
      : 'The team comes from the ID.';
  });

  $('#rosterExport').addEventListener('click', () => {
    downloadCsv('cowconuts-2026-participants.csv', toCsv(
      ['individual_id', 'team', 'division', 'name'],
      rosterRows(data.roster).map((r) => [r.individualId, r.team, r.division, r.name])));
  });

  $('#rosterImport').addEventListener('click', async () => {
    const { rows, problems } = parseRoster($('#rosterPaste').value);
    const host = $('#rosterProblems');
    host.replaceChildren();
    if (!rows.length && !problems.length) {
      toast('Nothing to import — paste a list first.', 'error');
      return;
    }
    const button = $('#rosterImport');
    button.disabled = true;
    try {
      if (rows.length) await store.saveRoster(rows);
      $('#rosterPaste').value = '';
      rosterShape = null;
      await refresh();
      toast(rows.length
        ? `Imported ${rows.length} participant${rows.length === 1 ? '' : 's'}.`
        : 'Nothing on that list could be read.', rows.length ? 'ok' : 'error');
      // Show every line that could not be read, rather than only the
      // first: a list is usually fixed in one pass or not at all.
      if (problems.length) {
        const warn = el('div', 'banner banner--warn');
        const d = el('div');
        d.append(el('b', null, `${problems.length} line${problems.length === 1 ? '' : 's'} skipped`),
          el('span', null, problems.slice(0, 8).join(' · ')
            + (problems.length > 8 ? ` · and ${problems.length - 8} more` : '')));
        warn.append(el('div', null, '⚠'), d);
        host.appendChild(warn);
      }
    } catch (err) {
      toast(err.message || 'Could not import that list.', 'error');
    } finally {
      button.disabled = false;
    }
  });

  $('#rosterClear').addEventListener('click', async () => {
    const button = $('#rosterClear');
    if (button.dataset.armed !== '1') {
      button.dataset.armed = '1';
      button.textContent = `Click again — removes all ${data.roster.length}`;
      setTimeout(() => {
        button.dataset.armed = '';
        button.textContent = 'Remove every participant';
      }, 4000);
      return;
    }
    button.dataset.armed = '';
    button.textContent = 'Remove every participant';
    const had = data.roster.length;
    await store.clearRoster();
    rosterShape = null;
    await refresh();
    toast(`Removed ${had} participant${had === 1 ? '' : 's'}. `
      + 'Answer sheets and scores are untouched, and saved sheets keep their names.', 'info');
  });

  $('#dqPersonAdd').addEventListener('click', async () => {
    const parsed = parseIndividualId($('#dqPerson').value);
    const reason = $('#dqPersonReason').value.trim();
    if (!parsed.ok) { toast('Enter a contestant ID like A011.', 'error'); return; }
    if (!reason) { toast('Record a reason — it goes on the exports.', 'error'); return; }
    if (!data.contestants.some((c) => c.individual_id === parsed.id)) {
      toast(`${parsed.id} has no sheet entered yet, so there is nothing to disqualify.`, 'error');
      return;
    }
    await store.setContestant(parsed.id, {
      disqualified: true, dq_reason: reason, dq_by: grader.name, dq_at: new Date().toISOString(),
    });
    $('#dqPerson').value = '';
    $('#dqPersonReason').value = '';
    await refresh();
    toast(`${parsed.id} disqualified. Their paper is kept and their team is unaffected.`, 'info');
  });

  $('#dqAdd').addEventListener('click', async () => {
    const typed = $('#dqTeam').value.trim().toUpperCase();
    const reason = $('#dqReason').value.trim();
    const parts = /^([AB])(\d{1,3})$/.exec(typed);
    if (!parts || Number(parts[2]) < 1) {
      toast('Enter a team key like A01.', 'error');
      return;
    }
    // 'A1' and 'A01' are the same team; store the padded form the rest of
    // the portal uses, or the disqualification matches nothing.
    const team = teamKey(parts[1], Number(parts[2]));
    if (!reason) { toast('Record a reason — it goes on the exports.', 'error'); return; }
    await store.setTeam(team, {
      disqualified: true, dq_reason: reason, dq_by: grader.name, dq_at: new Date().toISOString(),
    });
    $('#dqTeam').value = '';
    $('#dqReason').value = '';
    await refresh();
    toast(`Team ${team} disqualified. Its answers are kept.`, 'info');
  });

  $('#exportIndividual').addEventListener('click', exportIndividualCsv);
  $('#exportGuts').addEventListener('click', exportGutsCsv);
  $('#exportCombined').addEventListener('click', exportCombinedCsv);
  $('#exportStats').addEventListener('click', exportStatsCsv);

  const confirmInput = $('#wipeConfirm');
  const wipeButton = $('#wipeAll');
  confirmInput.addEventListener('input', () => {
    wipeButton.disabled = confirmInput.value.trim().toUpperCase() !== 'ERASE';
  });
  wipeButton.addEventListener('click', async () => {
    if (confirmInput.value.trim().toUpperCase() !== 'ERASE') return;
    wipeButton.disabled = true;
    try {
      await releaseHeld();
      // The public board's refresh is a no-op while frozen, so a wipe
      // during a freeze would leave deleted teams on the screen.
      if (data.state?.guts_frozen) await store.setFrozen(false).catch(() => {});
      const counts = await store.clearAll();
      confirmInput.value = '';
      clearSheet();
      await refresh();
      toast(`Deleted ${counts.contestants ?? 0} sheets and ${counts.gutsAnswers ?? counts.guts_answers ?? 0} guts answers.`, 'info');
    } catch (err) {
      toast(err.message || 'Could not clear the data.', 'error');
    }
  });

  // Sign out sits in three places — the top bar, the admin lock banner and the
  // admin tab — because a grader who needs to become an admin cannot reach the
  // admin tab. One handler covers all of them.
  for (const btn of $$('[data-signout]')) {
    btn.addEventListener('click', async () => {
      await releaseHeld();
      await store.signOut();
      localStorage.removeItem('contest-grader-name');
      localStorage.removeItem('contest-role');
      location.reload();
    });
  }

  $('#changeName').addEventListener('click', () => {
    const next = prompt('Scoring as:', grader.name);
    if (!next?.trim()) return;
    grader.name = next.trim();
    localStorage.setItem('contest-grader-name', grader.name);
    $('#whoamiName').textContent = grader.name;
    pushHeartbeat();
  });

  const savedTheme = localStorage.getItem('contest-theme');
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $('#themeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('contest-theme', next);
  });

  if (store.mode === 'demo') {
    $('#seedDemo').classList.remove('hidden');
    $('#seedDemo').addEventListener('click', async () => { await seedDemo(); toast('Demo data loaded.'); });
  }
}

// ---------------------------------------------------------------------
async function seedDemo() {
  const names = ['Cowbell', 'Coconut Crew', 'Milk Maids', 'Udder Chaos', 'Moo Point'];
  const keyRows = [];
  for (const division of cfg.DIVISIONS) {
    for (let p = 1; p <= cfg.INDIVIDUAL_PROBLEMS; p += 1) {
      keyRows.push({
        round: 'individual', division, problem: p,
        answer: (p * (division === 'A' ? 7 : 9)) % 100, points: 1,
      });
    }
  }
  for (let p = 1; p <= GUTS_N; p += 1) {
    keyRows.push({
      round: 'guts', division: GUTS_DIVISION, problem: p,
      answer: (p * 13) % 50, points: Math.ceil(p / cfg.GUTS_PER_SET),
    });
  }
  await store.saveKey(keyRows);

  for (const division of cfg.DIVISIONS) {
    for (let n = 1; n <= 6; n += 1) {
      const team = teamKey(division, n);
      const mult = division === 'A' ? 7 : 9;
      for (const member of cfg.MEMBERS.slice(0, 3 + (n % 2))) {
        const skill = 4 + ((n * 3 + Number(member)) % 9);
        const answers = Array.from({ length: cfg.INDIVIDUAL_PROBLEMS }, (_, i) => (
          (i * 7 + n) % 13 < skill ? ((i + 1) * mult) % 100 : ((i + 1) * mult + 1) % 100));
        await store.saveContestant({
          individual_id: `${team}${member}`,
          team, member, division,
          name: `${names[n % names.length]} ${member}`,
          answers,
          entered_by: 'demo', entered_by_name: 'Demo', entered_at: new Date().toISOString(),
        });
      }
      const gutsSkill = 1 + ((n * 5) % 4);
      for (let set = 1; set <= 4 + (n % 4); set += 1) {
        await store.saveGutsSet(team, problemsInSet(set, cfg).map((p) => ({
          problem: p, answer: (p * n) % 5 < gutsSkill ? (p * 13) % 50 : (p * 13 + 1) % 50,
        })), 'demo', 'Demo', `${names[n % names.length]} ${division}${n}`);
      }
      await store.setTeam(team, { division });
    }
  }
  await refresh();
}

// ---------------------------------------------------------------------
async function enterApp() {
  // The role goes on before the portal is shown, not after the first load
  // of data. The page is built in the scorer's state, and it used to wait
  // for render() to decide -- so every scorer saw the admin panel until
  // the data arrived, and for good if it never did.
  applyRole();
  $('#gate').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#whoamiName').textContent = grader.name;
  $('#brandName').textContent = cfg.CONTEST_NAME;
  document.title = `${cfg.CONTEST_NAME} — Staff Portal`;

  wire();
  try { await store.releaseStale(Math.round(cfg.CLAIM_TTL_MS / 1000)); } catch { /* best effort */ }
  await pushHeartbeat();
  await refresh();

  store.onChange((snapshot) => {
    if (snapshot) { data = snapshot; render(); } else refresh();
  });
  startClockTicker();

  // One tick, two cadences. Both of these writes fan out to every open
  // screen as a realtime message, so each runs only as often as it has
  // to rather than on every tick.
  let lastPresence = 0;
  setInterval(() => {
    const now = Date.now();
    if (now - lastPresence >= cfg.PRESENCE_MS) {
      lastPresence = now;
      pushHeartbeat();
    }
    // Renew the lock we hold, and re-take the one on screen if we never
    // got it — a claim skipped because another was in flight would
    // otherwise leave the sheet looking free while somebody types into
    // it. Retrying also picks a sheet up the moment its holder moves on.
    const want = wantedClaim();
    if (!want) return;
    if (held && held.scope === want.scope && held.ref === want.ref) {
      if (now - lastClaimAt < cfg.CLAIM_RENEW_MS) return;
      lastClaimAt = now;
      store.claim(want.scope, want.ref, grader, cfg.CLAIM_TTL_MS).catch(() => {});
    } else {
      claimCurrent();
    }
  }, cfg.HEARTBEAT_MS);

  if (data.missingTables?.length) {
    toast(`Your database is missing: ${data.missingTables.join(', ')}. `
      + 'Run supabase/schema.sql in the Supabase SQL Editor. Everything else works.',
    'error');
  }

  addEventListener('pagehide', () => { releaseHeld(); });
  $('#individualId').focus();
}

/**
 * GitHub Pages caches each file separately, so a browser can end up with
 * a new index.html and a stale script (or the reverse). That used to show
 * as a panel with its controls silently missing. Now it says so.
 */
function checkVersion() {
  const markup = document.body.dataset.appVersion;
  if (!markup || markup === APP_VERSION) return true;
  const b = el('div', 'banner banner--error');
  const d = el('div');
  d.append(
    el('b', null, 'This page is half-updated'),
    el('span', null, `The page is ${markup} but the script is ${APP_VERSION}. `
      + 'Hard refresh to fix it: Cmd/Ctrl + Shift + R.'),
  );
  b.append(el('div', null, '⚠'), d);
  $('#gate').querySelector('.gate__card').prepend(b);
  return false;
}

// The one thing the door ever says when it will not open.
//
// A wrong name and a wrong password give the same sentence, deliberately.
// Told which half was wrong, somebody holding one of them can go looking
// for the other -- and the name is the half that is easy to guess, since
// the people scoring a contest are not a secret. Saying nothing makes the
// pair the credential rather than the password alone.
//
// It costs a scorer who mistypes their own name the hint that it was the
// name. That is the trade, and it is why the card tells them to have both
// in front of them.
const DOOR_CLOSED = 'That name and password were not accepted. '
  + 'Both have to match what the director gave you.';

// And the one thing it says when it could not ask at all. Never the
// sentence above: a scorer told their password is wrong when the wifi
// dropped will start guessing at a password that was right.
const NO_ANSWER_AT_DOOR = 'Could not reach the server. Check the connection and try again.';
const NO_ANSWER_ON_RETURN = 'Could not reach the server to check your sign-in. '
  + 'Check the connection and reload — you will not need the password again.';

/**
 * Is this name allowed under this role? Returns the message to show, or
 * null to let them in.
 *
 * This is a roster check as well as a lock: with a list filled in, the
 * name is the second half of getting through the door, so it stops
 * whoever learned the password from grading under a name nobody knows.
 */
async function nameRejected(name, admin) {
  let settings = null;
  try {
    settings = (await store.load()).settings;
  } catch {
    return null;            // can't read the lists — never lock anyone out
  }
  const list = admin ? settings?.admin_names : settings?.grader_names;
  if (nameAllowed(list, name)) return null;
  // An admin may also sit down and score, so an admin name passes either door.
  if (!admin && nameAllowed(settings?.admin_names, name)
      && parseNameList(settings?.admin_names).length) return null;
  return DOOR_CLOSED;
}

async function boot() {
  checkVersion();
  $('#gateTitle').textContent = cfg.CONTEST_NAME.replace(/ Annual Math Contest$/, '');
  const nameInput = $('#graderName');
  const passwordInput = $('#staffPassword');
  nameInput.value = grader.name;

  const override = readOverride();
  $('#connUrl').value = override?.url ?? '';
  $('#connKey').value = override?.key ?? '';
  $('#gateConnect').addEventListener('click', () => $('#connectPanel').classList.toggle('hidden'));
  $('#connSave').addEventListener('click', () => {
    writeOverride($('#connUrl').value.trim(), $('#connKey').value.trim());
    location.reload();
  });

  if (store.mode === 'demo') {
    $('#gateDemo').classList.remove('hidden');
    $('#passwordField').classList.add('hidden');
    $('#adminHint').textContent =
      'Demo mode: type anything for admin, or leave it blank for the scorer view.';
  }
  // Coming back to a signed-in browser has to pass the same two checks as
  // the door. It used to take whatever session the browser had stored,
  // without asking the server whether it was still alive and without
  // looking at the name list -- so a name turned away at the door, or a
  // session a password change had ended, walked in on a reload, and a
  // browser that could not say which account it held was treated as an
  // admin. Now the server says who this is, the name list is checked
  // again, and anything short of both is the sign-in screen.
  if (grader.name) {
    const ask = async () => {
      try { return { email: await store.verifiedEmail() }; }
      catch (err) { return { email: null, unreachable: Boolean(err?.unreachable) }; }
    };
    // One second try covers the blink of a connection coming back; past
    // that, say so and keep the session for the reload that follows.
    let who = await ask();
    if (who.unreachable) {
      await new Promise((r) => setTimeout(r, 1500));
      who = await ask();
    }
    if (who.unreachable) {
      $('#gateError').textContent = NO_ANSWER_ON_RETURN;
      $('#gateError').classList.add('field__hint--error');
    }
    const email = who.email;
    if (email) {
      isAdmin = email === cfg.ADMIN_EMAIL;
      if (!(await nameRejected(grader.name, isAdmin))) {
        await enterApp();
        return;
      }
      await store.signOut().catch(() => {});
      isAdmin = false;
    }
  }

  const submit = async () => {
    const name = nameInput.value.trim();
    if (!name) {
      $('#gateError').textContent = 'We need a name to stamp on your entries.';
      $('#gateError').classList.add('field__hint--error');
      return;
    }
    grader.name = name;
    localStorage.setItem('contest-grader-name', name);
    const adminPassword = $('#adminPassword').value;
    if (store.mode === 'supabase') {
      try {
        $('#gateEnter').disabled = true;
        const result = await store.signIn(adminPassword || passwordInput.value,
          { admin: Boolean(adminPassword) });
        isAdmin = Boolean(result?.admin);
        // The password says which door you came through; the roster says
        // whether you are expected. Checked after signing in because the
        // lists live in the database, which nobody may read until then.
        const rejected = await nameRejected(name, isAdmin);
        if (rejected) {
          await store.signOut().catch(() => {});
          $('#gateError').textContent = rejected;
          $('#gateError').classList.add('field__hint--error');
          return;
        }
        localStorage.setItem('contest-role', isAdmin ? 'admin' : 'scorer');
      } catch (err) {
        $('#gateError').textContent = err?.unreachable ? NO_ANSWER_AT_DOOR
          : /Invalid/.test(err.message ?? '') ? DOOR_CLOSED
            : (err.message || 'Could not sign in.');
        $('#gateError').classList.add('field__hint--error');
        return;
      } finally { $('#gateEnter').disabled = false; }
    } else {
      // Demo has no real accounts, so any admin password will do. Leaving it
      // blank signs you in as a scorer, which is how you preview what the
      // scoring team actually sees.
      isAdmin = Boolean(adminPassword);
      const rejected = await nameRejected(name, isAdmin);
      if (rejected) {
        $('#gateError').textContent = rejected;
        $('#gateError').classList.add('field__hint--error');
        return;
      }
      localStorage.setItem('contest-role', isAdmin ? 'admin' : 'scorer');
    }
    await enterApp();
  };
  $('#gateEnter').addEventListener('click', submit);
  for (const input of [nameInput, passwordInput]) {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }
  (grader.name ? passwordInput : nameInput).focus();
}

boot();
