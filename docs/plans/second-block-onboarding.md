# Plan: events catalogue, blocks, and a gate screen that scales

Revised 11 Nov 2026. First written from a read of `staging` at `4118276`
and read-only queries against both Supabase projects; revised the same
day after Andrew set the direction in § 3. Every "today" statement was
checked on that date; re-check before relying on one.

This file is a brief for agents. Each workstream in § 6 is sized to be
one `/new-agent <task>` branch. Read § 1–5 first whichever one you pick up.

## 1. Words

Andrew uses "zone" two ways. Neither is the code's `zone`.

| Andrew says | In the code | Meaning |
| --- | --- | --- |
| zone / area (of driveways) | `block` | A cluster of nearby driveways one warden covers. What the customer books: "<anchor address> or within 100m". |
| zone / type of park | tier (`offer_tier.code`) | `standard`, `priority`, `valet`. |
| site / property / driveway | `property` | One driveway, with one `host`. |
| — | `zone` | An area inside one property (lawn, berm). Leave alone. |
| event (Bruno Mars) | **series** (new) | The thing people search for. Has a page, a picture, and one or more nights. |
| night / show / fixture | `event` | One date. What a booking is for. |

## 2. Where things stand today

- **Staging is unfinished and is not to be released as it is.** `main`
  is at PR #31; `staging` is eight PRs ahead (#32–#39: blocks, wardens,
  the booking map, the Sites tab). The work in this plan lands on
  `staging` on top of that and is released together when Andrew says so.
- Production keeps running `main` meanwhile. Its database stops at
  `talli_price_one_car` and has no `block` table. Production events
  (next: Robbie Williams, 24 Nov 2026) sell from `86 Paice Ave` only.
- The test project carries everything on `staging`.
- Built on staging, to be kept: the block card and map on the booking
  page, `pick_block_property`, the "anchor or within 100m" wording on
  the confirmation page and email, warden scoping in `gate-ops`
  (`allowedProperties`, `mayTouchBooking`), check-in recording the
  driveway and the warden.
- Built on staging, to be **replaced** by this plan: the Sites tab as it
  is, per-site price offsets, per-site prices and capacities on the
  Tonight tab, the event selector on Arrivals.

## 3. What Andrew has decided

1. **People look for parking for an event, not for parking.** The site
   gets an events catalogue. One page per series, built on request by a
   Cloudflare function so the details are in the HTML Google receives.
   Nights are chosen inside the series page, not given pages of their
   own: "Bruno Mars", then the second concert; "Blues", then the
   Hurricanes game.
2. **The flow is a shopping catalogue:** series → night → block → type
   of park. Standard / Priority / Valet behave as a filter.
3. **Sold out online is not sold out.** When the online share is gone
   but spaces are held for the gate, the page says walk-ups are still
   available.
4. **One price per block.** Each block has a price adjustment per type
   of park, measured from the reference site (86 Paice Ave), set when
   the block is set up. Every site in a block charges the same, so the
   price shown is the price paid. Andrew moves one price (a surge
   decision) and every block follows at its adjustment. Nobody edits an
   individual site's price.
5. **Overselling is for walk-ups only.** A warden can sell Standard past
   its count at the gate, and each extra car comes out of Priority's
   availability. Never out of Valet. The website still stops selling
   Standard at its count.
6. **Walk-up card payments go through a QR code.** The warden's screen
   shows a QR for a Stripe payment page with the exact amount; the
   customer pays on their own phone. Wardens must not need access to
   Andrew's Stripe account, which the current tap-to-pay route requires.
   Walk-up payment type defaults to cash.
7. **One event is live at a time.** Andrew marks it live in the event
   manager. Arrivals has no event selector; it shows the live event.
8. **A Sites page replaces the Sites tab and the site controls on
   Tonight** (§ 6, B3).
9. **Wardens only ever have Arrivals,** so anything a warden must do on
   the night — including recording a space lost to bad parking — lives
   there.

## 4. Still open — agents stop and ask, do not guess

