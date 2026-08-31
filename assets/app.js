// =====================================================================
//  Cowconuts 2026 Annual Math Contest — staff portal
// =====================================================================

import { CONFIG, resolvedConfig, readOverride, writeOverride } from './config.js';
import { createStore } from './store.js';
import { toCsv, downloadCsv } from './csv.js';
import {
  parseIndividualId, isMemberLetter, parseAnswer, problemsInSet, gutsProblemCount,
  indexKey, keyGaps, individualKey, GUTS_DIVISION,
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
const cfg = resolvedConfig(location.search);
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
let held = null;           // { scope, ref }
let blockedBy = null;
let connected = false;
let clockTimer = null;
let freezing = false;

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
  if (s.individual_weight != null) cfg.INDIVIDUAL_WEIGHT = Number(s.individual_weight);
  if (s.guts_weight != null) cfg.GUTS_WEIGHT = Number(s.guts_weight);

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
    teamsByNo: new Map(data.teams.map((t) => [Number(t.team), t])),
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
    const seenTeams = new Set(data.contestants.map((c) => Number(c.team)));
    for (const team of [...seenTeams].sort((a, b) => a - b)) {
      if (dq.has(team)) continue;
      for (const member of cfg.MEMBERS) {
        const id = `${team}${member}`;
        if (data.contestants.some((c) => c.individual_id === id)) continue;
        if (claims.has(`individual|${id}`)) continue;
        out.push({ kind: 'individual', id, label: id, why: `team ${team} is part-entered` });
      }
    }
  } else {
    for (const t of [...data.teams].sort((a, b) => a.team - b.team)) {
      if (dq.has(Number(t.team))) continue;
      const answers = gutsByTeam.get(Number(t.team));
      for (let set = 1; set <= cfg.GUTS_SETS; set += 1) {
        const problems = problemsInSet(set, cfg);
        const done = problems.every((p) => answers?.get(p) != null);
        if (done) continue;
        if (claims.has(`guts|${t.team}:${set}`)) continue;
        out.push({
          kind: 'guts', team: Number(t.team), set,
          label: `Team ${t.team} · set ${set}`,
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
function buildAnswerGrid(host, count, { offset = 0, onChange } = {}) {
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
      if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); inputs[i + 1]?.focus(); }
      if (e.key === 'ArrowRight' && input.selectionStart === input.value.length) inputs[i + 1]?.focus();
      if (e.key === 'ArrowLeft' && input.selectionStart === 0) inputs[i - 1]?.focus();
      if (e.key === 'ArrowDown') { e.preventDefault(); inputs[i + 5]?.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); inputs[i - 5]?.focus(); }
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

function currentIndividualId() {
  const team = Number($('#teamNo').value);
  const member = $('#memberLetter').value.trim().toUpperCase();
  // A digit typed into the member box used to build IDs like "121",
  // which then read back as team 121 — a contestant nobody could find.
  if (!Number.isInteger(team) || team < 1 || !isMemberLetter(member)) return null;
  return { id: `${team}${member}`, team, member };
}

function onIdTyped() {
  const input = $('#individualId');
  input.value = input.value.toUpperCase();
  const parsed = parseIndividualId(input.value);
  const echo = $('#idEcho');
  echo.classList.remove('field__hint--error');

  if (parsed.ok) {
    $('#teamNo').value = parsed.team;
    $('#memberLetter').value = parsed.member;
    echo.textContent = `Team ${parsed.team}, member ${parsed.member}. Both boxes below stay editable.`;
    loadExistingSheet();
    claimCurrent();
  } else if (parsed.partial) {
    $('#teamNo').value = parsed.team;
    echo.textContent = parsed.error;
  } else if (input.value.trim()) {
    echo.textContent = parsed.error;
    echo.classList.add('field__hint--error');
  } else {
    echo.textContent = 'Type 12C and the team and member fill themselves in.';
  }
  refreshIndividualContext();
}

/** Pull back a sheet that has already been entered, so it can be fixed. */
function loadExistingSheet() {
  const current = currentIndividualId();
  if (!current) return;
  const existing = data.contestants.find((c) => c.individual_id === current.id);
  if (!existing) return;
  fillGrid(sheetInputs, existing.answers ?? []);
  $('#contestantName').value = existing.name ?? '';
  const team = derived.teamsByNo.get(current.team);
  $('#divisionPick').value = existing.division ?? team?.division ?? '';
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
    ? `— out of ${cfg.INDIVIDUAL_PROBLEMS}, pick a division to check them against the key`
    : gaps.length
      ? `— ${gaps.length} of ${cfg.INDIVIDUAL_PROBLEMS} not in the Division ${division} key yet`
      : `— out of ${cfg.INDIVIDUAL_PROBLEMS}, Division ${division} key`;

  if (!current) return;

  const team = derived.teamsByNo.get(current.team);
  if (team?.division && !$('#divisionPick').value) $('#divisionPick').value = team.division;

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

  if (current.team > cfg.TEAM_COUNT) {
    const b = el('div', 'banner banner--warn');
    const d = el('div');
    d.append(el('b', null, `Team ${current.team} is above your team count of ${cfg.TEAM_COUNT}`),
      el('span', null, 'Usually a mistyped number. It will still save if that is really the team.'));
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
    toast(member && !isMemberLetter(member)
      ? 'The member has to be a single letter, like C.'
      : 'Enter an individual ID, like 12C.', 'error');
    $(member && !isMemberLetter(member) ? '#memberLetter' : '#individualId').focus();
    return;
  }
  const division = $('#divisionPick').value;
  if (!division) { toast('Pick a division.', 'error'); $('#divisionPick').focus(); return; }
  const { values, bad } = readGrid(sheetInputs);
  if (bad) { toast('One of the answers is not a whole number.', 'error'); return; }

  const button = $('#saveSheet');
  button.disabled = true;
  try {
    await store.saveContestant({
      individual_id: current.id,
      team: current.team,
      member: current.member,
      division,
      name: $('#contestantName').value.trim(),
      answers: values,
      entered_by: grader.id,
      entered_by_name: grader.name,
      entered_at: new Date().toISOString(),
    });
    const result = scoreSheet(values, derived.key, cfg, division);
    toast(`${current.id} saved · ${result.correct}/${cfg.INDIVIDUAL_PROBLEMS} · ${result.score} pts`);
    await releaseHeld();
    clearSheet({ keepTeam: true });
    await refresh();
  } catch (err) {
    toast(err.message || 'Could not save that sheet.', 'error');
  } finally {
    button.disabled = false;
  }
}

function clearSheet({ keepTeam = false } = {}) {
  releaseHeld();
  $('#individualId').value = '';
  if (!keepTeam) { $('#teamNo').value = ''; $('#divisionPick').value = ''; }
  $('#memberLetter').value = '';
  $('#contestantName').value = '';
  fillGrid(sheetInputs, []);
  $('#idEcho').textContent = 'Type 12C and the team and member fill themselves in.';
  refreshIndividualContext();
  $('#individualId').focus();
}

// ---------------------------------------------------------------------
// Guts entry
// ---------------------------------------------------------------------

function currentGuts() {
  const team = Number($('#gutsTeam').value);
  const set = Number($('#gutsSet').value);
  if (!Number.isInteger(team) || team < 1 || !set) return null;
  return { team, set };
}

function refreshGutsContext() {
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
  if (team?.division && !$('#gutsDivision').value) $('#gutsDivision').value = team.division;

  const answers = derived.gutsByTeam.get(current.team);
  fillGrid(gutsInputs, problems.map((p) => answers?.get(p) ?? null));

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
  if (!current) { toast('Enter a team number and pick a set.', 'error'); return; }
  const { values, bad } = readGrid(gutsInputs);
  if (bad) { toast('One of the answers is not a whole number.', 'error'); return; }

  const team = derived.teamsByNo.get(current.team);
  const typedName = $('#gutsTeamName').value.trim();
  if (!team?.name && !typedName) {
    toast('Give the team a name — it is what the public board shows.', 'error');
    $('#gutsTeamName').focus();
    return;
  }

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
    const division = $('#gutsDivision').value;
    if (division && division !== team?.division) await store.setTeam(current.team, { division });
    toast(`Team ${current.team} set ${current.set} saved.`);
    await releaseHeld();
    $('#gutsTeamName').dataset.dirty = '';
    const next = current.set < cfg.GUTS_SETS ? current.set + 1 : current.set;
    $('#gutsSet').value = String(next);
    fillGrid(gutsInputs, []);
    await refresh();
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

async function claimCurrent() {
  const want = wantedClaim();
  if (!want || claiming) return;
  if (held && held.scope === want.scope && held.ref === want.ref) return;
  claiming = true;
  try {
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
        $('#gutsTeam').value = String(item.team);
        $('#gutsSet').value = String(item.set);
        $('#gutsTeamName').dataset.dirty = '';
        refreshGutsContext();
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

function renderProgress() {
  const host = $('#progressPanel');
  host.replaceChildren();

  const teams = [...new Set([
    ...data.teams.map((t) => Number(t.team)),
    ...data.contestants.map((c) => Number(c.team)),
  ])].sort((a, b) => a - b);

  const donePeople = derived.individuals.filter((p) => p.answered > 0).length;
  const bar = el('div', 'matrix__bar');
  bar.append(
    el('span', 'tag tag--a', `${teams.length} of ${cfg.TEAM_COUNT} teams`),
    el('span', 'muted', `${donePeople} sheets entered`),
  );
  bar.appendChild(el('span', 'spacer'));
  const gutsDone = derived.guts.reduce(
    (n, g) => n + g.perSet.filter((s) => s.complete).length, 0);
  bar.appendChild(el('span', 'muted', `${gutsDone}/${teams.length * cfg.GUTS_SETS} guts sets`));
  host.appendChild(bar);

  if (!teams.length) {
    host.appendChild(el('div', 'empty',
      'Nothing entered yet. Type an individual ID on the left to begin.'));
    return;
  }

  const roster = el('div', 'roster');
  for (const teamNo of teams) {
    const team = derived.teamsByNo.get(teamNo);
    const card = el('div', `rosterteam${team?.disqualified ? ' rosterteam--dq' : ''}`);

    const head = el('div', 'rosterteam__head');
    head.append(el('span', null, `TEAM ${teamNo}`));
    if (team?.name) head.append(el('span', 'rosterteam__name', team.name));
    if (team?.division) head.append(el('span', `tag tag--${team.division.toLowerCase()}`, team.division));
    if (team?.disqualified) head.append(el('span', 'tag tag--flag', 'DQ'));
    head.appendChild(el('span', 'spacer'));

    const answers = derived.gutsByTeam.get(teamNo);
    const gutsResult = scoreGutsTeam(answers, derived.key, cfg);
    const pips = el('div', 'setpips');
    for (const set of gutsResult.perSet) {
      const claimed = derived.claims.has(`guts|${teamNo}:${set.set}`);
      let cls = 'setpip';
      if (set.complete) cls += ' setpip--done';
      else if (set.answered) cls += ' setpip--partial';
      else if (claimed) cls += ' setpip--claimed';
      const pip = el('div', cls, String(set.set));
      pip.title = `Guts set ${set.set} — ${set.answered}/${cfg.GUTS_PER_SET} entered, ${set.score} pts`;
      pips.appendChild(pip);
    }
    head.appendChild(pips);
    card.appendChild(head);

    const people = el('div', 'people');
    for (const member of cfg.MEMBERS) {
      const id = `${teamNo}${member}`;
      const person = derived.byId.get(id);
      const claimed = derived.claims.get(`individual|${id}`);
      let cls = 'person';
      if (person && person.answered === cfg.INDIVIDUAL_PROBLEMS) cls += ' person--done';
      else if (person && person.answered > 0) cls += ' person--partial';
      else if (claimed) cls += ' person--claimed';

      const chip = el('button', cls);
      chip.type = 'button';
      chip.append(el('span', null, id));
      if (person) chip.append(el('span', 'person__score', String(person.score)));
      chip.title = person
        ? `${person.name || id} — ${person.answered}/${cfg.INDIVIDUAL_PROBLEMS} answered, ${person.score} pts`
        : (claimed ? `${claimed.grader_name} is entering this` : 'not entered');
      chip.addEventListener('click', () => {
        setEntryMode('individual');
        $('#individualId').value = id;
        onIdTyped();
      });
      people.appendChild(chip);
    }
    card.appendChild(people);
    roster.appendChild(card);
  }
  host.appendChild(roster);
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
const rankCls = (i) => `rank${i < 3 ? ` rank--${i + 1}` : ''}`;

function renderBoards() {
  const host = $('#boards');
  host.replaceChildren();

  const note = el('p', 'field__hint');
  note.style.marginBottom = '14px';
  if (activeBoard === 'combined') {
    note.textContent = `Combined = ${cfg.INDIVIDUAL_WEIGHT}% individual + ${cfg.GUTS_WEIGHT}% guts, `
      + 'each as a share of its own maximum, out of 100. The divisions sit different '
      + `individual papers, so each team is measured against its own: a full team can bank `
      + cfg.DIVISIONS.map((d) => `${individualMaxPoints(derived.key, cfg, d)} in ${d}`).join(' and ')
      + `, plus ${gutsMaxPoints(derived.key, cfg)} from guts.`;
  } else if (activeBoard === 'individual') {
    note.textContent = `One row per contestant, out of ${cfg.INDIVIDUAL_PROBLEMS}.`;
  } else {
    note.textContent = 'Team guts scores, with points rising by set.';
  }
  host.appendChild(note);

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

    if (activeBoard === 'combined') {
      const cell = (r) => {
        const n = el('span', 'mono', r.total.toFixed(2));
        n.title = `individual ${r.individual}/${r.indMax} = ${r.indPct.toFixed(1)}% × ${cfg.INDIVIDUAL_WEIGHT}\n`
          + `guts ${r.guts ?? 0}/${r.gutsMax} = ${r.gutsPct.toFixed(1)}% × ${cfg.GUTS_WEIGHT}`;
        return n;
      };
      const row = (r, i) => [
        { text: i == null ? 'DQ' : String(i + 1), cls: i == null ? 'rank' : rankCls(i) },
        { text: r.name ? `${r.team} · ${r.name}` : `Team ${r.team}` },
        { text: String(r.individual), cls: 'num' },
        { text: r.guts == null ? '—' : String(r.guts), cls: 'num' },
        { node: cell(r), cls: 'num' },
        { text: `${r.entered} entered`, cls: 'muted' },
      ];
      const header = ['#', 'Team', { label: 'Individual', num: true }, { label: 'Guts', num: true },
        { label: 'Combined', num: true }, 'Sheets'];
      if (ranked.length) host.appendChild(table(header, ranked.map(row)));
      if (out.length) {
        const w = table(header, out.map((r) => row(r, null)));
        w.classList.add('table-wrap--dq');
        host.appendChild(w);
      }
    } else if (activeBoard === 'individual') {
      const row = (r, i) => [
        { text: i == null ? 'DQ' : String(i + 1), cls: i == null ? 'rank' : rankCls(i) },
        { text: r.individualId },
        { text: r.name || '—' },
        { text: String(r.correct), cls: 'num' },
        { text: String(r.score), cls: 'num' },
        { text: `${r.answered}/${cfg.INDIVIDUAL_PROBLEMS}`, cls: 'muted' },
      ];
      const header = ['#', 'ID', 'Name', { label: 'Correct', num: true },
        { label: 'Points', num: true }, 'Answered'];
      if (ranked.length) host.appendChild(table(header, ranked.map(row)));
      if (out.length) {
        const w = table(header, out.map((r) => row(r, null)));
        w.classList.add('table-wrap--dq');
        host.appendChild(w);
      }
    } else {
      const row = (r, i) => [
        { text: i == null ? 'DQ' : String(i + 1), cls: i == null ? 'rank' : rankCls(i) },
        { text: r.name ? `${r.team} · ${r.name}` : `Team ${r.team}` },
        { text: String(r.correct), cls: 'num' },
        { text: String(r.score), cls: 'num' },
        { text: `${r.perSet.filter((s) => s.complete).length}/${cfg.GUTS_SETS}`, cls: 'muted' },
      ];
      const header = ['#', 'Team', { label: 'Correct', num: true },
        { label: 'Points', num: true }, 'Sets'];
      if (ranked.length) host.appendChild(table(header, ranked.map(row)));
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

function buildKeyEditor() {
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
    keyGutsInputs.push(...buildAnswerGrid(grid, cfg.GUTS_PER_SET, { offset: problems[0] - 1 }));
    host.appendChild(box);
  }
}

function fillKeyEditor() {
  // The status line always reflects the saved key. Only the input boxes
  // are held back, and only while somebody is typing in them — otherwise
  // saving from a button inside this tab would leave the status stale.
  const perDivision = cfg.DIVISIONS.map((d) => derived.keyGapsIndividual[d].length);
  const gaps = perDivision.reduce((a, b) => a + b, 0) + derived.keyGapsGuts.length;
  $('#keyState').textContent = gaps ? `${gaps} unset` : 'complete';
  $('#keyState').className = gaps ? 'tag tag--flag' : 'tag tag--live';
  $('#keyDivState').textContent = cfg.DIVISIONS
    .map((d, i) => `${d}: ${perDivision[i] ? `${perDivision[i]} unset` : 'complete'}`)
    .join(' · ');

  if (document.activeElement?.closest('#tab-key .ans')) return;
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

async function saveKey() {
  const rows = [];
  for (const division of cfg.DIVISIONS) {
    for (let p = 1; p <= cfg.INDIVIDUAL_PROBLEMS; p += 1) {
      const parsed = parseAnswer(keyIndividualInputs[division][p - 1].value);
      if (!parsed.ok) {
        toast(`Division ${division} problem ${p}: whole numbers only.`, 'error');
        return;
      }
      rows.push({
        round: 'individual', division, problem: p,
        answer: parsed.value, points: cfg.INDIVIDUAL_POINTS,
      });
    }
  }
  for (let set = 1; set <= cfg.GUTS_SETS; set += 1) {
    const points = Number(keyPointInputs[set - 1].value);
    if (!Number.isFinite(points) || points < 0) {
      toast(`Set ${set}: points must be zero or more.`, 'error');
      return;
    }
    for (const p of problemsInSet(set, cfg)) {
      const parsed = parseAnswer(keyGutsInputs[p - 1].value);
      if (!parsed.ok) { toast(`Guts problem ${p}: whole numbers only.`, 'error'); return; }
      rows.push({ round: 'guts', division: GUTS_DIVISION, problem: p, answer: parsed.value, points });
    }
  }
  try {
    await store.saveKey(rows);
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
  const ind = Number($('#individualWeight').value) || 0;
  const guts = Number($('#gutsWeight').value) || 0;
  const sum = ind + guts;
  const host = $('#weightPreview');
  host.replaceChildren();
  const d = el('div');
  if (!sum) {
    host.className = 'banner banner--error';
    d.append(el('b', null, 'Both weights are zero'), el('span', null, 'Nothing would be scored.'));
  } else {
    host.className = 'banner banner--info';
    const pct = Math.round((ind / sum) * 100);
    d.append(el('b', null, `A perfect team scores ${pct} from the individual round and ${100 - pct} from guts.`),
      el('span', null, 'Each round is measured against its own maximum first, so these are the real shares.'));
  }
  host.appendChild(d);
}

function renderDqList() {
  const host = $('#dqList');
  host.replaceChildren();
  const out = data.teams.filter((t) => t.disqualified).sort((a, b) => a.team - b.team);
  if (!out.length) { host.appendChild(el('p', 'field__hint', 'No teams are disqualified.')); return; }
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

function exportIndividualCsv() {
  const rows = derived.individuals.map((r, i) => [
    r.disqualified ? 'DQ' : i + 1, r.division ?? '', r.individualId, r.team, r.member, r.name,
    r.correct, r.score, r.answered, r.enteredBy, r.disqualified ? 'yes' : 'no',
    ...r.marks.map((m) => m[0].toUpperCase()),
  ]);
  downloadCsv('cowconuts-2026-individual.csv', toCsv(
    ['rank', 'division', 'individual_id', 'team', 'member', 'name', 'correct', 'points',
      'answered', 'entered_by', 'disqualified',
      ...Array.from({ length: cfg.INDIVIDUAL_PROBLEMS }, (_, i) => `q${i + 1}`)],
    rows));
}

function exportGutsCsv() {
  const rows = derived.guts.map((r, i) => [
    r.disqualified ? 'DQ' : i + 1, r.division ?? '', r.team, r.name, r.correct, r.score,
    r.disqualified ? 'yes' : 'no', ...r.perSet.map((s) => s.score),
  ]);
  downloadCsv('cowconuts-2026-guts.csv', toCsv(
    ['rank', 'division', 'team', 'team_name', 'correct', 'points', 'disqualified',
      ...Array.from({ length: cfg.GUTS_SETS }, (_, i) => `set${i + 1}`)],
    rows));
}

function exportCombinedCsv() {
  const rows = [];
  for (const division of ['A', 'B']) {
    let rank = 0;
    for (const r of splitByDivision(derived.combined)[division]) {
      const i = r.disqualified ? null : rank++;
      rows.push([i == null ? 'DQ' : i + 1, division, r.team, r.name,
        r.individual, r.indMax, r.indPct.toFixed(2),
        r.guts ?? '', r.gutsMax, r.gutsPct.toFixed(2),
        r.total.toFixed(4), r.disqualified ? 'yes' : 'no',
        r.members.map((m) => `${m.individualId}:${m.score}`).join(' ')]);
    }
  }
  downloadCsv('cowconuts-2026-combined.csv', toCsv(
    ['rank_in_division', 'division', 'team', 'team_name', 'individual_total', 'individual_max',
      'individual_pct', 'guts_total', 'guts_max', 'guts_pct', 'combined', 'disqualified',
      'member_breakdown'],
    rows));
}

// ---------------------------------------------------------------------
// Render / refresh
// ---------------------------------------------------------------------

function render() {
  recompute();
  renderSuggestions();
  if (activeTab === 'progress') renderProgress();
  if (activeTab === 'leaderboard') renderBoards();
  if (activeTab === 'key') fillKeyEditor();
  renderClock();
  renderWeightPreview();
  renderDqList();

  if (entryMode === 'individual') { markSheetAgainstKey(); refreshIndividualContext(); }
  else refreshGutsContext();

  const online = data.graders.filter(
    (g) => Date.now() - new Date(g.last_seen).getTime() < cfg.CLAIM_TTL_MS);
  $('#onlineCount').textContent = String(Math.max(online.length, 1));

  $('#wipeCounts').textContent = data.contestants.length || data.gutsAnswers.length
    ? `${data.contestants.length} sheets · ${data.gutsAnswers.length} guts answers · `
      + `${data.teams.length} teams · ${data.claims.length} open locks`
    : 'Nothing to delete.';

  for (const [id, value] of [
    ['#teamCount', cfg.TEAM_COUNT],
    ['#individualWeight', cfg.INDIVIDUAL_WEIGHT],
    ['#gutsWeight', cfg.GUTS_WEIGHT],
    ['#durationMinutes', Math.round((data.state?.guts_duration ?? cfg.GUTS_DURATION) / 60)],
    ['#freezeMinutes', data.state?.freeze_minutes ?? cfg.FREEZE_MINUTES],
  ]) {
    const input = $(id);
    if (input && input !== document.activeElement) input.value = value;
  }
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
      for (const b of $$('.tab[data-board]')) b.setAttribute('aria-selected', String(b === btn));
      renderBoards();
    });
  }

  sheetInputs = buildAnswerGrid($('#answerGrid'), cfg.INDIVIDUAL_PROBLEMS,
    { onChange: () => markSheetAgainstKey() });

  const setSelect = $('#gutsSet');
  for (let set = 1; set <= cfg.GUTS_SETS; set += 1) {
    setSelect.appendChild(new Option(`Set ${set}`, String(set)));
  }
  gutsInputs = buildAnswerGrid($('#gutsGrid'), cfg.GUTS_PER_SET);

  $('#individualId').addEventListener('input', onIdTyped);
  for (const id of ['#teamNo', '#memberLetter']) {
    $(id).addEventListener('input', () => {
      const current = currentIndividualId();
      if (current) { $('#individualId').value = current.id; loadExistingSheet(); claimCurrent(); }
      refreshIndividualContext();
    });
  }
  // Switching division changes which paper the answers are marked against.
  $('#divisionPick').addEventListener('change', () => {
    markSheetAgainstKey();
    refreshIndividualContext();
  });
  $('#saveSheet').addEventListener('click', saveSheet);
  $('#clearSheet').addEventListener('click', () => clearSheet());

  $('#gutsTeam').addEventListener('input', () => {
    $('#gutsTeamName').dataset.dirty = '';
    refreshGutsContext();
    claimCurrent();
  });
  $('#gutsSet').addEventListener('change', () => { refreshGutsContext(); claimCurrent(); });
  $('#gutsTeamName').addEventListener('input', () => { $('#gutsTeamName').dataset.dirty = '1'; });
  $('#saveGuts').addEventListener('click', saveGutsSet);
  $('#clearGuts').addEventListener('click', () => { fillGrid(gutsInputs, []); });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (entryMode === 'individual') saveSheet(); else saveGutsSet();
    }
  });

  buildKeyEditor();
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
    await refresh();
    toast('Clock settings saved.');
  });
  $('#freezeToggle').addEventListener('click', async () => {
    await store.setFrozen(!data.state?.guts_frozen);
    await refresh();
  });
  $('#publicLink').href = `guts.html${location.search}`;

  for (const id of ['#individualWeight', '#gutsWeight']) {
    $(id).addEventListener('input', renderWeightPreview);
  }
  $('#saveSettings').addEventListener('click', async () => {
    const ind = Number($('#individualWeight').value);
    const guts = Number($('#gutsWeight').value);
    if (ind + guts <= 0) { toast('One of the weights has to be above zero.', 'error'); return; }
    await store.saveSettings({
      team_count: Number($('#teamCount').value) || cfg.TEAM_COUNT,
      individual_weight: ind,
      guts_weight: guts,
    });
    await refresh();
    toast('Settings saved for everyone.');
  });

  $('#dqAdd').addEventListener('click', async () => {
    const team = Number($('#dqTeam').value);
    const reason = $('#dqReason').value.trim();
    if (!Number.isInteger(team) || team < 1) { toast('Enter the team number.', 'error'); return; }
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

  $('#signOut').addEventListener('click', async () => {
    await releaseHeld();
    await store.signOut();
    localStorage.removeItem('contest-grader-name');
    location.reload();
  });

  $('#changeName').addEventListener('click', () => {
    const next = prompt('Scoring as:', grader.name);
    if (!next?.trim()) return;
    grader.name = next.trim();
    localStorage.setItem('contest-grader-name', grader.name);
    $('#whoamiName').textContent = grader.name;
    store.heartbeat(grader).catch(() => {});
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

  for (let team = 1; team <= 10; team += 1) {
    const division = team % 2 ? 'A' : 'B';
    for (const member of cfg.MEMBERS.slice(0, 2 + (team % 3))) {
      const skill = 4 + ((team * 3 + member.charCodeAt(0)) % 9);
      const mult = division === 'A' ? 7 : 9;
      const answers = Array.from({ length: cfg.INDIVIDUAL_PROBLEMS }, (_, i) => (
        (i * 7 + team) % 13 < skill ? ((i + 1) * mult) % 100 : ((i + 1) * mult + 1) % 100));
      await store.saveContestant({
        individual_id: `${team}${member}`,
        team, member, division,
        name: `${names[team % names.length]} ${member}`,
        answers,
        entered_by: 'demo', entered_by_name: 'Demo', entered_at: new Date().toISOString(),
      });
    }
    const gutsSkill = 1 + ((team * 5) % 4);
    for (let set = 1; set <= 5 + (team % 3); set += 1) {
      await store.saveGutsSet(team, problemsInSet(set, cfg).map((p) => ({
        problem: p, answer: (p * team) % 5 < gutsSkill ? (p * 13) % 50 : (p * 13 + 1) % 50,
      })), 'demo', 'Demo', `${names[team % names.length]} ${team}`);
    }
  }
  await refresh();
}

// ---------------------------------------------------------------------
async function enterApp() {
  $('#gate').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#whoamiName').textContent = grader.name;
  $('#brandName').textContent = cfg.CONTEST_NAME;
  document.title = `${cfg.CONTEST_NAME} — Staff Portal`;

  wire();
  try { await store.releaseStale(Math.round(cfg.CLAIM_TTL_MS / 1000)); } catch { /* best effort */ }
  await store.heartbeat(grader).catch(() => {});
  await refresh();

  store.onChange((snapshot) => {
    if (snapshot) { data = snapshot; render(); } else refresh();
  });
  startClockTicker();

  setInterval(() => {
    store.heartbeat(grader).catch(() => {});
    if (held) store.claim(held.scope, held.ref, grader, cfg.CLAIM_TTL_MS).catch(() => {});
  }, cfg.HEARTBEAT_MS);

  addEventListener('pagehide', () => { releaseHeld(); });
  $('#individualId').focus();
}

async function boot() {
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
  }
  if (grader.name && await store.hasSession().catch(() => false)) { await enterApp(); return; }

  const submit = async () => {
    const name = nameInput.value.trim();
    if (!name) {
      $('#gateError').textContent = 'We need a name to stamp on your entries.';
      $('#gateError').classList.add('field__hint--error');
      return;
    }
    grader.name = name;
    localStorage.setItem('contest-grader-name', name);
    if (store.mode === 'supabase') {
      try {
        $('#gateEnter').disabled = true;
        await store.signIn(passwordInput.value);
      } catch (err) {
        $('#gateError').textContent = /Invalid/.test(err.message ?? '')
          ? 'That password was not accepted. Check with the contest director.'
          : (err.message || 'Could not sign in.');
        $('#gateError').classList.add('field__hint--error');
        return;
      } finally { $('#gateEnter').disabled = false; }
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
