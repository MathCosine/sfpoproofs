# Cowconuts 2026 Annual Math Contest — Staff Portal

Answer entry and live scoring for a two-round contest: a 20-problem individual
round and a 7-set guts round, both auto-graded against an answer key you keep in
the portal. Plus a public guts leaderboard for the projector.

Divisions A and B each sit **their own individual paper and their own guts paper**,
so the key holds four answer sets. A team's guts sets are marked against the key of the
division its ID starts with — `A01` against A's, `B01` against B's.

Two shared passwords, no per-scorer accounts, no monthly bill.

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
own 20-problem individual key and their own 28-answer guts key, both on that division's
tab of the answer key. The guts **point values are shared**: a set's points box appears
on both tabs and typing in one fills in the other, so the two papers can never score a
set differently by accident. A sheet is always marked against the division you picked
for it, and switching the dropdown re-marks it — so a sheet keyed against the wrong
paper shows up as a wall of red rather than a plausible score. A guts set is marked
against the division in its team's ID, and the Guts tab says which key it is using.

**Type a sheet, not a score.** Key the ID, optionally a name, then the 20 answers.
Boxes turn green or red against the answer key as you type, so a mis-keyed digit is
visible before you save.

**The answer boxes behave like a keypad.** Enter moves on, arrows move around,
backspace on an empty box steps back, and pasting a row of numbers spreads it across
the grid. Non-negative integers only; anything else is refused at the box.

**Guts, a set at a time.** Pick a team and a set, key its four answers. Point values
rise by set and are edited in the same place as the key. A team on the imported team
list arrives with its name filled in; any other team is asked for one the first time it
is scored — that is what the public board shows. Once the list is in, a team number that
is not on it is flagged before it is saved, since it is far more likely a misread sheet
than a new team.

**Progress is person by person.** The right-hand panel lists teams with a chip per
contestant and their score, plus seven pips for that team's guts sets. Twenty boxes
per contestant would be unreadable at contest scale; one chip is not.

**Nobody enters the same sheet twice.** Opening a sheet or a set takes a real lock —
an atomic insert, taken over only by you or after two minutes of silence. Anyone else
who lands there is told who has it, and it drops out of their queue.

**Three leaderboards**, split by division: individual, guts, and a combined score.

**A public guts board on its own URL** (`guts.html`) — **Division A and Division B side
by side**, each ranked on its own because each sat its own paper: the top five as cards
with a seven-segment bar showing which sets each team has turned in and which one they
are on, everyone else scrolling beneath, a live clock, and nothing whatsoever from the
staff portal. A team still on 0 shows a dash rather than a place, so a board full of
imported teams before the round does not claim they are all tied for first.
`guts.html?division=A` (or `B`) gives one division the whole screen — top ten on the
left, the rest on the right — for a room with a projector per division; the Run tab
links to both. On a phone the two divisions stack and the page scrolls.

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

**A team list** does for teams what the participant list does for people. Paste it
under Setup → **Teams** — `A01, Cowbell` a line, in any column order, with or without a
header row, or with the division and number in columns of their own (`A, 1, Cowbell`).
Every team on it is on the public board from the start, at 0, and its name fills in at
guts entry and next to the team when a contestant's ID is typed. Names can be corrected
on the list or, by a scorer, at guts entry. A contestant's ID pasted into the team box by
mistake (`A011`) is refused rather than read as team 11, a team with people on the
participant list but no name is called out, and a team can be removed while nothing has
been entered for it. Importing again updates names and leaves disqualifications alone.

**A participant list** fills the name in as an ID is typed. Anyone not on the list simply
leaves the name blank, and a sheet that has already been saved keeps whatever name it was
saved with.

Admin keeps it as one editable line per person — ID, team, name — with a search that
matches any of the three, an add box for one-offs, and a remove on each row. Names save
as you leave the box. Import is folded underneath: **the ID is found wherever it sits in
the line**, so all of these read correctly, with or without a header row:

```
A011, Ada Lovelace
A011, A01, Ada Lovelace
Ada Lovelace, A011
A011<tab>A01<tab>Ada Lovelace
A011,"Lovelace, Ada"
```

