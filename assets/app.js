// =====================================================================
//  SFPO 2026 staff grading portal
// =====================================================================

import { CONFIG } from './config.js';
import { createStore } from './store.js';
import { parseGutsCsv, toCsv, downloadCsv } from './csv.js';
import {
  parseContestantId, divisionOfProblem, problemsFor, cellKey,
  indexGrades, summariseCell, liveClaims, divisionByTeam, buildRoster,
  individualStandings, teamProofStandings, gutsStandings, combinedStandings,
  splitByDivision, suggestQueue, progressFor, dqTeams, proofMaxFor,
} from './scoring.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

const cfg = { ...CONFIG };

// ?demo=1 runs a configured portal against browser-local storage instead
// of the real database — for training graders, showing someone the tool,
// and for the browser tests, which must never touch a live contest. The
// top bar says "demo mode" in amber the whole time, so it cannot be
// mistaken for the real thing.
const forceDemo = new URLSearchParams(location.search).has('demo');
const store = createStore(cfg, { forceDemo });

const grader = {
  id: localStorage.getItem('sfpo-grader-id') || crypto.randomUUID(),
  name: localStorage.getItem('sfpo-grader-name') || '',
};
localStorage.setItem('sfpo-grader-id', grader.id);

const QUEUE_LIMIT = 12;
const form = { contestant: null, problem: null, score: null, blockedBy: null };

let data = { settings: null, teams: [], grades: [], guts: [], claims: [], graders: [] };
let derived = null;
let activeTab = 'matrix';
let activeBoard = 'combined';
let heldClaim = null;
let connected = false;

// ---------------------------------------------------------------------
// Toasts
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
// Derivation — everything the UI paints comes from here
// ---------------------------------------------------------------------

function recompute() {
  // Settings saved in the database win over the file defaults, so a
  // head grader can retune mid-contest for everyone at once.
  if (data.settings) {
    if (data.settings.team_count) cfg.TEAM_COUNT = Number(data.settings.team_count);
    if (data.settings.second_read_threshold != null) {
      cfg.SECOND_READ_THRESHOLD = Number(data.settings.second_read_threshold);
    }
    if (data.settings.disagreement_delta != null) {
      cfg.DISAGREEMENT_DELTA = Number(data.settings.disagreement_delta);
    }
    if (data.settings.proof_weight != null) cfg.PROOF_WEIGHT = Number(data.settings.proof_weight);
    if (data.settings.guts_weight != null) cfg.GUTS_WEIGHT = Number(data.settings.guts_weight);
    if (data.settings.guts_max != null) cfg.GUTS_MAX = Number(data.settings.guts_max);
  }

  const byCell = indexGrades(data.grades);
  const claims = liveClaims(data.claims, cfg);
  const divByTeam = divisionByTeam(data.grades, data.teams, data.guts);
  const seen = new Set(data.grades.map((g) => g.contestant_id));
  for (const key of claims.keys()) seen.add(key.split('|')[0]);

  const dq = dqTeams(data.teams);
  const roster = buildRoster(cfg, divByTeam, seen, dq);
  const individuals = individualStandings(data.grades, divByTeam, cfg, dq);
  const teamProof = teamProofStandings(individuals, divByTeam, cfg, dq);
  const guts = gutsStandings(data.guts, divByTeam);
  const combined = combinedStandings(teamProof, data.guts, divByTeam, cfg, dq);

  derived = {
    byCell,
    claims,
    seen,
    dq,
    divByTeam,
    roster,
    individuals,
    teamProof,
    guts,
    combined,
    progress: { A: progressFor('A', roster, byCell, cfg), B: progressFor('B', roster, byCell, cfg) },
    queue: suggestQueue({ roster, byCell, claims, cfg, myGraderId: grader.id, limit: QUEUE_LIMIT }),
  };
}

// ---------------------------------------------------------------------
// The grading form
// ---------------------------------------------------------------------

function currentCellSummary() {
  if (!form.contestant || !form.problem) return null;
  return summariseCell(derived.byCell.get(cellKey(form.contestant.id, form.problem)), cfg);
}

function myExistingRead() {
  if (!form.contestant || !form.problem) return null;
  return (derived.byCell.get(cellKey(form.contestant.id, form.problem)) ?? [])
    .find((g) => g.grader_id === grader.id) ?? null;
}

function renderProblemChips() {
  for (const division of ['A', 'B']) {
    const host = $(`#problems${division}`);
    host.replaceChildren();
    for (const problem of problemsFor(division, cfg)) {
      const chip = el('button', 'chip', problem);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(form.problem === problem));
      if (form.contestant) {
        const summary = summariseCell(
          derived?.byCell.get(cellKey(form.contestant.id, problem)), cfg);
        if (summary.state !== 'ungraded') chip.classList.add('chip--done');
      }
      chip.addEventListener('click', () => selectProblem(problem));
      host.appendChild(chip);
    }
  }
}

function renderScorepad() {
  const host = $('#scorepad');
  host.replaceChildren();
  for (let s = 0; s <= cfg.MAX_SCORE; s += 1) {
    const btn = el('button', 'score', String(s));
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(form.score === s));
    btn.addEventListener('click', () => {
      form.score = form.score === s ? null : s;
      renderScorepad();
    });
    host.appendChild(btn);
  }
}

