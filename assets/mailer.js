// =====================================================================
//  Emailing the score reports, from a Google account connected here.
//
//  The reports are saved once as a PDF from the report tab -- the very
//  pages that print -- and dropped back in. Every page is read, and a
//  page is only ever sent if it says whose it is and still shows the
//  portal's numbers for them. A page for the wrong student, or a PDF saved
//  before a score or a tiebreak changed, stops the whole send: a report
//  that reaches the wrong family cannot be called back.
//
//  Nothing leaves this browser tab except the emails themselves. The
//  Google sign-in lasts an hour and is never saved; the addresses are
//  pasted in and never reach the database. What is remembered between
//  visits is which IDs were already sent to, so a second run carries on
//  instead of sending everyone a copy again.
// =====================================================================

import { parseIndividualId, nameKey } from './scoring.js?v=2026.09.30.1';
import { reportFingerprint } from './reports.js?v=2026.09.30.1';

// ---------------------------------------------------------------------
// Reading the saved PDF
// ---------------------------------------------------------------------

/** Text as compared: spacing, case and letter-spacing gaps ignored. */
const squash = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, '').toLowerCase();

const STUDENT_ID_RE = /(?<![A-Za-z0-9])[AB](?:0[1-9]|[1-9]\d)[1-9](?![0-9])/g;
const TEAM_KEY_RE = /Team\s*([AB](?:0[1-9]|[1-9]\d))(?![0-9])/g;

/**
 * Whose report one page of the PDF is, from its text: a student page
 * names one contestant ID, a team page one team. Anything else -- a
 * blank page, half of a report that ran onto a second sheet, a page that
 * names two people -- is nobody's, and is never sent.
 */
export function identifyPage(text) {
  const flat = squash(text);
  const student = flat.includes('individualscorereport');
  const team = flat.includes('teamscorereport');
  if (student === team) return { kind: null };
  const ids = student
    ? [...new Set(String(text).match(STUDENT_ID_RE) ?? [])]
    : [...new Set([...String(text).matchAll(TEAM_KEY_RE)].map((m) => m[1]))];
  return ids.length === 1 ? { kind: student ? 'student' : 'team', id: ids[0] } : { kind: null, ids };
}

/** Which page each report is on, and every page that is nobody's. */
export function indexPages(texts, kind) {
  const pageOf = new Map();
  const problems = [];
  texts.forEach((text, i) => {
    const page = identifyPage(text);
    if (page.kind !== kind) {
      problems.push(page.kind
        ? `page ${i + 1} is a ${page.kind} report, not a ${kind} one`
        : page.ids?.length > 1
          ? `page ${i + 1} names ${page.ids.join(' and ')}`
          : `page ${i + 1} does not say whose report it is — did a report run onto a second page?`);
      return;
    }
    if (pageOf.has(page.id)) {
      problems.push(`${page.id} is on page ${pageOf.get(page.id) + 1} and again on page ${i + 1}`);
      return;
    }
    pageOf.set(page.id, i);
  });
  return { pageOf, problems };
}

const reportKey = (r) => (r.kind === 'team' ? r.team : r.id);

/**
 * The pages checked against the reports as the portal would print them
 * now. `stale` is a page whose name, score or place is no longer right;
 * `extra` is a page for somebody who no longer gets a report at all.
 * Either means the PDF is out of date.
 */
export function checkPages(reports, pageOf, texts) {
  const found = new Map();
  const stale = [];
  const missing = [];
  for (const r of reports) {
    const at = pageOf.get(reportKey(r));
    if (at == null) { missing.push(reportKey(r)); continue; }
    const flat = squash(texts[at]);
    const off = reportFingerprint(r).filter((f) => !flat.includes(squash(f)));
    if (off.length) stale.push({ id: reportKey(r), page: at + 1, off });
    else found.set(reportKey(r), at);
  }
  const current = new Set(reports.map(reportKey));
  const extra = [...pageOf.keys()].filter((k) => !current.has(k));
  return { found, stale, missing, extra };
}

// ---------------------------------------------------------------------
// Who it goes to
// ---------------------------------------------------------------------

const EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
const WORD_RE = /^[\p{L}][\p{L}'’.-]*$/u;
const HEADER_WORD_RE = /^(id|name|email|e-mail|student|contestant|parent|guardian|division|team|first|last|full|score)$/i;

const isExactId = (c) => {
  const p = parseIndividualId(c);
  return p.ok && p.id === c.toUpperCase().replace(/[\s\-_.]/g, '');
};

/**
 * Addresses pasted from the registration sheet: a line per student with
 * their ID and one or more emails anywhere on it -- a whole row copied
 * across is fine. Any words on the line are kept too, so a line whose
 * name is not the student's can be caught: it is how a mistyped ID shows.
 * The same ID on two lines with different addresses is not guessed at.
 */
export function parseRecipients(text) {
  const byId = new Map();
  const problems = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const emails = [...new Set((line.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))];
    const rest = line.replace(EMAIL_RE, ' ');
    const cells = rest.split(/[\t,;]+|\s+/).map((c) => c.trim()).filter(Boolean);
    const ids = [...new Set(cells.filter(isExactId).map((c) => parseIndividualId(c).id))];
    if (!ids.length) {
      if (emails.length) problems.push(`${line.slice(0, 60)} (no student ID on this line)`);
      continue;
    }
    if (ids.length > 1) { problems.push(`${line.slice(0, 60)} (two IDs on one line: ${ids.join(', ')})`); continue; }
    const [id] = ids;
    if (!emails.length) { problems.push(`${id} (no email address on the line)`); continue; }
    const words = cells.filter((c) => !isExactId(c) && WORD_RE.test(c) && !HEADER_WORD_RE.test(c)
      && c.replace(/[^\p{L}]/gu, '').length > 1);
    const before = byId.get(id);
    if (before) {
      const same = before.emails.length === emails.length && emails.every((e) => before.emails.includes(e));
      if (!same) before.conflict = true;
      continue;
    }
    byId.set(id, { id, emails, words, conflict: false });
  }
  return { byId, problems };
}