Commas, tabs and semicolons separate; quotes protect a comma inside a name; a bare
division column is ignored. A team column that **disagrees** with the ID is reported
rather than quietly dropped — that is a typo worth catching — as is any line with no
readable ID, and every skipped line is listed at once rather than one at a time.
Importing updates anyone already listed and leaves the rest alone. Export gives you the
whole list back as CSV, and **Remove every participant** empties the list and nothing
else — answer sheets, scores, teams and the answer key are untouched.

**Sign-in lists** make the name the second half of the password. One name per line in
Admin; a name must match what they type at the door, give or take case, spacing and
punctuation. An admin name also works at the scorer door. **Leave a list empty and
anyone with that password gets in**, which is the state to keep it in until you have
everybody's name.

With a list filled in, the pair is the credential: knowing the password is not enough
without knowing a name on the list, and knowing a name is not enough without the
password. So **the door gives one sentence for both failures** — *"That name and
password were not accepted"* — and never says which half was wrong, never repeats the
name typed, and never suggests a closer one. The names of people scoring a contest are
not a secret; told which half they already have, somebody holding the other half knows
exactly what to go looking for.

That costs a scorer who mistypes their own name the hint that it was the name, which is
why the printed card tells them to have both written down.

**A reload goes through the same door.** Coming back to a signed-in browser asks the
server who this is — not the browser's own storage, which keeps a session looking alive
for up to an hour after a password change has ended it — and checks the name list again.
Anything short of both is the sign-in screen — but only when the server actually says no.
A reload that cannot reach it at all, in a wifi blink, keeps the session, says it could not
reach the server, and walks straight back in on the next reload without the password; and
signing in with no connection says exactly that, never that the password was wrong.
**Sign out ends that browser's session and
nobody else's**: supabase-js signs out every session on the account by default, which on
a shared account is the whole room, and keeps the session anyway if the server call
fails, so the portal asks for a local sign-out and clears the browser itself regardless.
**The page is built in the scorer's state**, with every admin control hidden until the
account is known to be the admin one; it used to wait for the first load of data to hide
them, so a scorer on a slow connection saw Admin, and one whose load failed kept seeing
it. `npm run test:auth` drives all of this with the real supabase-js against a stand-in
for Supabase Auth; the code before the fix fails eight of its checks. Locked out by a typo in the
list itself? In the SQL Editor:
`update app_settings set admin_names = '' where id = 1;`

**The scorer register** in Admin lists everyone who has signed in, whether they are here
now, and how much each of them keyed. Correcting a name there fixes it on every sheet and
set that person entered, and reaches their own screen within a minute — otherwise their
next check-in would write the old spelling straight back. Removing somebody forgets the
row and releases anything they were holding; it never touches their work. One button
forgets everyone who has been quiet for ten minutes.

**Clear test data** wipes a dry run while keeping your key, settings and participant
list — and, unless you untick the box, the team names. Keeping them lifts any practice
disqualification and drops team rows that never got a name.

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

**Equal scores share a place.** Two people on twenty are both first, and the next
score down is third — on the leaderboard, on the projector board, and in every
exported file. Counting 1, 2, 3 down the rows is the obvious implementation and it is
wrong in a way nobody notices until the medals are being handed out: with a few
hundred papers marked out of twenty, a tie at the top is not the rare case, it is the
normal one. Two firsts are both shown in gold and no silver is awarded.

---

## Setup

### Already set this up? Check it first

Paste [`supabase/verify.sql`](supabase/verify.sql) into the SQL Editor and run it. It
changes nothing and prints a row per check; every row should say OK. Any FAIL means
re-run `schema.sql`, which migrates in place.

### Ready for the day?

[`supabase/preflight.sql`](supabase/preflight.sql) is the one to run the week before and
again on the morning. Read-only, about twenty rows, and every row says **GO**, **FIX**, **LOOK**
or **INFO**. It checks the schema is current, the deadlock fix is in, and each division's guts is
marked against its own key; that sign-up is
off, the published key reaches only the public board, and only a director can change the
answer key; that the key is actually filled in and the participant and team lists
loaded, with every ID readable, every team a sensible size and every team named; that the clock is parked and no
rehearsal data or stale locks are lying about; and it estimates the day's realtime
messages and egress against the free-tier allowances from the row counts it finds.