function renderCellBanner() {
  const host = $('#cellBanner');
  host.replaceChildren();
  $('#editingTag').hidden = true;

  if (!form.contestant || !form.problem) return;

  const key = cellKey(form.contestant.id, form.problem);
  const live = derived.claims.get(key);
  const claim = (live && live.grader_id !== grader.id) ? live : form.blockedBy;
  const summary = currentCellSummary();
  const mine = myExistingRead();

  if (claim && claim.grader_id !== grader.id) {
    const b = el('div', 'banner banner--warn');
    b.append(
      el('div', null, '✋'),
      (() => {
        const d = el('div');
        d.append(
          el('b', null, `${claim.grader_name} is grading this right now`),
          el('span', null, 'Pick something else from “Grade these next” so you are not doing the same proof twice.'),
        );
        return d;
      })(),
    );
    host.appendChild(b);
  }

  // A Division B team being scored on an A problem is almost always a
  // mistyped ID — and submitting it would drag the whole team into the
  // other division. Say so before that happens.
  const teamDivision = derived.divByTeam.get(form.contestant.team);
  const problemDivision = divisionOfProblem(form.problem);
  if (teamDivision && teamDivision !== problemDivision) {
    const b = el('div', 'banner banner--error');
    const d = el('div');
    d.append(
      el('b', null, `Team ${form.contestant.team} is in Division ${teamDivision}, but ${form.problem} is a Division ${problemDivision} problem`),
      el('span', null, 'Check the contestant ID. Submitting this moves the whole team into '
        + `Division ${problemDivision}.`),
    );
    b.append(el('div', null, '⛔'), d);
    host.appendChild(b);
  }

  if (mine) {
    $('#editingTag').hidden = false;
    const b = el('div', 'banner banner--info');
    const d = el('div');
    d.append(
      el('b', null, `You already scored this ${mine.score}`),
      el('span', null, 'Submitting again replaces your own read rather than adding a second one.'),
    );
    b.append(el('div', null, '✎'), d);
    host.appendChild(b);
  } else if (summary.state === 'conflict') {
    const b = el('div', 'banner banner--error');
    const d = el('div');
    d.append(
      el('b', null, `Two reads disagree: ${summary.scores.join(' and ')}`),
      el('span', null, `${summary.graders.join(', ')} — your score settles it.`),
    );
    b.append(el('div', null, '⚠'), d);
    host.appendChild(b);
  } else if (summary.state === 'needs-second') {
    const b = el('div', 'banner banner--warn');
    const d = el('div');
    d.append(
      el('b', null, `${summary.graders[0]} scored this ${summary.score} — second read`),
      el('span', null, `Scores of ${cfg.SECOND_READ_THRESHOLD} and up get a second pair of eyes. Grade it blind, then compare.`),
    );
    b.append(el('div', null, '👀'), d);
    host.appendChild(b);
  } else if (summary.state === 'graded') {
    const b = el('div', 'banner banner--ok');
    const d = el('div');
    d.append(
      el('b', null, `${summary.graders[0]} already scored this ${summary.score}`),
      el('span', null, 'Adding your read turns it into a two-read cell.'),
    );
    b.append(el('div', null, '✓'), d);
    host.appendChild(b);
  }
}

function renderIdEcho() {
  const echo = $('#idEcho');
  const input = $('#contestantId');
  const raw = input.value.trim();

  if (!raw) {
    echo.textContent = 'Team number, then the member letter.';
    echo.classList.remove('field__hint--error');
    input.classList.remove('input--error');
    return;
  }
  const parsed = parseContestantId(raw);
  if (!parsed.ok) {
    echo.textContent = parsed.error;
    echo.classList.add('field__hint--error');
    input.classList.add('input--error');
    return;
  }
  echo.classList.remove('field__hint--error');
  input.classList.remove('input--error');

  const division = derived?.divByTeam.get(parsed.team);
  const done = data.grades.filter((g) => g.contestant_id === parsed.id).length;
  const bits = [`Team ${parsed.team}, member ${parsed.member}`];
  if (division) {
    bits.push(`Division ${division} — ${problemsFor(division, cfg).length} problems`);
  } else {
    bits.push('division not set yet — the problem you pick will set it');
  }
  if (done) bits.push(`${done} already graded`);
  echo.textContent = bits.join(' · ');
}

function setContestant(raw, { focusNext = false } = {}) {
  const parsed = parseContestantId(raw);
  const changed = parsed.ok ? parsed.id !== form.contestant?.id : form.contestant !== null;
  form.contestant = parsed.ok ? parsed : null;
  if (changed) releaseHeldClaim();
  renderIdEcho();
  renderProblemChips();
  renderCellBanner();
  maybeClaim();
  if (focusNext && parsed.ok) $('#feedback').focus();
}

function selectProblem(problem) {
  if (form.problem === problem) return;
  releaseHeldClaim();
  form.problem = problem;
  renderProblemChips();
  renderCellBanner();
  prefillFromMyRead();
  maybeClaim();
}

function prefillFromMyRead() {
  const mine = myExistingRead();
  if (mine) {
    form.score = Number(mine.score);
    $('#feedback').value = mine.feedback ?? '';
  }
  renderScorepad();
}

function clearForm({ keepContestant = false } = {}) {
  releaseHeldClaim();
  if (!keepContestant) {
    form.contestant = null;
    $('#contestantId').value = '';
  }
  form.problem = null;
  form.score = null;
  $('#feedback').value = '';
  renderIdEcho();
  renderProblemChips();
  renderScorepad();
  renderCellBanner();
}

// ---------------------------------------------------------------------
// Claims — "I am on this one"
// ---------------------------------------------------------------------

async function maybeClaim() {
  if (!form.contestant || !form.problem) return;
  const key = cellKey(form.contestant.id, form.problem);
  if (heldClaim === key) return;
  try {
    const result = await store.claim(form.contestant.id, form.problem, grader, cfg.CLAIM_TTL_MS);
    if (result?.ok === false) {
      // Somebody is already reading this one. We do not block the form —
      // a head grader sometimes has to go in anyway — but the warning
      // stays up until they move off the cell.
      form.blockedBy = result.heldBy ?? null;
      heldClaim = null;
      renderCellBanner();
      return;
    }
    form.blockedBy = null;
    heldClaim = key;
    renderCellBanner();
  } catch (err) {
    console.warn('claim failed', err);
  }
}

async function releaseHeldClaim() {
  form.blockedBy = null;
  if (!heldClaim) return;
  const [contestantId, problem] = heldClaim.split('|');
  heldClaim = null;
  try {
    await store.releaseClaim(contestantId, problem, grader.id);
  } catch (err) {
    console.warn('release failed', err);
  }
}

// ---------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------