/** Whether the words on a pasted line could be this student's name. */
export function nameFits(name, words) {
  if (!words?.length || !nameKey(name)) return true;
  const theirs = new Set(nameKey(name).split(' '));
  return words.some((w) => nameKey(w).split(' ').some((part) => part.length > 1 && theirs.has(part)));
}

/**
 * Who gets what. `studentPages` and `teamPages` are the checked pages
 * (report key -> page index); `teamPages` is null when no team PDF is
 * attached. A student is held back rather than sent whenever there is
 * any doubt about the address.
 */
export function planEmails({ students, studentPages, teamPages = null, recipients }) {
  const ready = [];
  const held = [];
  const noEmail = [];
  const notPrinted = [];
  for (const r of students) {
    const page = studentPages.get(r.id);
    if (page == null) { notPrinted.push(r.id); continue; }
    const rec = recipients.get(r.id);
    if (!rec) { noEmail.push(r.id); continue; }
    if (rec.conflict) { held.push({ id: r.id, why: 'on two lines with different emails' }); continue; }
    if (!nameFits(r.name, rec.words)) {
      held.push({ id: r.id, why: `the line says “${rec.words.join(' ')}”, the portal has “${r.name}”` });
      continue;
    }
    const teamPage = teamPages ? teamPages.get(String(r.team)) : null;
    if (teamPages && teamPage == null) {
      held.push({ id: r.id, why: `no page for team ${r.team} in the team PDF` });
      continue;
    }
    ready.push({ report: r, to: rec.emails, page, teamPage });
  }
  const known = new Set(students.map((r) => r.id));
  const noReport = [...recipients.keys()].filter((id) => !known.has(id));
  return { ready, held, noEmail, notPrinted, noReport };
}

// ---------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------

export const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || 'there';

/** {name}, {first}, {id}, {division}, {team}, {team_name}, {contest}. */
export function fillTemplate(template, fields) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (all, k) => (k in fields ? String(fields[k] ?? '') : all));
}

export function templateFields(report, contest) {
  return {
    name: report.name || report.id,
    first: firstName(report.name),
    id: report.id,
    division: report.division,
    team: report.team,
    team_name: report.teamName || `Team ${report.team}`,
    contest,
  };
}

const utf8 = (s) => new TextEncoder().encode(s);

export function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

const wrap76 = (b64) => b64.replace(/.{1,76}/g, '$&\r\n');

/**
 * A header value, as RFC 2047 encoded words when it is not plain ASCII:
 * short enough each to stay within the 75-character limit, and never
 * splitting a character between two of them.
 */
export function encodeHeader(value, { force = false } = {}) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ');
  if (!force && /^[\x20-\x7e]*$/.test(text)) return text;
  const words = [];
  let chunk = '';
  for (const ch of text) {
    if (utf8(chunk + ch).length > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${bytesToBase64(utf8(w))}?=`).join('\r\n ');
}

/** "Name <address>", the name encoded or quoted as it needs to be. */
function mailbox(name, address) {
  if (!name) return address;
  const plain = /^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]*$/.test(name);
  return `${plain ? name : encodeHeader(name, { force: true })} <${address}>`;
}

/**
 * The whole email as MIME text: a plain-text body and the PDFs attached.
 * ASCII throughout, so it can go to Gmail base64url-encoded as it is.
 */
export function buildMessage({ from = '', fromName = '', to, subject, body, attachments = [], boundary }) {
  const b = boundary ?? `=_report_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const lines = [
    ...(from ? [`From: ${mailbox(fromName, from)}`] : []),
    `To: ${to.join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${b}"`,
    '',
    `--${b}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(bytesToBase64(utf8(String(body).replace(/\r?\n/g, '\r\n')))),
  ];
  for (const a of attachments) {
    lines.push(
      `--${b}`,
      `Content-Type: application/pdf; name="${a.filename}"`,
      `Content-Disposition: attachment; filename="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(bytesToBase64(a.bytes)),
    );
  }
  lines.push(`--${b}--`, '');
  return lines.join('\r\n');
}

export const toBase64Url = (ascii) => btoa(ascii).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------------------------------------------------------------------
// In the browser: the PDF tools, Google sign-in, and Gmail
// ---------------------------------------------------------------------