| # | Question | Default if Andrew says "your call" | Blocks |
| --- | --- | --- | --- |
| Q1 | For sport, is the series the team ("Blues", every home game a night) or the competition? | The team. | A1 |
| Q2 | Does a Standard oversell take a Priority space at the same site only, or anywhere in the block? | Same site. | B5 |
| Q3 | Can Priority or Valet ever be sold past their own count at the gate? | No. | B5 |
| Q4 | Host pay. Andrew's note on pricing — "because they work as a block, you all benefit" — reads as takings pooled across a block and shared out, not paid per car per driveway. Which is it, and what is each host's share? | None. Must be answered. | B7 |
| Q5 | Does the public page show how many walk-up spaces are held, or only that there are some? | Only that there are some. | A3 |
| Q6 | Is tap-to-pay removed for everyone once the QR works, or kept for Andrew alone? | Kept for the operator, hidden from wardens. | B4 |
| Q7 | Who supplies event pictures, and are they cleared for use? | Andrew uploads; nothing is scraped. | A1 |
| Q8 | What is the per-site QR code for — a printed sign at the driveway, the confirmation email, or both? | Both: one stable link per site. | A4 |
| Q9 | The second block: name, anchor address, its properties, each host, spaces per type, online share, the warden's Google email. | None. Needed for go-live only. | C3 |
| Q10 | Which night is the first with the second block live? Sets the deadline. | — | C3 |

## 5. Order of work

Most of this plan edits `assets/admin.js` (2,963 lines, one closure) or
`supabase/functions/gate-ops/index.ts` (1,040 lines, one switch). Agents
working in parallel on those two files as they are will spend their time
on merge conflicts. So:

```
P0  split the two big files, no behaviour change      (one agent, first)
 │
P1  foundations, one at a time — each restates shared database objects
 │    A1 series model   →   B1 block pricing   →   B2 live event
 │
P2  in parallel
 │    customer: A2 event pages · A3 booking flow · A4 directions + QR
 │    gate:     B3 Sites page · B4 walk-up payments · B5 oversell and
 │              lost spaces · B6 Arrivals filter · B7 settlement ·
 │              B8 warden access
 │
P3  C1 test fixtures and script · C2 browser tests · C3 go-live
```

## 6. Workstreams

### P0 — `split-admin-and-gate-ops`

- `assets/admin.js` → native ES modules, one per tab plus shared
  helpers, loaded with `<script type="module">`. No bundler.
- `gate-ops/index.ts` → one handler file per area (arrivals, events,
  sites, staff), with the three auth checks and `callerFrom` staying in
  one place that every handler goes through.
- `scripts/check.sh` greps these files by name for the auth checks, the
  bearer token and the absent passphrase. Move the assertions with the
  code; do not loosen them.
- Done when: staging behaves identically on a phone, and
  `scripts/check.sh` passes with every assertion still present.

### A1 — `event-series`

- `event_series`: slug (unique, the URL), name, kind (concert, sport,
  other), venue, summary, picture, sort order, active. Public read of
  active rows only.
- `event.series_id` and `event.night_label` ("Night 2", "v Hurricanes").
  Backfill: every existing event gets a series; the three Bruno Mars
  shows share one.
- Pictures in a public Supabase Storage bucket, uploaded from the event
  manager. Per-night picture optional, falling back to the series'.
- Event manager: create and edit a series, attach nights to it.
- Done when: test holds a series with three nights and a picture, all
  editable from the screen.

### A2 — `event-pages`

- Cloudflare Pages Functions, the site's first server-side code:
  - `/events` — the catalogue: every series with an upcoming night,
    soonest first, with picture, dates and a "from $X".
  - `/events/<slug>` — one series: what, where, when, each night with
    its status, and the booking flow from A3.
  - `/sitemap.xml` — generated, so a new series is listed without a
    deploy. Replaces the committed file.
- In the HTML as served: title, description, canonical link, Open Graph
  picture, and schema.org `Event` JSON-LD per night. Availability and
  prices are loaded in the browser afterwards so a cached page is never
  wrong about what is left.
- The function must pick its Supabase project from the request hostname
  by the same rule as `assets/talli-config.js`, defaulting to test, and
  send `noindex` on every non-production host. Add a `scripts/check.sh`
  assertion that the two host lists agree.
- Home page and navigation link to `/events`.
- Done when: `curl` of a series page on staging returns the event
  details and JSON-LD with no JavaScript run, and a draft or cancelled
  night never appears.

### A3 — `booking-catalogue`

- The flow on a series page: pick the night → pick the block (map and
  cards, as built) → filter by type → details → checkout.
  `create-checkout` and `hold_booking` are unchanged in what they trust.