async function submitGrade() {
  if (!form.contestant) {
    toast('Enter a contestant ID first, like 12C.', 'error');
    $('#contestantId').focus();
    return;
  }
  if (!form.problem) { toast('Pick a problem.', 'error'); return; }
  if (form.score == null) { toast('Pick a score from 0 to 7.', 'error'); return; }

  const division = divisionOfProblem(form.problem);
  const button = $('#submitGrade');
  button.disabled = true;

  try {
    await store.saveGrade({
      contestant_id: form.contestant.id,
      team: form.contestant.team,
      member: form.contestant.member,
      division,
      problem: form.problem,
      score: form.score,
      feedback: $('#feedback').value.trim(),
      grader_name: grader.name,
      grader_id: grader.id,
    });
    toast(`${form.contestant.id} · ${form.problem} → ${form.score}`);

    const contestant = form.contestant;
    const justDid = form.problem;
    await releaseHeldClaim();
    await refresh();

    // Stay on the same contestant and hop to their next ungraded
    // problem — that is how graders actually move through a stack.
    form.score = null;
    $('#feedback').value = '';
    const remaining = problemsFor(division, cfg).filter((p) => {
      if (p === justDid) return false;
      const s = summariseCell(derived.byCell.get(cellKey(contestant.id, p)), cfg);
      return s.state === 'ungraded';
    });
    form.problem = remaining[0] ?? null;
    renderProblemChips();
    renderScorepad();
    renderCellBanner();
    renderIdEcho();
    if (form.problem) maybeClaim();
    else toast(`${contestant.id} is fully graded.`, 'info');
  } catch (err) {
    toast(err.message || 'Could not save that grade.', 'error');
  } finally {
    button.disabled = false;
  }
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
    const anyDivision = derived.roster.A.length + derived.roster.B.length;
    host.appendChild(el('div', 'empty', anyDivision
      ? 'Nothing waiting. Every cell is graded or already claimed.'
      : 'No teams have a division yet. Grade one proof and this queue fills itself in.'));
    return;
  }

  for (const item of derived.queue) {
    const btn = el('button', `suggest__item suggest__item--p${item.priority}`);
    btn.type = 'button';
    btn.append(
      el('span', 'suggest__id', item.contestantId),
      el('span', `tag tag--${item.division.toLowerCase()}`, item.problem),
      el('span', 'suggest__why', item.reason),
    );
    btn.addEventListener('click', () => {
      $('#contestantId').value = item.contestantId;
      setContestant(item.contestantId);
      selectProblem(item.problem);
      $('#feedback').focus();
    });
    host.appendChild(btn);
  }
}

// ---------------------------------------------------------------------
// Coverage matrix
// ---------------------------------------------------------------------

// The matrix is the expensive thing on the page: at 100 teams it is
// ~1,600 cells, and a realtime event arrives every time any grader
// submits. So the DOM is built once per *shape* change (a team joining a
// division, a new member letter appearing) and every data change after
// that only repaints classes and tooltips on cells that already exist.
let matrixShape = null;
const matrixCells = new Map();
const matrixBars = new Map();

function shapeSignature() {
  return ['A', 'B'].map((division) => derived.roster[division]
    .map((t) => `${t.team}.${t.members.map((m) => m.member).join('')}${t.disqualified ? '!' : ''}`)
    .join(',')).join('|');
}

function buildMatrix() {
  const host = $('#matrix');
  host.replaceChildren();
  matrixCells.clear();
  matrixBars.clear();

  for (const division of ['A', 'B']) {
    const entries = derived.roster[division];
    const problems = problemsFor(division, cfg);
    const section = el('div', 'matrix__division');

    const bar = el('div', 'matrix__bar');
    const flagged = el('span', 'tag tag--flag');
    const counter = el('span', 'muted');
    const track = el('div', 'progress');
    const fill = el('div', 'progress__fill');
    track.appendChild(fill);
    bar.append(
      el('span', `tag tag--${division.toLowerCase()}`, `Division ${division}`),
      el('span', 'muted', `${entries.length} teams · ${problems.join(' ')}`),
      el('span', 'spacer'), flagged, counter, track,
    );
    matrixBars.set(division, { flagged, counter, fill });
    section.appendChild(bar);

    const grid = el('div', 'matrix__grid');
    if (!entries.length) {
      grid.appendChild(el('div', 'empty',
        `No teams in Division ${division} yet. A team joins the moment one of its ${division} problems is graded.`));
    }
    for (const entry of entries) {
      const teamCard = el('div', `matrix__team${entry.disqualified ? ' matrix__team--dq' : ''}`);
      const label = el('div', 'matrix__team-no',
        `TEAM ${entry.team}${entry.beyondRange ? ' ⚠' : ''}${entry.disqualified ? ' · DQ' : ''}`);
      if (entry.disqualified) label.title = teamNote(entry.team) || 'Disqualified';
      teamCard.appendChild(label);
      for (const member of entry.members) {
        const row = el('div', 'matrix__row');
        row.appendChild(el('span', 'matrix__who', member.member));
        for (const problem of problems) {
          const cell = el('button', 'cell');
          cell.type = 'button';
          cell.dataset.cid = member.contestantId;
          cell.dataset.problem = problem;
          matrixCells.set(cellKey(member.contestantId, problem), cell);
          row.appendChild(cell);
        }
        teamCard.appendChild(row);
      }
      grid.appendChild(teamCard);
    }
    section.appendChild(grid);
    host.appendChild(section);
  }
}

