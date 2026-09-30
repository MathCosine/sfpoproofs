// =====================================================================
//  Emailing the score reports, from a Google account connected here.
//
//  Each report is drawn here, one at a time as it is sent: the reports
//  are laid out in a hidden frame -- the very document the print tab
//  shows -- and the student's page is photographed at print resolution
//  and set on a Letter page of its own. Before a page is photographed,
//  its words are checked against the student it is for: a report that
//  reaches the wrong family cannot be called back.
//
//  Nothing leaves this browser tab except the emails themselves. The
//  Google sign-in lasts an hour and is never saved; the addresses are
//  pasted in and never reach the database. What is remembered between
//  visits is which IDs were already sent to, so a second run carries on
//  instead of sending everyone a copy again.
// =====================================================================

import { parseIndividualId, nameKey } from './scoring.js?v=2026.09.30.2';
import { reportFingerprint, REPORT_FONTS_URL } from './reports.js?v=2026.09.30.2';

/** Text as compared: spacing, case and letter-spacing gaps ignored. */
const squash = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, '').toLowerCase();

const reportKey = (r) => (r.kind === 'team' ? r.team : r.id);

/**
 * Whether a drawn page says what this report says: who it is for, the
 * score and the place. Checked on every page before it is sent.
 */
export function pageMatches(text, report) {
  const flat = squash(text);
  return reportFingerprint(report).every((f) => flat.includes(squash(f)));
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
 * Who gets an email. A student is held back rather than sent whenever
 * there is any doubt about the address.
 */
export function planEmails({ students, recipients }) {
  const ready = [];
  const held = [];
  const noEmail = [];
  for (const r of students) {
    const rec = recipients.get(r.id);
    if (!rec) { noEmail.push(r.id); continue; }
    if (rec.conflict) { held.push({ id: r.id, why: 'on two lines with different emails' }); continue; }
    if (!nameFits(r.name, rec.words)) {
      held.push({ id: r.id, why: `the line says “${rec.words.join(' ')}”, the portal has “${r.name}”` });
      continue;
    }
    ready.push({ report: r, to: rec.emails });
  }
  const known = new Set(students.map((r) => r.id));
  const noReport = [...recipients.keys()].filter((id) => !known.has(id));
  return { ready, held, noEmail, noReport };
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

// Vendored, and only fetched once a send starts.
const SNAPSHOT = new URL('./vendor/modern-screenshot-4.7.0/modern-screenshot.js', import.meta.url).href;
const PDFLIB = new URL('./vendor/pdf-lib-1.17.1/pdf-lib.esm.min.js', import.meta.url).href;

const LETTER = [612, 792]; // points
const PX_TO_PT = 72 / 96;
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });

let inlinedFonts = null;
/**
 * The report's fonts as CSS with the font files written into it. A page
 * is drawn by the browser from a self-contained picture of it, which
 * cannot fetch anything, so the fonts have to travel inside. Latin
 * subsets only: that is every name on the roster. Resolves to '' when
 * Google Fonts cannot be reached, and the reports are drawn in the
 * system font instead -- laid out in it too, so nothing wraps.
 */