- Type chips filter the blocks and prices shown. Default is Standard.
- Walk-up state: `v_block_tier_availability` gains a boolean for "held
  for the gate and not yet sold". A type that is sold out online with
  that flag set reads "Sold out online — walk-up spaces on the night",
  with the block's address. Never a count unless Q5 says so.
- Old links keep working: `book.html?event=<id>` sends the visitor to
  the right series page with that night chosen.
- Done when: on a phone, Bruno Mars night two can be booked in four
  taps to checkout, and a night sold out online shows walk-ups.

### A4 — `directions-and-site-qr`

- Each site and block gets a slug and a stable link, `/go/<slug>`, that
  shows that place's address, map links, walking time and site guide.
  Data comes from `property` and `block`, not from HTML.
- The confirmation page and email link to the booked block's page.
- `getting-here.html` with nothing chosen lists every active block.
  `eden-park.html` loses its hard-coded "from 86 Paice Ave" walk time.
- Sites page: a "QR code" button per site and per block that renders the
  code for its link, to download or print. Vendor one small QR library
  under `assets/vendor/`; B4 uses the same one.
- The footer's "86 Paice Ave" is the company address and stays.
- Done when: a booking in a second block never shows a Paice Ave
  direction, and a printed code opens the right site on a phone.

### B1 — `block-pricing`

- `block_tier_offset (block_id, code, offset_cents)`. The reference
  block's offsets are zero.
- `apply_price_offsets` prices every site from its **block's** offset
  for that type. `property.price_offset_cents` stays in the table
  (additive rule) but nothing reads it.
- `set_tier_price` moves the reference price and every block follows.
  Setting a price on a single non-reference site is refused.
- Guard: `create-checkout` receives the price the page displayed as an
  *expectation*, never as an amount, and refuses by name if the held
  booking's `amount_cents` differs.
- Done when: on test, two sites in one block always show and charge the
  same figure, and one surge change re-prices every block.

### B2 — `live-event`

- `event.is_live`, at most one true (partial unique index). Set and
  cleared from the event manager; making one live clears the other.
- `gate-ops`: Arrivals actions resolve the live event on the server. A
  warden cannot name a different event. With none live, Arrivals says so.
- Andrew can still open any event in the event manager.
- Done when: a warden's phone shows the live event with no selector,
  and switching the live event moves every warden on next refresh.

### B3 — `sites-page`

Replaces the Sites tab and removes site capacity and site price controls
from Tonight. Operator only.

- **Site details, all editable:** name, address, host, block, map
  position, walking time, site guide, fill notes, active. A new site is
  created from a Google Places address picker, which fills address and
  position; typing them by hand remains possible. (The Maps key needs
  the Places API enabled and stays referrer-restricted.)
- **Defaults per site:** number of spaces per type, and how many of
  those sell online.
- **Pricing per block:** the adjustment per type from B1.
- **Event availability:** which nights the site sells, as a tick list
  with "all upcoming". A site joins a night `pending`; confirming it for
  sale stays a deliberate tap.
- **Per-night numbers:** the actual spaces for one night, overriding the
  default, never below what is already sold. Filter the page by night.
- New events include every active site at its defaults.
  `default_event_property()` gives way to `reference_property()`.
- Guards: a site with bookings on an upcoming night cannot be
  deactivated or moved block; a block's anchor must be one of its own
  active sites.
- Tonight keeps: event status, the reference price, and the night's
  running picture. Rename it to match what is left.
- Done when: a new site goes from address to on sale at three nights
  with no SQL and no visit to Tonight.

### B4 — `walk-up-payments`

- The walk-up form opens with **cash** selected.
- **Card by QR:** choosing card creates the booking unpaid, then
  `gate-ops` creates a Stripe Checkout Session for exactly what the
  database says is owed (space, extras, card surcharge) and returns its
  link. The screen shows it as a QR. `stripe-webhook` marks it paid; the
  screen shows that within a few seconds. Cancel and expiry return the
  space, using the existing unpaid-booking path.
- The warden never signs in to Stripe. No Stripe key reaches a browser.
- Tap-to-pay: per Q6.
- Check `confirm_booking` and the confirmation email behave for a gate
  booking with a placeholder email address.
- Done when: on staging with a test card, a walk-up scans, pays, and
  the warden's list shows paid, with the right surcharge.

### B5 — `oversell-and-lost-spaces`