function paintMatrix() {
  for (const [key, cell] of matrixCells) {
    const [contestantId, problem] = key.split('|');
    const summary = summariseCell(derived.byCell.get(key), cfg);
    const claim = derived.claims.get(key);
    const seen = derived.seen.has(contestantId);

    let cls = 'cell';
    if (summary.state !== 'ungraded') cls += ` cell--${summary.state}`;
    else if (claim) cls += ' cell--claimed';
    else if (!seen) cls += ' cell--absent';
    if (claim?.grader_id === grader.id) cls += ' cell--mine';
    if (cell.className !== cls) cell.className = cls;

    const detail = summary.state === 'ungraded'
      ? (claim ? `${claim.grader_name} is on it` : 'not graded')
      : `${summary.scores.join(' → ')} by ${summary.graders.join(', ')}`;
    const title = `${contestantId} · ${problem} — ${detail}`;
    if (cell.title !== title) {
      cell.title = title;
      cell.setAttribute('aria-label', title);
    }
  }

  for (const division of ['A', 'B']) {
    const bar = matrixBars.get(division);
    if (!bar) continue;
    const progress = derived.progress[division];
    bar.fill.style.width = `${progress.pct}%`;
    bar.counter.textContent = `${progress.done}/${progress.expected}`;
    bar.flagged.textContent = `${progress.flagged} flagged`;
    bar.flagged.hidden = progress.flagged === 0;
  }
}

function renderMatrix() {
  const shape = shapeSignature();
  if (shape !== matrixShape) {
    matrixShape = shape;
    buildMatrix();
  }
  paintMatrix();
  renderUnassigned();
}

function renderUnassigned() {
  const host = $('#unassigned');
  host.replaceChildren();
  const pending = derived.roster.unassigned.filter((t) => t.members.some((m) => m.seen));
  const untouched = derived.roster.unassigned.length - pending.length;

  const note = el('p', 'field__hint');
  note.style.marginTop = '14px';
  note.textContent = untouched
    ? `${untouched} of the ${cfg.TEAM_COUNT} team slots have no grades yet, so they have no division and are not shown. They appear here the moment anyone grades them. Teams that came with fewer than four members simply leave the extra letters blank — that never counts against coverage.`
    : 'Every team slot has been placed in a division.';
  host.appendChild(note);

  if (!pending.length) return;

  const box = el('div', 'banner banner--warn');
  box.style.marginTop = '12px';
  const inner = el('div');
  inner.append(el('b', null, `${pending.length} team(s) graded but with no division`));
  const chips = el('div', 'grader-chips');
  chips.style.marginTop = '8px';
  for (const entry of pending) {
    const chip = el('span', 'grader-chip');
    chip.append(el('span', 'mono', `Team ${entry.team}`));
    for (const division of ['A', 'B']) {
      const btn = el('button', 'btn btn--ghost', division);
      btn.type = 'button';
      btn.addEventListener('click', async () => {
        await store.setTeamDivision(entry.team, division);
        await refresh();
      });
      chip.appendChild(btn);
    }
    chips.appendChild(chip);
  }
  inner.appendChild(chips);
  box.appendChild(inner);
  host.appendChild(box);
}

// ---------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------