export function inlineReportFonts() {
  inlinedFonts ??= (async () => {
    const res = await fetch(REPORT_FONTS_URL);
    if (!res.ok) throw new Error(`fonts ${res.status}`);
    const css = await res.text();
    const rules = [...css.matchAll(/(?:\/\*\s*([\w-]+)\s*\*\/\s*)?(@font-face\s*\{[^}]*\})/g)]
      .filter((m) => !m[1] || /^latin(-ext)?$/.test(m[1]))
      .map((m) => m[2]);
    if (!rules.length) throw new Error('no fonts');
    // A variable font comes back once per weight, all naming one file: one
    // rule spanning the weights instead, so the file travels once.
    const prop = (rule, name) => new RegExp(`${name}\\s*:\\s*([^;}]+)`).exec(rule)?.[1].trim() ?? '';
    const groups = new Map();
    for (const rule of rules) {
      const key = ['font-family', 'font-style', 'src', 'unicode-range'].map((n) => prop(rule, n)).join('|');
      const weights = prop(rule, 'font-weight').split(/\s+/).map(Number).filter(Number.isFinite);
      const group = groups.get(key);
      if (group) group.weights.push(...weights);
      else groups.set(key, { rule, weights });
    }
    const files = new Map();
    const dataUrl = (url) => {
      if (!files.has(url)) {
        files.set(url, fetch(url).then(async (font) => {
          if (!font.ok) throw new Error(`font ${font.status}`);
          const type = font.headers.get('content-type') || 'font/woff2';
          return `data:${type};base64,${bytesToBase64(new Uint8Array(await font.arrayBuffer()))}`;
        }));
      }
      return files.get(url);
    };
    const inlined = await Promise.all([...groups.values()].map(async ({ rule, weights }) => {
      let out = weights.length
        ? rule.replace(/font-weight\s*:\s*[^;}]+/, `font-weight: ${Math.min(...weights)} ${Math.max(...weights)}`)
        : rule;
      for (const [whole, , url] of rule.matchAll(/url\((['"]?)([^)'"]+)\1\)/g)) {
        out = out.replace(whole, `url(${await dataUrl(url)})`);
      }
      return out;
    }));
    return inlined.join('\n');
  })().catch(() => { inlinedFonts = null; return ''; });
  return inlinedFonts;
}

/**
 * Report pages drawn in this browser as PDFs of their own. `html` is the
 * document the print tab would show, holding every report of one kind;
 * it is laid out once in a hidden frame, fonts and all, and each page is
 * then photographed on demand at print resolution. The page's words are
 * laid invisibly over the picture, so the PDF can still be searched.
 */
export async function createReportRenderer(html, { scale = 2.5, quality = 0.9, fontCss = '' } = {}) {
  // Laid out in exactly the fonts the picture will carry: the inlined ones,
  // or none. A page laid out in one font and drawn in another wraps.
  const source = html
    .replace(/<link[^>]*fonts\.(googleapis|gstatic)\.com[^>]*>/g, '')
    .replace('</head>', () => `<style>${fontCss}</style></head>`);
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = 'position:fixed;left:-12000px;top:0;width:1000px;height:1200px;'
    + 'border:0;opacity:0;pointer-events:none';
  const loaded = new Promise((resolve) => { frame.addEventListener('load', resolve, { once: true }); });
  frame.srcdoc = source;
  document.body.appendChild(frame);
  await loaded;
  const doc = frame.contentDocument;
  // Drawn as a sheet of paper, not as a card on the grey desk the print
  // tab shows: no shadow, and white wherever an edge rounds to a pixel.
  const flat = doc.createElement('style');
  flat.textContent = 'html,body{background:#fff!important;padding:0!important}'
    + '.page{box-shadow:none!important;margin:0!important}.bar-tools{display:none!important}';
  doc.head.appendChild(flat);
  // The fonts, then the report's own fitting of any page that runs long.
  if (doc.fonts) {
    await Promise.race([Promise.all([...doc.fonts].map((f) => f.load().catch(() => {}))), pause(5000)]);
    await Promise.race([doc.fonts.ready, pause(5000)]);
  }
  frame.contentWindow.fit?.();
  const [{ domToJpeg }, { PDFDocument, StandardFonts }] = await Promise.all([import(SNAPSHOT), import(PDFLIB)]);
  const made = new Map();

  async function draw(report, title) {
    const key = reportKey(report);
    const page = [...doc.querySelectorAll('section.page')].find((p) => p.dataset.report === key);
    if (!page) throw new Error(`There is no report page for ${key}.`);
    const words = page.innerText;
    if (!pageMatches(words, report)) {
      throw new Error(`The page drawn for ${key} does not show their current name, score and place.`);
    }
    const jpeg = await domToJpeg(page, {
      scale, quality, backgroundColor: '#ffffff', font: fontCss ? { cssText: fontCss } : false,
    });
    const pdf = await PDFDocument.create();
    const image = await pdf.embedJpg(jpeg);
    const sheet = pdf.addPage(LETTER);
    const width = page.offsetWidth * PX_TO_PT;
    const height = page.offsetHeight * PX_TO_PT;
    const ratio = Math.min(1, LETTER[0] / width, LETTER[1] / height);
    const w = width * ratio;
    const h = height * ratio;
    sheet.drawImage(image, { x: (LETTER[0] - w) / 2, y: (LETTER[1] - h) / 2, width: w, height: h });
    // The words, invisible, so the PDF can be searched and read aloud.
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const printable = (line) => [...line].map((ch) => {
      try { font.encodeText(ch); return ch; } catch { return ' '; }
    }).join('');
    const lines = words.split(/\n+/).map((l) => printable(l.trim())).filter(Boolean);
    const step = Math.min(9, (LETTER[1] - 72) / Math.max(1, lines.length));
    lines.forEach((line, i) => {
      sheet.drawText(line, { x: 36, y: LETTER[1] - 36 - i * step, size: Math.min(7, step), font, opacity: 0 });
    });
    pdf.setTitle(title);
    pdf.setCreator('Contest staff portal');
    pdf.setProducer('Contest staff portal');
    return pdf.save();
  }

  return {
    /** The report as a one-page PDF, drawn once and then reused. */
    pdf(report, title) {
      const key = reportKey(report);
      if (!made.has(key)) {
        made.set(key, draw(report, title).catch((err) => { made.delete(key); throw err; }));
      }
      return made.get(key);
    },
    destroy() { frame.remove(); made.clear(); },
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