- **Standard spills into Priority, at the gate only.** `sell_at_gate`
  accepts Standard past its count while Priority has room (scope per
  Q2). Priority's availability, online and at the gate, becomes its
  count minus its sales minus the Standard overflow. Valet is untouched.
  Online `hold_booking` is unchanged.
- The warden's sell form defaults to Standard and says when a sale is
  taking a Priority space.
- **Lost space:** a warden records "space lost" against a site and type
  with a reason (bad parking, blocked, host's own car). It takes no
  money and is not a booking: its own table, with who and when, and it
  can be undone. It reduces availability everywhere and shows as its own
  line in the night's totals.
- Both are allowed to a `blocks`-scoped warden, only for their sites.
- Done when: selling one Standard too many removes one Priority from
  the booking page, and a lost space does the same and can be undone.

### B6 — `arrivals-filter`

- A filter on Arrivals: all, one block, or one site. The list of
  parkers, the counts and the money totals all follow it.
- A warden is offered only their blocks and the sites in them. The
  server already refuses the rest.
- The choice is remembered per device.
- Done when: totals for each site add up to the block, and blocks to all.

### B7 — `host-settlement`

- Blocked on Q4.
- Editable host details: share, real email, payout notes. `create_site`
  today hard-codes 50% and a placeholder address.
- Per night, per block and per host: cars parked and booked, takings by
  channel and payment type, amount owed, cash held by each warden.
- Report only. No Stripe Connect here.

### B8 — `warden-access`

- Operator-only actions: list staff, invite by email with blocks, switch
  a block grant on or off, deactivate. A "People" section on the Sites
  page. Today this is SQL (`supabase/test-only/seed-test-block.sql`).
- Must not weaken: the three auth checks, `NO_BLOCKS` for a warden with
  every grant off, and the rule that the email comes from the verified
  token, never the request body.
- `scripts/check.sh`: assert every operator-only action is refused to a
  `blocks`-scoped caller.

### C1 — `multi-block-fixtures`

- Extend `supabase/test-only/seed-test-block.sql`: two blocks, two or
  more sites each, different hosts, one warden per block, one series
  with three nights, one night sold out online with gate spaces left.
- A device-test script in `TESTING.md` covering every "done when" above.

### C2 — `browser-tests`  *(needs Andrew's go-ahead)*

- Playwright, against the test project and a dedicated invented series:
  catalogue → night → block → type → checkout → confirmation; price
  charged equals price shown; sold-out-online shows walk-ups.
- Gate screen tests need a host session without Google. That means a
  test-project-only way to mint one, with a `scripts/check.sh` assertion
  that it cannot exist on production.
- This ends the "no test framework" rule in `CLAUDE.md`. Change the rule
  in the same PR, and run the tests in CI beside `scripts/check.sh`.
- It does not replace device testing on staging.

### C3 — Go-live (Andrew)

1. Device-test staging against the script from C1.
2. `/release-production`: migrations and edge functions first, then
   Pages. This is the first release to carry blocks to production, so
   it is every migration from `20261105100000` onward. After it, check
   `host.is_operator` is true for Talli Limited only, and that
   `host.platform_share` holds what it should — production currently
   has `0` for Talli Limited and `1` for the berm host, the reverse of
   the column's description.
3. On production: create series and pictures for the upcoming events.
4. Sites page: set up the first block's informal driveways, then the
   second block, its adjustments, and its sites.
5. Invite the warden. Tick the nights. Confirm each site for sale.
6. One real booking in the new block, followed end to end.

## 7. Rules for every agent on this plan

- Follow `CLAUDE.md`: a worktree on `feature/<task>`, PR base `staging`
  (not GitHub's default), `bash scripts/check.sh` is the validation
  command.
- Nothing here is released piecemeal. Do not run `/release-production`.
- Develop against the **test** project only.
- Migrations are additive. Any `create or replace view` re-asserts
  `security_invoker = true` (see `supabase/README.md`).
- `hold_booking`, `v_gate_list`, `v_tier_availability`, `sell_at_gate`
  and `create_gate_event` have each been restated in several migrations.
  Start from the newest definition. P1 is sequential for this reason; in
  P2, B4 and B5 both touch the gate sale path and must agree who goes
  first.
- Prices come from the database. Nothing in a request body is an amount.
- What a warden may do is enforced in `gate-ops`. The screen only stops
  offering what the server would refuse.
- Fixtures are invented. Never copy real hosts, customers or addresses
  into test.