function table(headers, rows) {
  const wrap = el('div', 'table-wrap');
  const t = el('table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of headers) {
    const th = el('th', h.num ? 'num' : null, h.label ?? h);
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  t.appendChild(thead);

  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const cell of row) {
      const td = el('td', cell.cls ?? null);
      if (cell.node) td.appendChild(cell.node);
      else td.textContent = cell.text ?? cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  wrap.appendChild(t);
  return wrap;
}

const rankCls = (i) => `rank${i < 3 ? ` rank--${i + 1}` : ''}`;

function teamNote(team) {
  return data.teams.find((t) => t.team === team)?.dq_reason ?? '';
}

/** The combined figure, with its two halves spelled out on hover. */
function combinedCell(r) {
  const cell = el('span', 'mono', r.total.toFixed(2));
  cell.title = `proof ${r.proof}/${r.proofMax} = ${r.proofPct.toFixed(1)}% × ${cfg.PROOF_WEIGHT}\n`
    + `guts ${r.guts ?? 0}/${r.gutsMax || '—'} = ${r.gutsPct.toFixed(1)}% × ${cfg.GUTS_WEIGHT}`;
  return cell;
}

/** Disqualified teams sit below the ranking, scores intact and reasons shown. */
function dqTable(rows, division) {
  const wrap = el('div');
  const head = el('p', 'field__hint');
  head.style.margin = '16px 0 8px';
  head.textContent = `Disqualified in Division ${division} — scores kept for the record, not ranked.`;
  wrap.appendChild(head);
  const t = table(
    ['', 'Team', { label: 'Proof', num: true }, { label: 'Guts', num: true },
      { label: 'Combined', num: true }, 'Reason'],
    rows.map((r) => [
      { text: 'DQ', cls: 'rank' },
      { text: `Team ${r.team}` },
      { text: r.proof.toFixed(1), cls: 'num' },
      { text: r.guts == null ? '—' : r.guts.toFixed(1), cls: 'num' },
      { text: r.total.toFixed(2), cls: 'num' },
      { text: teamNote(r.team) || '—', cls: 'muted' },
    ]),
  );
  t.classList.add('table-wrap--dq');
  wrap.appendChild(t);
  return wrap;
}

function renderWeightPreview() {
  const proof = Number($('#proofWeight').value) || 0;
  const guts = Number($('#gutsWeight').value) || 0;
  const pinned = Number($('#gutsMax').value) || 0;
  const observed = data.guts.length ? Math.max(...data.guts.map((g) => Number(g.score))) : 0;
  const gutsMax = pinned > 0 ? pinned : observed;
  const sum = proof + guts;

  const host = $('#weightPreview');
  host.replaceChildren();
  const d = el('div');
  if (!sum) {
    host.className = 'banner banner--error';
    d.append(el('b', null, 'Both weights are zero'), el('span', null, 'Nothing would be scored.'));
  } else {
    host.className = 'banner banner--info';
    const pp = Math.round((proof / sum) * 100);
    d.append(
      el('b', null, `A perfect team scores ${pp} from proofs and ${100 - pp} from guts.`),
      el('span', null, gutsMax
        ? `Guts is measured out of ${gutsMax}${pinned > 0 ? ' (set by hand)' : ' — the highest score imported so far'}.`
        : 'No guts scores imported yet, so the guts half scores zero for everyone until you import them.'),
    );
  }
  host.appendChild(d);
}

function renderDqList() {
  const host = $('#dqList');
  host.replaceChildren();
  const out = data.teams.filter((t) => t.disqualified).sort((a, b) => a.team - b.team);
  if (!out.length) {
    host.appendChild(el('p', 'field__hint', 'No teams are disqualified.'));
    return;
  }
  for (const team of out) {
    const chip = el('div', 'dq-row');
    const info = el('div');
    info.append(
      el('b', null, `Team ${team.team}`),
      el('span', 'muted', team.dq_reason
        ? `${team.dq_reason}${team.dq_by ? ` — ${team.dq_by}` : ''}`
        : 'no reason recorded'),
    );
    const undo = el('button', 'btn btn--ghost', 'Reinstate');
    undo.type = 'button';
    undo.addEventListener('click', async () => {
      undo.disabled = true;
      try {
        await store.setTeamDq(team.team, { disqualified: false });
        await refresh();
        toast(`Team ${team.team} is back in the standings.`);
      } catch (err) {
        toast(err.message || 'Could not reinstate that team.', 'error');
        undo.disabled = false;
      }
    });
    chip.append(info, undo);
    host.appendChild(chip);
  }
}

function renderBoards() {
  const host = $('#boards');
  host.replaceChildren();

  const note = el('p', 'field__hint');
  note.style.marginBottom = '14px';
  if (activeBoard === 'combined') {
    const gutsMax = derived.combined[0]?.gutsMax || 0;
    note.textContent = `Combined = ${cfg.PROOF_WEIGHT}% of the proof score plus `
      + `${cfg.GUTS_WEIGHT}% of the guts score, each as a share of its own maximum, out of 100. `
      + `Proof is out of ${proofMaxFor('A', cfg)} in Division A and ${proofMaxFor('B', cfg)} in `
      + `Division B; guts is out of ${gutsMax || '—'}`
      + `${cfg.GUTS_MAX > 0 ? ' (set by hand)' : ' (the highest score imported)'}. `
      + 'Hover a combined score to see its two halves.';
  } else if (activeBoard === 'individual') {
    note.textContent = 'One row per contestant, summed across their division’s problems. '
      + 'Two-read cells use the later read.';
  } else {
    note.textContent = 'Straight from the guts CSV import.';
  }
  host.appendChild(note);

  for (const division of ['A', 'B']) {
    host.appendChild(el('h3', null, `Division ${division}`)).style.cssText =
      'font-size:13px;text-transform:uppercase;letter-spacing:.07em;margin:18px 0 9px';

    if (activeBoard === 'combined') {
      const all = splitByDivision(derived.combined)[division];
      const ranked = all.filter((r) => !r.disqualified);
      const out = all.filter((r) => r.disqualified);
      host.appendChild(ranked.length ? table(
        ['#', 'Team', { label: 'Proof', num: true }, { label: 'Guts', num: true },
          { label: 'Combined', num: true }, 'Status'],
        ranked.map((r, i) => [
          { text: String(i + 1), cls: rankCls(i) },
          { text: `Team ${r.team}` },
          { text: r.proof.toFixed(1), cls: 'num' },
          { text: r.guts == null ? '—' : r.guts.toFixed(1), cls: 'num' },
          { node: combinedCell(r), cls: 'num' },
          { text: r.status, cls: 'muted' },
        ]),
      ) : el('div', 'empty', 'Nothing here yet.'));
      if (out.length) host.appendChild(dqTable(out, division));
    } else if (activeBoard === 'individual') {
      const all = splitByDivision(derived.individuals)[division];
      const ranked = all.filter((r) => !r.disqualified);
      const out = all.filter((r) => r.disqualified);
      const problems = problemsFor(division, cfg);
      const header = ['#', 'Contestant', ...problems.map((p) => ({ label: p, num: true })),
        { label: 'Total', num: true }, 'Status'];
      const row = (r, i) => [
        { text: i == null ? 'DQ' : String(i + 1), cls: i == null ? 'rank' : rankCls(i) },
        { text: r.contestantId },
        ...problems.map((p) => ({
          text: r.byProblem[p] ? String(r.byProblem[p].score) : '·', cls: 'num',
        })),
        { text: r.total.toFixed(1), cls: 'num' },
        { text: i == null ? 'disqualified'
          : (r.complete ? (r.openFlags ? `${r.openFlags} flagged` : 'complete') : 'in progress'),
        cls: 'muted' },
      ];
      host.appendChild(ranked.length ? table(header, ranked.map(row))
        : el('div', 'empty', 'Nothing here yet.'));
      if (out.length) {
        const wrap = table(header, out.map((r) => row(r, null)));
        wrap.classList.add('table-wrap--dq');
        host.appendChild(wrap);
      }
    } else {
      const rows = splitByDivision(derived.guts)[division];
      host.appendChild(rows.length ? table(
        ['#', 'Team', { label: 'Guts', num: true }],
        rows.map((r, i) => [
          { text: String(i + 1), cls: rankCls(i) },
          { text: `Team ${r.team}` },
          { text: r.score.toFixed(1), cls: 'num' },
        ]),
      ) : el('div', 'empty', 'No guts scores imported for this division yet.'));
    }
  }

  const orphan = splitByDivision(
    activeBoard === 'individual' ? derived.individuals
      : activeBoard === 'guts' ? derived.guts : derived.combined,
  ).unassigned;
  if (orphan.length) {
    const p = el('p', 'field__hint');
    p.style.marginTop = '16px';
    p.textContent = `${orphan.length} row(s) are waiting on a division — assign them from the coverage matrix.`;
    host.appendChild(p);
  }
}

// ---------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------

function ago(iso) {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

function renderActivity() {
  const online = data.graders.filter(
    (g) => Date.now() - new Date(g.last_seen).getTime() < cfg.CLAIM_TTL_MS);
  $('#onlineCount').textContent = String(Math.max(online.length, 1));

  const chips = $('#graderChips');
  chips.replaceChildren();
  if (!online.length) chips.appendChild(el('span', 'muted', 'Just you so far.'));
  for (const g of online) {
    const chip = el('span', 'grader-chip');
    chip.append(el('span', 'dot dot--live'), el('span', null,
      g.grader_id === grader.id ? `${g.name} (you)` : g.name));
    chips.appendChild(chip);
  }

  const active = $('#activeClaims');
  active.replaceChildren();
  const claims = [...derived.claims.values()];
  if (!claims.length) active.appendChild(el('span', 'muted', 'Nobody has a proof open.'));
  for (const c of claims) {
    const chip = el('span', 'grader-chip');
    chip.append(
      el('span', 'mono', `${c.contestant_id} ${c.problem}`),
      el('span', 'muted', c.grader_id === grader.id ? 'you' : c.grader_name),
    );
    active.appendChild(chip);
  }

  const feed = $('#feed');
  feed.replaceChildren();
  const recent = [...data.grades]
    .sort((a, b) => new Date(b.updated_at ?? b.created_at) - new Date(a.updated_at ?? a.created_at))
    .slice(0, 40);
  if (!recent.length) feed.appendChild(el('div', 'empty', 'No grades entered yet.'));
  for (const g of recent) {
    const item = el('div', 'feed__item');
    item.append(
      el('span', 'feed__score', String(g.score)),
      el('span', 'mono', `${g.contestant_id} ${g.problem}`),
      el('span', 'muted', g.grader_name),
      el('span', 'feed__when', ago(g.updated_at ?? g.created_at)),
    );
    feed.appendChild(item);
  }
}

// ---------------------------------------------------------------------
// Guts import + exports
// ---------------------------------------------------------------------

async function handleGutsCsv(text) {
  const { rows, errors } = parseGutsCsv(text);
  const host = $('#gutsResult');
  host.replaceChildren();

  if (!rows.length) {
    const b = el('div', 'banner banner--error');
    const d = el('div');
    d.append(el('b', null, 'Nothing imported'),
      el('span', null, errors[0] ?? 'No usable rows found. Expected team,score.'));
    b.appendChild(d);
    host.appendChild(b);
    return;
  }

  try {
    await store.importGuts(rows);
    await refresh();
    const b = el('div', 'banner banner--ok');
    const d = el('div');
    d.append(
      el('b', null, `Imported guts scores for ${rows.length} team(s)`),
      el('span', null, `Teams ${rows.slice(0, 6).map((r) => r.team).join(', ')}${rows.length > 6 ? '…' : ''}`),
    );
    b.appendChild(d);
    host.appendChild(b);
    toast(`Guts: ${rows.length} teams imported.`);
  } catch (err) {
    toast(err.message || 'Guts import failed.', 'error');
    return;
  }

  if (errors.length) {
    const b = el('div', 'banner banner--warn');
    b.style.marginTop = '10px';
    const d = el('div');
    d.append(el('b', null, `${errors.length} row(s) skipped`), el('span', null, errors.join(' ')));
    b.appendChild(d);
    host.appendChild(b);
  }
}

function exportGrades() {
  const rows = [...data.grades]
    .sort((a, b) => a.contestant_id.localeCompare(b.contestant_id, undefined, { numeric: true })
      || a.problem.localeCompare(b.problem))
    .map((g) => [g.contestant_id, g.team, g.member, g.division, g.problem, g.score,
      g.feedback, g.grader_name, g.updated_at ?? g.created_at]);
  downloadCsv('sfpo-2026-grades.csv', toCsv(
    ['contestant_id', 'team', 'member', 'division', 'problem', 'score', 'feedback', 'grader', 'graded_at'],
    rows));
}

function exportIndividual() {
  // One file holds both divisions, so every row needs the same width even
  // though Division A has three problems and Division B has five.
  const widest = Math.max(problemsFor('A', cfg).length, problemsFor('B', cfg).length);
  const rows = [];
  for (const division of ['A', 'B']) {
    const problems = problemsFor(division, cfg);
    const ranked = splitByDivision(derived.individuals)[division];
    let rank = 0;
    ranked.forEach((r) => {
      const i = r.disqualified ? null : rank++;
      const cells = problems.map((p) => (r.byProblem[p] ? r.byProblem[p].score : ''));
      while (cells.length < widest) cells.push('');
      rows.push([i == null ? 'DQ' : i + 1, division, r.contestantId, r.team, r.member, ...cells,
        r.total, r.complete ? 'complete' : 'in progress',
        r.disqualified ? 'yes' : 'no', r.disqualified ? teamNote(r.team) : '']);
    });
  }
  downloadCsv('sfpo-2026-individual.csv', toCsv(
    ['rank_in_division', 'division', 'contestant_id', 'team', 'member',
      'p1', 'p2', 'p3', 'p4', 'p5', 'total', 'status', 'disqualified', 'dq_reason'],
    rows));
}

function exportCombined() {
  const rows = [];
  for (const division of ['A', 'B']) {
    const ordered = splitByDivision(derived.combined)[division];
    let rank = 0;
    ordered.forEach((r) => {
      const i = r.disqualified ? null : rank++;
      rows.push([i == null ? 'DQ' : i + 1, division, r.team, r.proof, r.proofMax, r.proofPct.toFixed(2),
        r.guts ?? '', r.gutsMax || '', r.gutsPct.toFixed(2), r.total.toFixed(4), r.status,
        r.disqualified ? 'yes' : 'no', r.disqualified ? teamNote(r.team) : '',
        r.members.map((m) => `${m.contestantId}:${m.total}`).join(' ')]);
    });
  }
  downloadCsv('sfpo-2026-combined.csv', toCsv(
    ['rank_in_division', 'division', 'team', 'proof_total', 'proof_max', 'proof_pct',
      'guts_score', 'guts_max', 'guts_pct', 'combined_total', 'status',
      'disqualified', 'dq_reason', 'member_breakdown'],
    rows));
}

// ---------------------------------------------------------------------
// Render everything
// ---------------------------------------------------------------------

function render() {
  recompute();
  renderProblemChips();
  renderScorepad();
  renderCellBanner();
  renderIdEcho();
  renderSuggestions();
  if (activeTab === 'matrix') renderMatrix();
  if (activeTab === 'leaderboard') renderBoards();
  renderActivity();

  const mine = data.grades.filter((g) => g.grader_id === grader.id).length;
  $('#myCount').textContent = mine ? `${mine} graded by you` : '';

  const teamsWithData = new Set([...data.grades.map((g) => g.team), ...data.guts.map((g) => g.team)]);
  $('#wipeCounts').textContent = data.grades.length || data.guts.length
    ? `${data.grades.length} grades · ${data.guts.length} guts scores · ${teamsWithData.size} teams · ${data.claims.length} open locks`
    : 'Nothing to delete.';
  for (const [id, value] of [['#teamCount', cfg.TEAM_COUNT],
    ['#secondReadThreshold', cfg.SECOND_READ_THRESHOLD],
    ['#disagreementDelta', cfg.DISAGREEMENT_DELTA],
    ['#proofWeight', cfg.PROOF_WEIGHT],
    ['#gutsWeight', cfg.GUTS_WEIGHT],
    ['#gutsMax', cfg.GUTS_MAX]]) {
    const input = $(id);
    if (input !== document.activeElement) input.value = value;
  }
  renderWeightPreview();
  renderDqList();
}

async function refresh() {
  try {
    data = await store.load();
    connected = true;
  } catch (err) {
    connected = false;
    console.error(err);
    toast(err.message || 'Lost the connection to the database.', 'error');
  }
  updateConnectionBadge();
  render();
}

function updateConnectionBadge() {
  const dot = $('#connDot');
  const label = $('#connLabel');
  dot.className = 'dot';
  if (store.mode === 'demo') {
    dot.classList.add('dot--demo');
    label.textContent = 'demo mode';
  } else if (connected) {
    dot.classList.add('dot--live');
    label.textContent = 'live';
  } else {
    dot.classList.add('dot--down');
    label.textContent = 'offline';
  }
}

// ---------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------

function wireMatrix() {
  $('#matrix').addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    $('#contestantId').value = cell.dataset.cid;
    setContestant(cell.dataset.cid);
    selectProblem(cell.dataset.problem);
  });
}

