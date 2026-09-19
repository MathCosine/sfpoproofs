# Cowconuts 2026 Annual Math Contest — Staff Portal

Answer entry and live scoring for a two-round contest: a 20-problem individual
round and a 7-set guts round, both auto-graded against an answer key you keep in
the portal. Plus a public guts leaderboard for the projector.

No accounts, no per-scorer logins, no monthly bill.

![The entry console and per-contestant progress](docs/screenshot-portal.png)

---

## What it does

**IDs read `A011`** — Division A, team 01, member 1. Type it and the division, team
and member boxes fill themselves in; all three stay editable and rebuild the ID. Each
division numbers its own teams, so `A01` and `B01` are different teams.

**A team's individual score is its best three of four members.** A team of three is
not handicapped, and a fourth member can only help. Every member is still listed; the
counted ones are marked.

**Two shared logins.** Graders use the staff password. A director who needs the Admin
tab or to change the answer key enters the admin password instead, and the database —
not just the browser — is what enforces it: a grader can read the key and cannot
write it, proven by row level security rather than a hidden button. **Sign out** sits
in the top bar, so a grader can hand the laptop over or sign back in as an admin
without hunting for it.

**The two divisions sit different papers.** Division A and Division B each have their
own 20-problem individual key, edited on their own tab. Guts is one paper for
everybody. A sheet is always marked against the division you picked for it, and
switching the dropdown re-marks it — so a sheet keyed against the wrong paper shows
up as a wall of red rather than a plausible score.

**Type a sheet, not a score.** Key the ID, optionally a name, then the 20 answers.
Boxes turn green or red against the answer key as you type, so a mis-keyed digit is
visible before you save.

**The answer boxes behave like a keypad.** Enter moves on, arrows move around,
backspace on an empty box steps back, and pasting a row of numbers spreads it across
the grid. Non-negative integers only; anything else is refused at the box.

**Guts, a set at a time.** Pick a team and a set, key its four answers. Point values
rise by set and are edited in the same place as the key. The first time a team is
scored you give it a name — that is what the public board shows.

**Progress is person by person.** The right-hand panel lists teams with a chip per
contestant and their score, plus seven pips for that team's guts sets. Twenty boxes
per contestant would be unreadable at contest scale; one chip is not.

**Nobody enters the same sheet twice.** Opening a sheet or a set takes a real lock —
an atomic insert, taken over only by you or after two minutes of silence. Anyone else
who lands there is told who has it, and it drops out of their queue.

**Three leaderboards**, split by division: individual, guts, and a combined score.

**A public guts board on its own URL** (`guts.html`) — the top ten as cards on the
left with a seven-segment bar showing which sets each team has turned in and which
one they are on, everyone else scrolling on the right, a live clock, and nothing
whatsoever from the staff portal.

![The public guts board](docs/screenshot-guts-board.png)

**A clock you can actually run.** Start, pause, ±1 minute, reset, and an editable
length — all mid-contest, all reflected on the public board within a second. The
board freezes itself with 10 minutes left (configurable) so the finish is a reveal;
unfreezing publishes everything that happened during the freeze.

**Leaderboards page ten at a time** with arrows, and the individual board has a
**Copy for slides** button that puts the top ten on the clipboard as `ID Name` then
`Score: N`, ready to paste into award slides.

**Statistics export** covers per-problem difficulty (most and fewest solved, percent
correct), per-division mean, median, standard deviation, quartiles and range for both
rounds, and a score distribution.

**Clear answer key** empties both divisions and guts in two deliberate clicks, keeping
the guts point values, which are configuration rather than answers.

**Disqualification** works on a whole team or on **one contestant**. Either way every
answer is kept and the reason goes on the exports. A disqualified team stops ranking
and comes off the public board entirely — a projector in front of the room is no place
to publish the accusation. A disqualified contestant stops ranking, drops off the award
lines and the statistics, and stops counting towards their team's best three; the rest
of their team is untouched. Both are reversible from Admin.

**A participant list** pasted into Admin fills the name in as an ID is typed —
`A011, Ada Lovelace` per line, straight out of a spreadsheet. Anyone not on the list
simply leaves the name blank, and a sheet that has already been saved keeps whatever
name it was saved with.