// Vendored, and only fetched once somebody opens a PDF here.
const PDFJS = new URL('./vendor/pdfjs-4.10.38/pdf.min.js', import.meta.url).href;
const PDFJS_WORKER = new URL('./vendor/pdfjs-4.10.38/pdf.worker.min.js', import.meta.url).href;
const PDFLIB = new URL('./vendor/pdf-lib-1.17.1/pdf-lib.esm.min.js', import.meta.url).href;

/**
 * A saved reports PDF: the text of every page, to work out whose each
 * one is, and a way to lift any single page out as a PDF of its own.
 */
export async function openReportsPdf(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdfjs = await import(PDFJS);
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  } catch {
    throw new Error(`${file.name} could not be read as a PDF.`);
  }
  const texts = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    texts.push(content.items.map((it) => (it.str ?? '') + (it.hasEOL ? '\n' : '')).join(''));
    page.cleanup();
  }
  await doc.destroy();
  const { PDFDocument } = await import(PDFLIB);
  const source = await PDFDocument.load(bytes);
  const pages = new Map();
  return {
    name: file.name,
    texts,
    page(index, title) {
      if (!pages.has(index)) {
        pages.set(index, (async () => {
          const out = await PDFDocument.create();
          const [copy] = await out.copyPages(source, [index]);
          out.addPage(copy);
          out.setTitle(title);
          out.setCreator('Contest staff portal');
          return out.save();
        })());
      }
      return pages.get(index);
    },
  };
}

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
export const CLIENT_ID_RE = /^[\w-]+\.apps\.googleusercontent\.com$/;

let gisLoading = null;
/** Google's sign-in script, fetched once, ahead of the click that needs it. */
export function loadGoogle() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  gisLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gisLoading = null;
      s.remove();
      reject(new Error('Could not reach Google sign-in. Check the connection and try again.'));
    };
    document.head.appendChild(s);
  });
  return gisLoading;
}

/**
 * Ask Google for an hour's permission to send mail as the account the
 * person picks. Call it straight from a click, with loadGoogle() already
 * done, or the browser treats Google's window as an unwanted pop-up.
 */
export function connectGoogle(clientId) {
  return new Promise((resolve, reject) => {
    const oauth2 = window.google?.accounts?.oauth2;
    if (!oauth2) { reject(new Error('Google sign-in has not loaded yet. Try again in a moment.')); return; }
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: `${GMAIL_SEND_SCOPE} email`,
      callback: async (resp) => {
        if (resp?.error) {
          reject(new Error(resp.error === 'access_denied'
            ? 'Google was not given permission. Connect again and allow sending email.'
            : `Google sign-in failed: ${resp.error_description || resp.error}.`));
          return;
        }
        if (!oauth2.hasGrantedAllScopes(resp, GMAIL_SEND_SCOPE)) {
          reject(new Error('Google did not grant permission to send email. Connect again and leave '
            + '“Send email on your behalf” ticked.'));
          return;
        }
        let email = '';
        try {
          const who = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${resp.access_token}` },
          });
          if (who.ok) email = (await who.json()).email ?? '';
        } catch { /* the address is for show; sending does not need it */ }
        resolve({
          token: resp.access_token,
          expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000,
          email,
        });
      },
      error_callback: (err) => reject(new Error(
        err?.type === 'popup_closed' ? 'The Google window was closed before it finished.'
          : err?.type === 'popup_failed_to_open'
            ? 'The browser blocked the Google window. Allow pop-ups for this site, then connect again.'
            : `Google sign-in failed (${err?.type ?? 'unknown error'}).`)),
    });
    client.requestAccessToken({ prompt: '' });
  });
}

/** One email through Gmail. Errors carry the status and a plain reason. */
export async function sendGmail(token, raw) {
  let res;
  try {
    res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
  } catch {
    const err = new Error('No connection to Gmail.');
    err.status = 0;
    throw err;
  }
  if (res.ok) return res.json();
  let detail = '';
  let reason = '';
  try {
    const body = await res.json();
    detail = body?.error?.message ?? '';
    reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? '';
  } catch { /* not JSON */ }
  const err = new Error(gmailMessage(res.status, reason, detail));
  err.status = res.status;
  err.reason = reason;
  throw err;
}

function gmailMessage(status, reason, detail) {
  if (status === 401) return 'The Google sign-in has expired. Connect again, then carry on.';
  if (/accessNotConfigured|SERVICE_DISABLED/i.test(`${reason} ${detail}`)) {
    return 'The Gmail API is not turned on for this Google Cloud project. Turn it on (see the README), then try again.';
  }
  if (/dailyLimitExceeded|quota/i.test(`${reason} ${detail}`) && status !== 429) {
    return 'This Google account has reached its daily sending limit. The rest can go tomorrow.';
  }
  if (status === 429) return 'Gmail asked to slow down.';
  if (status === 403) return `Gmail refused: ${detail || reason || 'permission denied'}.`;
  return `Gmail said ${status}${detail ? `: ${detail}` : ''}.`;
}