function wireTabs() {
  for (const tab of $$('.tab[data-tab]')) {
    tab.addEventListener('click', () => {
      activeTab = tab.dataset.tab;
      for (const t of $$('.tab[data-tab]')) {
        t.setAttribute('aria-selected', String(t === tab));
      }
      for (const id of ['matrix', 'leaderboard', 'activity', 'setup']) {
        $(`#tab-${id}`).classList.toggle('hidden', id !== activeTab);
      }
      render();
    });
  }
  for (const btn of $$('.tab[data-board]')) {
    btn.addEventListener('click', () => {
      activeBoard = btn.dataset.board;
      for (const b of $$('.tab[data-board]')) {
        b.setAttribute('aria-selected', String(b === btn));
      }
      renderBoards();
    });
  }
}

function wireForm() {
  const idInput = $('#contestantId');
  idInput.addEventListener('input', () => {
    idInput.value = idInput.value.toUpperCase();
    setContestant(idInput.value);
  });
  idInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const parsed = parseContestantId(idInput.value);
    if (!parsed.ok) return;
    // Enter from the ID box jumps straight to the first thing that
    // still needs doing for that contestant.
    const division = derived.divByTeam.get(parsed.team);
    const candidates = division ? problemsFor(division, cfg) : [];
    const next = candidates.find(
      (p) => summariseCell(derived.byCell.get(cellKey(parsed.id, p)), cfg).state === 'ungraded');
    if (next) selectProblem(next);
  });

  $('#submitGrade').addEventListener('click', submitGrade);
  $('#clearForm').addEventListener('click', () => clearForm());

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitGrade(); return; }
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^[0-7]$/.test(e.key)) {
      form.score = Number(e.key);
      renderScorepad();
    }
  });
}