**Sign-in lists** say who may use each password. One name per line in Admin; a name
must match what they type at the door, give or take case, spacing and punctuation. An
admin name also works at the scorer door. **Leave a list empty and anyone with that
password gets in**, which is the state to keep it in until you have everybody's name.
This is a roster check, not a lock — whoever holds the password could type a listed
name — so it keeps the wrong person out and keeps the name on every sheet one you
recognise. Locked out by a typo? In the SQL Editor:
`update app_settings set admin_names = '' where id = 1;`

**The scorer register** in Admin lists everyone who has signed in, whether they are here
now, and how much each of them keyed. Correcting a name there fixes it on every sheet and
set that person entered, and reaches their own screen within a minute — otherwise their
next check-in would write the old spelling straight back. Removing somebody forgets the
row and releases anything they were holding; it never touches their work. One button
forgets everyone who has been quiet for ten minutes.

**Clear test data** wipes a dry run while keeping your key and settings.

---

## The combined score

Raw points, nothing scaled:

```
team individual = sum of its best three members out of four
combined        = team individual × 3  +  team guts score
```

A perfect team scores **292**: 60 from three perfect papers, tripled to 180, plus 112
from a perfect guts round. The multiplier is a setting — Admin → Contest settings —
so it can be changed on the day and every standing recomputes at once. Hover any
combined score to see the arithmetic; the export carries both halves, the multiplier
and both maxima so a result can be rechecked by hand.

A disqualified contestant's paper is not one of the three.

---

## Setup

### Already set this up? Check it first

Paste [`supabase/verify.sql`](supabase/verify.sql) into the SQL Editor and run it. It
changes nothing and prints a row per check; every row should say OK. Any FAIL means
re-run `schema.sql`, which migrates in place.

This matters because the schema has changed since the first version: the answer key
was split by division, the public board gained set progress, and the functions were
closed to anonymous callers. It is also the fastest way to find out whether an
earlier run actually applied — the SQL Editor runs a script as one transaction, so a
single failing statement rolls the whole thing back and leaves the database exactly
as it was.

### 1. A Supabase project

Free tier. **SQL Editor → New query →** paste all of
[`supabase/schema.sql`](supabase/schema.sql) → **Run**. Safe to re-run.

> Already ran an earlier version? Re-run the file. It migrates the answer key to the
> per-division layout in place: whatever you had typed becomes Division A, and
> Division B starts as a copy of it rather than empty.
>
> Reusing the old SFPO project? Run the DROP block at the bottom of that file first —
> the proof-grading tables are gone. A fresh project is cleaner.

### 2. Two shared accounts

**Authentication → Users → Add user**, twice, ticking **Auto Confirm User** both times:

| Email | Who gets the password | What it opens |
| --- | --- | --- |
| `staff@sfpo.local` | every scorer | entry, leaderboards, exports; the answer key read-only |
| `admin@sfpo.local` | you | all of that, plus Admin and editing the answer key |

Both are typed on the sign-in screen — the staff password in the first box, the admin
password in the second. Neither is in this repo.

To **change a password**: Authentication → Users → the row → ⋯ → **Reset password**,
or edit the user and set a new one. Nothing needs redeploying; everyone signs in again
with the new one. Use something long — four or five unrelated words beats a short
scramble, and it has to be read out to twenty people. The password is never in this
repo, and changing it does not touch any data.

### 2b. Close sign-up — do not skip this

**Authentication → Sign In / Providers → Email → turn off "Allow new users to sign
up".**

The anon key is published with the site, which is fine on its own: every table is
behind row level security that needs a signed-in account. But if self-service sign-up
is left on — it is on by default — anyone who reads the key can create their own
account, land in the `authenticated` role, and get everything a scorer has, including
rewriting scores. The two accounts above are the only ones that should ever exist.
[`supabase/verify.sql`](supabase/verify.sql) lists them back to you, so you can see at
a glance whether a third has appeared.

### 3. Credentials

Either put them in [`assets/config.js`](assets/config.js), or — with nothing to
redeploy — paste them into **Connection settings** on the sign-in screen. Those are
stored in the browser and win over the file, which is the quick path when you rotate
a key mid-contest.