```
Schema is complete                                   GO    all ten tables and all six functions are here
Each division's guts is marked against its own key   GO    28 guts rows for A, 28 for B
The answer key is filled in                          FIX   40 still unset (guts B 28, individual B 12)
The participant list is loaded                       GO    176 on the list — A: 88 in 22 teams, B: 88 in 22 teams
The team names are loaded                            GO    A: 22 of 22 named, B: 22 of 22 named
Realtime messages, estimated for the day             INFO  about 296,000 of the 2,000,000 a month (15%)
```

### Not sure what has been run in there?

[`supabase/whatran.sql`](supabase/whatran.sql) is the companion, for when a script
meant for a different project may have landed here. Also read-only. It lists anything
in the database this contest did not create, anything of ours that is missing, and —
from `pg_stat_statements`, which Supabase has on by default — the statements the
database has actually been asked to run, destructive ones first. It also says whether
any of those strays can be read with the anon key, because that key ships with the
site: a table from another project arrives under its own rules, not ours, and one with
row level security switched off is readable by anyone who opens the page.

If what it finds is another project's schema, [`supabase/undo-pip.sql`](supabase/undo-pip.sql)
is the shape of the cure: it removes one named set of foreign tables and functions and
nothing else. It checks its own removal list against the contest's ten tables and six
functions before it runs, stops without changing anything if a table it is about to
drop still holds rows, and leaves anything it cannot positively identify alone —
printing it, with its source, for you to judge.

It looks hardest at the one script that can really hurt: the clean-up block at the
bottom of `schema.sql`, meant for reusing the old proof-grading project. Four of the
six table names it drops belong to this contest too, so running it here takes the
teams, locks, scorers and settings while leaving the answer sheets standing. Re-running
`schema.sql` afterwards puts the tables back empty and everything *looks* fine — so the
check that matters is the one for answer sheets whose team row is gone, which cannot
happen any other way. Your own history is worth reading beside it: SQL Editor → the
list in the left sidebar.

This matters because the schema has changed since the first version: the answer key
was split by division, the public board gained set progress, the functions were
closed to anonymous callers, and — most recently — the public-board rebuild was made
to run one at a time. That last one is worth re-running for on its own: without it,
two scorers saving in the same instant could deadlock in the database and one of them
would lose the save, which is exactly what the opening minutes of grading look like.
`verify.sql` reports it as **Public board rebuilds one at a time**.

Verifying is also the fastest way to find out whether an earlier run actually
applied — the SQL Editor runs a script as one transaction, so a single failing
statement rolls the whole thing back and leaves the database exactly as it was.

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

To **change a password**, use [`supabase/change-passwords.sql`](supabase/change-passwords.sql)
in the SQL Editor — **not** the dashboard's *Send password recovery*. Both accounts have
made-up addresses, so that button emails an inbox that does not exist, and Studio has no
box for typing a new password in directly. Put the two new passwords between the quotes
on the one marked line, run it, and read the four rows it returns; then delete the
snippet from the SQL Editor sidebar, because it now holds the passwords.

It changes both or neither, and refuses — without touching anything — a password under
12 characters, one with a space at either end (pasted, and then untypeable forever), or
the same password for both accounts, which would let a scorer open Admin with the staff
password. It signs out everyone holding an old password, so change them **before** the
day, not during it. The checks are conditions rather than errors on purpose: a failed
statement is copied into the database log with its text, passwords and all, and this one
never fails. Postgres's own statistics record it as `values ($1, $2)`.

Tested against Supabase's shape of the `auth` schema, and the hashes it writes were
checked with `golang.org/x/crypto/bcrypt` — the library Supabase Auth itself signs you in
with: new passwords accepted, old ones refused, the staff password refused at the admin
door, all at bcrypt cost 10, the same cost Supabase Auth writes.

Choose four or five unrelated words over a short scramble: it has to be written on twenty
cards and typed by twenty people, so leave out anything that looks like something else
in handwriting — `0` and `O`, `1`, `l` and `I`. Nothing needs redeploying, no data is
touched, and the password is never in this repo.

A database that is one schema run behind does not take the portal down. Reference data
the schema adds later — the participant list — comes back empty with a banner naming the
table to run, and everything else keeps working. A results table genuinely missing is
reported as the setup step it is, rather than as a Postgres error.

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

GitHub Pages caches each file separately for ten minutes, so a browser can end up
holding a new `index.html` with a stale script. Three things stop that biting:

- **Every script URL carries the version** — the page's own `<script>`, and every
  `import` between the scripts (`./scoring.js?v=…`). A new version is a new URL, so an
  update arrives as one piece rather than as whichever files happened to expire first.
  A unit test fails if any of them disagrees with `APP_VERSION`, so bump the version
  everywhere at once: `index.html`, `guts.html`, `assets/config.js`, and the imports
  in `assets/app.js` and `assets/store.js`.
- `APP_VERSION` and `data-app-version` in the HTML are compared at boot; a mismatch
  shows a banner saying to hard refresh, rather than leaving a panel with its controls
  quietly missing.
- If the script cannot start at all, a few lines of plain script in `index.html` say
  the page is half-updated, instead of leaving a door that does nothing when Enter is
  pressed.

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

**The portal patches, it does not refetch** — including its own writes. Realtime events
are folded into the cached snapshot row by row, and a saved sheet folds in the row it
just sent rather than reloading. Refreshing after each write meant nine table reads and
the whole contest coming back down after every save; that is what made the portal drag
on a real database, where the demo store's localStorage had hidden it. A full reload now
happens only on reconnect and every five minutes as a safety net. Refetching every table on every change is the obvious
implementation and it does not survive contact with a real contest — twenty staff
machines each pulling a couple of hundred kilobytes per keystroke-sized change runs
to gigabytes of egress in an afternoon.

**Nothing is asked for twice.** Opening the portal used to read every table, then read
them all again a second later when the realtime socket finished connecting — double the
cost of opening the page, for every scorer, every reload. The second read now happens
only when the gap it closes is real, which is a reconnect rather than a startup. Saving
a sheet used to ask the server which division a team was in, and saving a guts set used
to make sure the team row existed: both are answered from the snapshot already in hand,
so each is one request instead of two — about eleven hundred round trips across a
contest. And `guts_answers`, much the largest table, is read without the two columns
nothing on the client uses, which is 55% off it raw and a quarter off it compressed.

**The public board only writes rows that changed.** `refresh_guts_public()` upserts
with an `IS DISTINCT FROM` guard, so one guts entry moves one row instead of
rewriting all hundred and emitting a realtime message per team per save.

The public board prefers realtime and falls back to polling only if the socket fails
— for a room of viewers realtime is much the cheaper of the two. Supabase's free tier
allows 200 concurrent realtime connections; that is plenty for a projector and the
scoring team, but it is not a link to post to every competitor at once.

### Twenty scorers, costed

Both tables below are measured, not guessed: the payloads by serialising a contest of
each size and gzipping it, the messages by counting one realtime message per changed
row per subscribed client, which is what Supabase actually bills.

| Six hours, twenty scorers, three board screens | This contest<br>44 teams, 176 sheets | Full size<br>100 teams, 400 sheets |
| --- | --- | --- |
| One full load of the whole contest | 157 KB raw · **9 KB gzipped** | 350 KB · **19 KB** |
| Twenty tabs opening it | 0.2 MB | 0.4 MB |
| The five-minute resync, twenty tabs, six hours | 13 MB | 26 MB |
| **Against a 5 GB monthly allowance** | **well under 1%** | **well under 1%** |

Egress is not the binding limit — **realtime messages are**, and they are dominated by
the two things every tab writes on a timer rather than by anything anyone types. Each
changed row fans out to every open screen, so one tab writing on a timer costs twenty
messages across a room of twenty scorers:

| Per six-hour contest, twenty scorers | This contest | Full size |
| --- | --- | --- |
| Saying "still here" — every 60 s, not 20 | 144,000 | 144,000 |
| Locks: claimed, released, and renewed at ⅔ of their life | 127,000 | 152,000 |
| The saves themselves, row by row | 30,000 | 67,000 |
| The public board following the standings | 7,000 | 16,000 |
| **Against the two-million monthly allowance** | **~308,000 · 15%** | **~379,000 · 19%** |

Note what that table says: **the contest could be three times the size and still fit**,
because the two timers dominate and they scale with the number of scorers, not with the
number of papers. An earlier version of this section put the full-size figure at
277,000 by counting a four-row guts save as one message and leaving lock traffic out
altogether; 379,000 is what it actually comes to.

On the old cadence — both timers firing every twenty seconds — the same contest came to
about 890,000, or 45% of the month's allowance in one afternoon. Nothing about the lock
changed: it still lasts two minutes and still frees a walked-away sheet on its own. It
is simply not rewritten four times inside each of those two minutes.