function wireSetup() {
  const drop = $('#gutsDrop');
  const file = $('#gutsFile');
  drop.addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    if (file.files?.[0]) await handleGutsCsv(await file.files[0].text());
    file.value = '';
  });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    const f = e.dataTransfer?.files?.[0];
    if (f) await handleGutsCsv(await f.text());
  });

  $('#saveSettings').addEventListener('click', async () => {
    try {
      const proofWeight = Number($('#proofWeight').value);
      const gutsWeight = Number($('#gutsWeight').value);
      if (proofWeight + gutsWeight <= 0) {
        toast('One of the weights has to be above zero.', 'error');
        return;
      }
      await store.saveSettings({
        team_count: Number($('#teamCount').value) || cfg.TEAM_COUNT,
        second_read_threshold: Number($('#secondReadThreshold').value),
        disagreement_delta: Number($('#disagreementDelta').value),
        proof_weight: proofWeight,
        guts_weight: gutsWeight,
        guts_max: Math.max(0, Number($('#gutsMax').value) || 0),
      });
      await refresh();
      toast('Settings saved for every grader.');
    } catch (err) {
      toast(err.message || 'Could not save settings.', 'error');
    }
  });

  for (const id of ['#proofWeight', '#gutsWeight', '#gutsMax']) {
    $(id).addEventListener('input', renderWeightPreview);
  }

  $('#dqAdd').addEventListener('click', async () => {
    const team = Number($('#dqTeam').value);
    const reason = $('#dqReason').value.trim();
    if (!Number.isInteger(team) || team < 1) {
      toast('Enter the team number to disqualify.', 'error');
      $('#dqTeam').focus();
      return;
    }
    if (!reason) {
      toast('Record a reason — it goes on the results and the export.', 'error');
      $('#dqReason').focus();
      return;
    }
    if (derived.dq.has(team)) {
      toast(`Team ${team} is already disqualified.`, 'info');
      return;
    }
    const button = $('#dqAdd');
    button.disabled = true;
    try {
      await store.setTeamDq(team, { disqualified: true, reason, by: grader.name });
      $('#dqTeam').value = '';
      $('#dqReason').value = '';
      await refresh();
      toast(`Team ${team} disqualified. Its scores are kept.`, 'info');
    } catch (err) {
      toast(err.message || 'Could not disqualify that team.', 'error');
    } finally {
      button.disabled = false;
    }
  });

  $('#exportGrades').addEventListener('click', exportGrades);
  $('#exportIndividual').addEventListener('click', exportIndividual);
  $('#exportCombined').addEventListener('click', exportCombined);

  $('#signOut').addEventListener('click', async () => {
    await releaseHeldClaim();
    await store.signOut();
    localStorage.removeItem('sfpo-grader-name');
    location.reload();
  });

  // Deleting the whole contest is one click away from the export
  // buttons, so it takes a deliberate word to arm it.
  const confirmInput = $('#wipeConfirm');
  const wipeButton = $('#wipeAll');
  confirmInput.addEventListener('input', () => {
    wipeButton.disabled = confirmInput.value.trim().toUpperCase() !== 'ERASE';
  });
  wipeButton.addEventListener('click', async () => {
    if (confirmInput.value.trim().toUpperCase() !== 'ERASE') return;
    wipeButton.disabled = true;
    try {
      await releaseHeldClaim();
      const counts = await store.clearAll();
      confirmInput.value = '';
      clearForm();
      await refresh();
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      toast(total ? `Deleted ${counts.grades} grades and ${counts.guts} guts scores.`
        : 'There was nothing to delete.', 'info');
    } catch (err) {
      toast(err.message || 'Could not clear the data.', 'error');
    } finally {
      wipeButton.disabled = confirmInput.value.trim().toUpperCase() !== 'ERASE';
    }
  });

  // Seeding fake grades only ever makes sense against the local demo store.
  if (store.mode === 'demo') {
    $('#seedDemo').classList.remove('hidden');
    $('#seedDemo').addEventListener('click', async () => { await seedDemo(); toast('Demo data loaded.'); });
  }
}