`guts.html` also accepts `?url=…&key=…` so a projector machine can be pointed at a
project without touching storage, and says so on screen when it is, so a doctored
link cannot pass a stranger's numbers off as the contest. **The portal deliberately
ignores those parameters.** It asks for a password, so a link carrying someone else's
project would show the ordinary sign-in screen and post that password straight to
whoever sent the link.

### 4. Publish

**Settings → Pages → Deploy from a branch.** The portal is `/`, the public board is
`/guts.html`.

---

## Weight

A visitor downloads about 35 KB gzipped for the portal and 11 KB for the public board.
Against GitHub Pages' 100 GB/month soft bandwidth limit, a whole contest day — every
scorer reloading repeatedly, the board on a projector — is a rounding error, and the
published site is well under a megabyte against a 1 GB limit. There is nothing to
optimise here; the only real cost is Supabase egress, which is why the portal patches
its cache instead of refetching.

Test screenshots are only written when `SCREENSHOTS=1`, so ordinary runs do not push
half a megabyte of new binaries into git history every time.

## When a deploy looks half-broken

GitHub Pages caches each file separately, so a browser can end up holding a new
`index.html` with a stale script. `APP_VERSION` in `config.js` and `data-app-version`
in the two HTML files are compared at boot; a mismatch shows a banner saying to hard
refresh, rather than leaving a panel with its controls quietly missing. Bump both
together on any deploy that changes markup and script at once.

## Security

The anon key is a public identifier and is meant to ship in client code. Every staff
table denies the anonymous role outright — reading one answer requires the shared
staff sign-in.

None of the database functions are callable without signing in either — PostgREST
exposes every function in the public schema as an RPC, and `refresh_guts_public()` is
SECURITY DEFINER, so `EXECUTE` is revoked from `anon` and granted only to
`authenticated`.

Results exports quote any cell starting with `=`, `+`, `-` or `@`, so a team name
cannot become a formula when somebody opens the CSV in Excel.

Two tables are readable without logging in, because the public board has no login:
`guts_public` (team, name, division, score, solved) and `contest_state` (the clock).
Neither holds an answer or any part of the key, so the board can be on a screen in
the room during the round without leaking anything a team could use.

The portal never takes Supabase credentials from the address bar. It asks for a
password, so a link carrying someone else's project would render the ordinary
sign-in screen and post that password to whoever sent the link. Credentials come
from the file or from the Connection panel, which is an action taken by somebody
already inside.

### What the board's audience can actually reach

The public board is served from the same site as the portal, so anyone who has the
board link can also open the portal — they land on the sign-in screen and go no
further without a password. Handing out the board URL gives away exactly this much,
and it is the full list, verified against the database rather than assumed:

| As the anonymous role | Result |
| --- | --- |
| read `guts_public`, `contest_state` | allowed — the board and the clock |
| read `teams`, `contestants`, `guts_answers`, `answer_key`, `claims`, `graders`, `app_settings` | permission denied |
| write anything at all, including `guts_public` | permission denied |
| call `refresh_guts_public`, `set_guts_frozen`, `release_stale_claims`, `is_admin` | permission denied |