Concurrent connections land near 25 against 200. **Nothing here needs a paid plan.** The
resync also pauses entirely in a tab nobody is looking at.

The one free-tier limit that has nothing to do with size: **a free project pauses after
about a week with nothing touching it**, and waking it is a manual restore that takes a
few minutes. Open the portal once in the week before the contest and again on the
morning, so it is awake when the room is. `supabase/preflight.sql` says so on every
run, because it is the failure that has nothing to do with anything you did. The browser tests run twenty
real tabs signing in, colliding on one sheet and saving at the same instant, and
`npm run test:db` repeats the collision from twenty separate connections against a real
Postgres — so the behaviour is measured rather than estimated, on both sides of the
wire.

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
npm test               # 109 unit tests: scoring, the clock, realtime patching, lock contention
npm run test:e2e       # 248 browser checks, including twenty scorers at once
npm run test:db        # 28 checks: twenty connections racing a real Postgres, and the password change
npm run test:auth      # 29 checks: the real Supabase sign-in path, with the real supabase-js
SCREENSHOTS=1 npm run test:e2e   # ...and refresh the images in docs/
```

**Twenty scorers at once** is covered from three sides, because each one misses what
the others catch:

| | what it runs | what it proves |
|---|---|---|
| `npm test` | the lock logic against the Postgres contract | the rules are right |
| `npm run test:e2e` | twenty real browser tabs, twenty identities | the portal behaves |
| `npm run test:db` | twenty connections against a real Postgres | the database holds |

The third is the one that matters on contest day, and the one the others cannot
reach: the browser tabs share a single Web Locks API inside one browser, whereas
twenty laptops in a gym share nothing but the database. So `test:db` applies
`supabase/schema.sql` verbatim to a throwaway Postgres and fires the portal's exact
statements from twenty connections timed to land in the same instant — one sheet
claimed by twenty (exactly one wins, nineteen are told who has it), an abandoned
sheet (taken over once, not twenty times), a sheet still being worked on (renews for
its holder, blocks everyone else), twenty sheets at once (nobody waits), twenty
saves landing together, twenty guts sets firing the public-board trigger at once
(no deadlock), and twenty scorers arriving together. It also runs
`change-passwords.sql` against Supabase's shape of `auth.users`, because that is the one
script where a mistake locks the whole room out: five kinds of bad input must each leave
both accounts untouched, and a real change must refuse the old passwords and refuse the
staff password at the admin door.

It earned its keep immediately: twenty saves landing together deadlocked in the
database roughly one storm in three, and a scorer whose save lost that coin toss got
an error instead of a saved paper. Two rebuilds of the public board were walking the
same rows in different orders. `refresh_guts_public()` now takes a transaction-level
advisory lock before it touches a row, so rebuilds queue instead of colliding. A
rebuild measures about 3 ms at full contest size, so twenty of them queued behind
each other cost a twentieth of a second. And because "usually passes" is not a
regression test, the suite also checks the serialisation directly: hold one rebuild
open, and a second must wait.

It needs a database:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:db
```

CI brings up its own `postgres:16` for it, so it runs on every push.

The unit tests cover where a mistake would silently produce a wrong winner: blank
versus wrong versus unkeyed answers, zero as a real answer, rising guts points, the
weighting, disqualification, the clock in both its stored forms, the freeze
threshold, and the realtime cache patching. The browser suite drives the whole
entry flow, the public board, and the locking, and asserts it never contacts a live
Supabase project.

## On the day

[`scorer-card.html`](scorer-card.html) is a one-page reference to print for each of the
twenty people scoring: how to sign in, how to read a contestant ID, what to do about a
blank versus a zero versus a digit nobody can read, what "someone else has this sheet"
means, and what to do when a screen misbehaves. It fits one side of Letter or A4, and
the password is deliberately not on it — write it in by hand, so a card left on a desk
is not a way in. There is a link to it in Admin, beside the scorer list.

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
scorer-card.html        one printed page per scorer, for the day
supabase/schema.sql     paste into the Supabase SQL editor
tests/                  unit tests + a two-tab browser test
```

---

The SFPO 2026 proof-grading portal this grew out of is preserved at commit
`ea105c7`, if it is ever wanted again.