function wireIdentity() {
  $('#changeName').addEventListener('click', () => {
    const next = prompt('Grading as:', grader.name);
    if (!next || !next.trim()) return;
    grader.name = next.trim();
    localStorage.setItem('sfpo-grader-name', grader.name);
    $('#whoamiName').textContent = grader.name;
    store.heartbeat(grader).catch(() => {});
  });

  const saved = localStorage.getItem('sfpo-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  $('#themeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('sfpo-theme', next);
  });
}

// ---------------------------------------------------------------------
// Demo seed — a believable half-graded contest to click around in
// ---------------------------------------------------------------------

async function seedDemo() {
  const names = ['Priya Raman', 'Dan Whitfield', 'Mei Sato'];
  const ids = ['demo-1', 'demo-2', 'demo-3'];
  let n = 0;
  for (let team = 1; team <= 12; team += 1) {
    const division = team % 2 ? 'A' : 'B';
    const members = ['A', 'B', 'C', 'D'].slice(0, 2 + (team % 3));
    for (const m of members) {
      for (const problem of problemsFor(division, cfg)) {
        n += 1;
        if (n % 4 === 0) continue;               // leave gaps to grade
        const score = (team * 3 + n * 5) % 8;
        const who = n % 3;
        await store.saveGrade({
          contestant_id: `${team}${m}`,
          team,
          member: m,
          division,
          problem,
          score,
          feedback: score >= 5
            ? 'Complete argument; the induction step is airtight.'
            : 'Right idea but the key case is asserted rather than proved.',
          grader_name: names[who],
          grader_id: ids[who],
        });
      }
    }
  }
  await store.importGuts(
    Array.from({ length: 12 }, (_, i) => ({ team: i + 1, score: 40 + ((i * 17) % 55) })));
  await refresh();
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

async function enterApp() {
  $('#gate').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#whoamiName').textContent = grader.name;
  $('#brandName').textContent = cfg.CONTEST_NAME;
  $('#brandSub').textContent = 'Grading Portal';

  wireTabs();
  wireMatrix();
  wireForm();
  wireSetup();
  wireIdentity();

  try { await store.releaseStale(Math.round(cfg.CLAIM_TTL_MS / 1000)); } catch { /* best effort */ }
  await store.heartbeat(grader).catch(() => {});
  await refresh();

  store.onChange(() => { refresh(); });

  setInterval(() => {
    store.heartbeat(grader).catch(() => {});
    if (heldClaim) {
      const [contestantId, problem] = heldClaim.split('|');
      store.claim(contestantId, problem, grader, cfg.CLAIM_TTL_MS).catch(() => {});
    }
    renderActivity();
  }, cfg.HEARTBEAT_MS);

  addEventListener('pagehide', () => { releaseHeldClaim(); });
  $('#contestantId').focus();
}

async function boot() {
  document.title = `${cfg.CONTEST_NAME} — Staff Grading Portal`;
  $('#gateTitle').textContent = cfg.CONTEST_NAME;

  const nameInput = $('#graderName');
  const passwordInput = $('#staffPassword');
  nameInput.value = grader.name;

  if (store.mode === 'demo') {
    $('#gateDemo').classList.remove('hidden');
    $('#passwordField').classList.add('hidden');
  }

  // Already signed in from an earlier shift? Skip straight through.
  if (grader.name && await store.hasSession().catch(() => false)) {
    await enterApp();
    return;
  }

  const submit = async () => {
    const name = nameInput.value.trim();
    if (!name) {
      $('#gateError').textContent = 'We need a name to put on your grades.';
      $('#gateError').classList.add('field__hint--error');
      nameInput.focus();
      return;
    }
    grader.name = name;
    localStorage.setItem('sfpo-grader-name', name);

    if (store.mode === 'supabase') {
      try {
        $('#gateEnter').disabled = true;
        await store.signIn(passwordInput.value);
      } catch (err) {
        $('#gateError').textContent = err.message?.includes('Invalid')
          ? 'That password was not accepted. Check with the head grader.'
          : (err.message || 'Could not sign in.');
        $('#gateError').classList.add('field__hint--error');
        return;
      } finally {
        $('#gateEnter').disabled = false;
      }
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