The one thing that would undo all of it is leaving self-service sign-up on, which is
why [closing it](#2b-close-sign-up--do-not-skip-this) is a setup step of its own.

---

## Running on the free tier

Two decisions keep this inside Supabase's free limits with a hall full of people:

**Every table is read in full, not one page of it.** Supabase caps a request at the
project's "Max rows" setting — 1000 by default — and returns the first page with no
error. `guts_answers` reaches 2800 rows at a hundred teams, so a plain select would
have silently dropped two thirds of the guts round. Reads page until they run out.

**The portal patches, it does not refetch.** Realtime events are folded into the
cached snapshot row by row, with a full reload only on reconnect and every five
minutes as a safety net. Refetching every table on every change is the obvious
implementation and it does not survive contact with a real contest — twenty staff
machines each pulling a couple of hundred kilobytes per keystroke-sized change runs
to gigabytes of egress in an afternoon.

**The public board only writes rows that changed.** `refresh_guts_public()` upserts
with an `IS DISTINCT FROM` guard, so one guts entry moves one row instead of
rewriting all hundred and emitting a realtime message per team per save.

The public board prefers realtime and falls back to polling only if the socket fails
— for a room of viewers realtime is much the cheaper of the two. Supabase's free tier
allows 200 concurrent realtime connections; that is plenty for a projector and the
scoring team, but it is not a link to post to every competitor at once.

### Twenty scorers, costed

A six-hour contest at full size — 100 teams, 400 answer sheets, 2,800 guts answers —
with twenty scorers signed in and three board screens running:

| | |
| --- | --- |
| Twenty tabs loading the portal | ~1 MB |
| The five-minute resync, twenty tabs, six hours | ~60 MB |
| Realtime rows for ~1,100 saves, fanned out to twenty | ~7 MB |
| Three board screens following every change | ~60 MB |
| **Total against a 5 GB monthly allowance** | **~130 MB, about 3%** |

Egress is not the binding limit — **realtime messages are**, and they are dominated by
the two things every tab writes on a timer rather than by anything anyone types. Each
write fans out to every open screen, so one tab writing every twenty seconds costs
twenty messages every twenty seconds across a room of twenty scorers:

| Per six-hour contest, twenty scorers | Messages |
| --- | --- |
| Saying "still here" — every 60 s, not 20 | 144,000 |
| Renewing a held lock — at ⅔ of its life, not every tick | 108,000 |
| The ~1,100 actual saves | 22,000 |
| Three board screens following the standings | 3,300 |
| **Total against the two-million monthly allowance** | **~277,000 · 14%** |

On the old cadence — both timers firing every twenty seconds — the same contest came to
about 890,000, or 45% of the month's allowance in one afternoon. Nothing about the lock
changed: it still lasts two minutes and still frees a walked-away sheet on its own. It
is simply not rewritten four times inside each of those two minutes.

Concurrent connections land near 25 against 200. **Nothing here needs a paid plan.** The
resync also pauses entirely in a tab nobody is looking at. The browser tests run twenty
real tabs signing in, colliding on one sheet and saving at the same instant, so the
behaviour is measured rather than estimated.

---

## Locally

```bash
npm run serve          # http://localhost:8000
```

With no credentials the portal runs in **demo mode** — fully working, stored in this
browser, and a second tab acts as a second scorer. **Admin → Load demo data** fills a
plausible half-scored contest. Once credentials *are* configured, `?demo=1` gives the
same sandbox on the live URL, useful for training a scorer without touching real
data. The bar reads **demo mode** in amber throughout.

## Tests

```bash
npm test               # 82 unit tests: scoring, the clock, realtime patching, lock contention
npm run test:e2e       # 189 browser checks, including twenty scorers at once
SCREENSHOTS=1 npm run test:e2e   # ...and refresh the images in docs/
```

Ten scorers at once is covered from both ends: the lock's mutual exclusion is unit
tested against the Postgres contract (ten racing claims on one sheet, exactly one
wins; an abandoned claim can be taken over, a live one cannot), and the browser
suite runs ten real tabs with ten identities entering and saving simultaneously.

The unit tests cover where a mistake would silently produce a wrong winner: blank
versus wrong versus unkeyed answers, zero as a real answer, rising guts points, the
weighting, disqualification, the clock in both its stored forms, the freeze
threshold, and the realtime cache patching. The browser suite drives the whole
entry flow, the public board, and the locking, and asserts it never contacts a live
Supabase project.

## Layout

```
index.html              the staff portal
guts.html               the public leaderboard — no login, no portal data
assets/
  config.js             credentials, round shape, weights
  app.js                entry console, progress, leaderboards, clock
  store.js              Supabase + demo backends, realtime patching
  scoring.js            pure logic — grading, standings, the clock
  csv.js                exports
  styles.css            design system
supabase/schema.sql     paste into the Supabase SQL editor
tests/                  unit tests + a two-tab browser test
```

---

The SFPO 2026 proof-grading portal this grew out of is preserved at commit
`ea105c7`, if it is ever wanted again.
