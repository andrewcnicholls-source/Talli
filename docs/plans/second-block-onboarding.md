# Plan: events catalogue, blocks, and a gate screen that scales

Revised several times on 11 Nov 2026. First written from a read of `staging` at
`4118276` and read-only queries against both Supabase projects; revised
after Andrew set the direction in § 3. Every "today" statement was
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
   available. It says that there are some, never how many.
4. **One price per block.** Each block has a price adjustment per type
   of park, measured from the reference site (86 Paice Ave), set when
   the block is set up. Every site in a block charges the same, so the
   price shown is the price paid. Andrew moves one price (a surge
   decision) and every block follows at its adjustment. Nobody edits an
   individual site's price.
5. **Overselling is for walk-ups only, and only Standard.** A warden can
   sell Standard past its count at the gate, and each extra car comes
   out of Priority's availability. Never out of Valet. Priority and
   Valet are never sold past their own counts. The website still stops
   selling Standard at its count.
6. **Walk-up card payments go through a QR code.** The warden's screen
   shows a QR for a Stripe payment page with the exact amount; the
   customer pays on their own phone. Wardens must not need access to
   Andrew's Stripe account, which the current tap-to-pay route requires.
   Walk-up payment type defaults to cash. Tap-to-pay stays for Andrew
   alone because it is cheaper; opening it to wardens is wanted later
   and is not in this plan.
7. **One event is live at a time.** Andrew marks it live in the event
   manager. Arrivals has no event selector; it shows the live event.
8. **A Sites page replaces the Sites tab and the site controls on
   Tonight** (§ 6, B3).
9. **Wardens have Arrivals and a Site guide, nothing else.** Anything a
   warden must do on the night — including recording a space lost to
   bad parking — lives on Arrivals. The Site guide is the per-site
   directions QR and the marked-up pictures of where to park.
10. **Where a car goes is decided when it arrives.** The warden's own
    site is the default, and it can be any site in the block. An online
    Standard booking is placed, in order: a free Standard space; then a
    Priority space at the warden's current site; then a Priority space
    at another site in the block. Never Valet.
11. **A block's takings are pooled and split 30 / 20 / 50.** For each
    night and block, parking takings are pooled: 30% Talli, 20% the
    warden, 50% the hosts. The hosts' half is shared in proportion to
    the spaces each provided that night. Arrival order, where a car was
    placed, and what price that buyer happened to pay must not change
    what a host earns. A space lost on the night does **not** count for
    its host: marginal spaces only exist if they can be filled, and a
    lost one was a bonus that did not come off. Extras are split 10%
    warden, 90% Talli, which also covers the cost of the goods. Card
    surcharges are outside every pool and are Talli's. A refund comes
    out of the pool for the night it was booked for. The system works
    out the wardens' amount for a block; **Andrew allocates it between
    the wardens himself**, so he can adjust it.
12. **For sport, the series is the team.** "Blues", with each home game
    a night.
13. **The gate screen has one selector that everything follows:** all,
    a block, or a site. Every tab adapts to it.
14. **Automated tests are part of the workflow.** A change comes with
    its tests, and they run on every pull request. The "no test
    framework" rule in `CLAUDE.md` is retired. The tests need a way past
    Google sign-in that exists on test only.
15. **The second block is Gribblehurst Rd: number 70 and number 72.**
    70 is the anchor. Its setup is what the test project holds for
    "TEST Gribblehurst anchor", and 72 takes the test neighbour's: per
    site, 3 Standard all sold online, and 2 Priority with 1 online and
    1 held for the gate; Standard $40, Priority $50, which are the real
    prices for the first night; the host of 70 is Doyle, the host of 72
    is not yet known; 70 at
    -36.880692, 174.742279 and 72 about 20m along. No warden is named
    yet; on test the block goes to the existing warden user. Pictures come later, from
    Andrew.
16. **The first night with the second block is Robbie Williams,
    24 Nov 2026.** See § 5a.
17. **Andrew cannot work both blocks on a night, so a warden runs one
    without him.** That warden has no tap-to-pay. Until QR payments
    exist they take cash or a bank transfer.
18. **The warden's Site guide also carries the bank details** for a
    transfer: account name, account number, and the reference to use,
    which is the location.
19. **"Unfinished" on staging means the things in this plan** — there is
    no other half-built work to finish first.

## 4. Still open — agents stop and ask, do not guess

| # | Question | Default if Andrew says "your call" | Blocks |
| --- | --- | --- | --- |
| Q1 | Who is the warden for the first night, which block do they take, and what Google account will they sign in with? | None. Needed before release. | § 5a |
| Q2 | The bank account name and number wardens should show. Not to be written in this repository: Andrew enters them at release. | None. Needed before release. | § 5a |
| Q3 | A transfer referenced only by location cannot be matched to a car. May the plate go in the bank's "particulars" field beside it? | Yes: reference = location, particulars = plate. | § 5a |
| Q4 | Who is the host of 72 Gribblehurst Rd? | A placeholder name, corrected before the night is settled. | § 5a |

Answered 13 Nov 2026. Personal and bank details stay out of this file:

- **Q1** — a warden is named. Production only; their Google address is
  still to come, and which block they take is still to confirm.
- **Q2** — Andrew has given the account name and number. They are entered
  into production's `bank_transfer_setting` at release, never here.
- **Q3** — yes: reference = location, particulars = plate. The Site info
  tab already says so (R2).
- **Q4** — a placeholder host for 72 Gribblehurst Rd, corrected later.

## 5. Order of work

Most of this plan edits `assets/admin.js` (2,963 lines, one closure) or
`supabase/functions/gate-ops/index.ts` (1,040 lines, one switch). Agents
working in parallel on those two files as they are will spend their time
on merge conflicts. So:

```
P0  one after the other
 │    T0 test foundation and test sign-in
 │    S0 split the two big files, no behaviour change
 │
P1  foundations, one at a time — each restates shared database objects
 │    A1 series model   →   B1 block pricing   →   B2 live event
 │
P2  in parallel, each with its own tests
 │    customer: A2 event pages · A3 booking flow · A4 site guide + QR
 │    gate:     B3 Sites page · B4 walk-up payments · B5 placement,
 │              oversell and lost spaces · B6 the selector ·
 │              B7 settlement · B8 warden access
 │
P3  C1 go-live
```

T0 goes first so that S0 — a 4,000-line reshuffle that must change
nothing — has something to prove it changed nothing.

## 5a. The first night: Robbie Williams, 24 Nov 2026

That is thirteen days from the date of this plan. The whole of § 6 will
not be built, tested and device-tested by then, and it should not be
rushed onto a night with real money. So the first night runs on a small
cut, and the rest follows after it.

What shapes the cut: Andrew will be at one block and a warden, alone,
at the other. That warden signs in with their own Google account, sees
only their block, sells walk-ups, and cannot take a card.

**Build for the first night — four small pieces, in this order:**

| # | Branch | What |
| --- | --- | --- |
| R1 | `walk-up-defaults` | The walk-up form opens on cash. Bank transfer stays one tap away. Tap-to-pay is hidden from a `blocks`-scoped warden. Includes the fix already on the plan's branch: a car's edit sheet listed every site's copy of each parking type. |
| R2 | `site-info-tab` | A second tab for wardens, "Site info", for the site chosen on Arrivals: the address in large type, the directions link, and the bank details — account name, account number, the reference (the location, Q3). The first slice of A4; the card, pictures and printing come later. `gate-ops` must allow a warden this one read and nothing else new. |
| R3 | `bank-details-setting` | Where R2 reads from: two columns on `payment_setting`, returned only by `gate-ops` to a signed-in host or warden. Never in `assets/talli-config.js`, never readable with the anon key, never in this repository. Set by SQL at release; an edit screen comes with B3. |
| R4 | `directions-per-block` | `getting-here.html` takes a block and shows that block's address and map links; the confirmation page and email link to it. Without it a Gribblehurst customer is sent to Paice Ave. |

R1–R3 touch the gate screen and should be one agent, or three in
sequence. R4 is independent.

**Then:**

1. Device-test staging with the Gribblehurst (test) block, signed in
   once as the operator and once as the warden.
2. Release: the migrations from `20261105100000` onward, the edge
   functions, then Pages.
3. On production, from the Sites tab as it is: create the Gribblehurst
   Rd block with 70 (host Doyle) as anchor and 72; 3 Standard and 2
   Priority each, 1 Priority held for the gate; add both to the Robbie
   Williams night at $40 and $50; confirm for sale.
4. Invite the warden: one `host_user` row with `scope = 'blocks'` and
   one `staff_block_access` row, as in
   `supabase/test-only/seed-test-block.sql`. Enter the bank details.
5. One real booking in the new block, followed end to end, and the
   warden signs in on their own phone before the night.

**Worked around by hand that night, not built:**

- *Price shown versus price charged (B1).* It can only go wrong when
  two sites in one block have different adjustments. 70 and 72 are
  priced the same, so it cannot happen.
- *Settlement (B7).* Work out the 30 / 20 / 50 from the night's totals
  by hand. Bank transfers are matched against the bank statement.
- *Warden invitation (B8).* The two rows of SQL above.
- *Overselling and lost spaces (B5).* The warden phones Andrew, who
  adds a space on Tonight.

**If there is time, and only if it is device-tested:** QR card payments
(B4), so the lone warden can take a card. Otherwise cash and bank
transfer, as decided.

**Not for that night:** the events catalogue, the Sites page, the
selector, the file split. T0 can start straight away in parallel, since
it changes nothing the site serves, but it does not gate this release.

Workstream order in § 5 applies to everything after the first night.

## 6. Workstreams

### S0 — `split-admin-and-gate-ops`

- `assets/admin.js` → native ES modules, one per tab plus shared
  helpers, loaded with `<script type="module">`. No bundler.
- `gate-ops/index.ts` → one handler file per area (arrivals, events,
  sites, staff), with the three auth checks and `callerFrom` staying in
  one place that every handler goes through.
- `scripts/check.sh` greps these files by name for the auth checks, the
  bearer token and the absent passphrase. Move the assertions with the
  code; do not loosen them.
- Done when: the browser tests from T0 pass unchanged before and after,
  and `scripts/check.sh` passes with every assertion still present.

### A1 — `event-series`

- `event_series`: slug (unique, the URL), name, kind (concert, sport,
  other), venue, summary, picture, sort order, active. Public read of
  active rows only.
- `event.series_id` and `event.night_label` ("Night 2", "v Hurricanes").
  For sport the series is the team.
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

**Status, 13 Nov 2026: built**, on top of A1. What differs from the
brief above, and why:

- **The booking flow is not on the series page yet.** That is A3. Each
  night links to `/book?event=<id>`, and the booking page now opens
  with that night chosen (or, for one not on sale, the "tell me"
  form). A3 replaces the link with the flow and turns the old link
  round, as its brief says.
- **"From $X" is filled in by the browser** (`assets/events.js`), on
  the catalogue and per night: the cheapest headline type still for
  sale online. When nothing is left it says nothing — the walk-up
  wording needs A3's flag, and guessing would break § 3.3.
- **Statuses.** A night appears while it is `announced` or `on_sale`
  and still to come. `closed` is over and does not appear. The query
  names those statuses as well as relying on the anon policy.
- **The JSON-LD has no `offers`.** Prices load after the page, and
  markup that disagrees with the page is worse than none.
- **The function's copy of the environment switch** is checked against
  `assets/talli-config.js` by running both for a list of hostnames
  (units), and structurally in `scripts/check.sh`, which also keeps
  `_routes.json` equal to the routes in `functions/`.
- `sitemap.xml` is no longer committed. Its static part is
  `STATIC_PAGES` in `functions/_lib/site.js`, which `check.sh` holds
  to the indexable pages exactly as it held the old file.
- **Not yet proven on Cloudflare.** Feature branches are not built, so
  the first real run of a Pages Function is staging after merge. Check
  there: `curl -s https://staging.talli.pages.dev/events` returns the
  list with `X-Robots-Tag: noindex`, and `/sitemap.xml` is XML.

### A3 — `booking-catalogue`

- The flow on a series page: pick the night → pick the block (map and
  cards, as built) → filter by type → details → checkout.
  `create-checkout` and `hold_booking` are unchanged in what they trust.
- Type chips filter the blocks and prices shown. Default is Standard.
- Walk-up state: `v_block_tier_availability` gains a boolean for "held
  for the gate and not yet sold". A type that is sold out online with
  that flag set reads "Sold out online — walk-up spaces on the night",
  with the block's address. Never a count.
- Old links keep working: `book.html?event=<id>` sends the visitor to
  the right series page with that night chosen.
- Done when: on a phone, Bruno Mars night two can be booked in four
  taps to checkout, and a night sold out online shows walk-ups.

**Status, 14 Nov 2026: built**, on top of A2. What differs from the
brief above, and why:

- **Night, then the type chip, then the block.** The chips sit above the
  map and cards and filter them; picking a block is what moves the
  booking on. Standard is on by default, so the usual path is three
  taps: the night, the block, "Continue to payment".
- **The walk-up flag is `walk_ups_on_the_night`** on
  `v_block_tier_availability` (`20261114100000_talli_walk_up_flag`):
  true when a confirmed site in the block has a space of that type held
  for the gate and unsold. A yes/no, so the page cannot show a count.
  `/events` uses it too: a night with nothing left online but gate
  spaces says "Walk-up spaces on the night" instead of nothing.
- **`/book` stays**, and runs the same flow from its own list of nights.
  `/book?event=<id>` is sent to the series page by the browser
  (`assets/booking.js`), not by a Pages Function, so `/book` remains a
  static file; an id with no readable series is chosen on `/book` as
  before.
- **The flow's markup is in two places**: `book.html` and
  `BOOKING_FLOW` in `functions/_lib/site.js`. A unit test fails if
  either is missing an element `booking.js` looks up.
- **Prices are still each block's anchor price.** One price per block is
  B1's guard; until it lands, two sites in a block priced differently
  would show the anchor's figure and charge the site's.
- **Not yet proven on Cloudflare** for the same reason as A2: check the
  series page on staging after merge, on a phone.

### A4 — `site-guide-and-qr`

Andrew holds up a "Locate Us" card many times every event. The one in
use is `docs/plans/reference/locate-us-qr-86-paice.jpg`: a QR code drawn
as a car with a map pin at its centre, the words "Locate Us", and the
address underneath. This
makes that card something the system produces for every site, and that
wardens can reach.

- Each site and block gets a slug and a stable public page on the
  Talli site, `/go/<slug>`. **Scanning opens that page, not Google Maps
  directly:** Andrew sends people to the website on purpose, for the
  directions and to bring them back to book next time. So the page has
  two jobs, in this order on a phone:
  1. Directions: the address, a picture, and large "Open in Google
     Maps" and "Open in Apple Maps" buttons to that site's position —
     one tap from scan to navigation.
  2. Next time: the upcoming events with parking at this block, each
     linking to its series page (A2).
  Walking time to the venue sits with the directions. Data comes from
  `property` and `block`, not from HTML. Because the code points at the
  page, a printed card never needs reprinting if a position is fixed.
- **The card.** Many people do not scan it; they photograph it and
  read it later. So it has to work as a picture, and be recognised at
  a glance as Talli's parking:
  - a car, as in the reference — a standard square code set inside a
    car outline is fine, the car is there for recognition;
  - the name "Talli Parking";
  - "Locate Us" and the address in large type;
  - the page's short web address printed in text, so a photo alone is
    enough to get there.
  Use high error correction, and test every generated card with a
  phone camera at arm's length and from a photo of the card.
- **Site guide**, the second page a warden has: for the site or block
  chosen in the selector (B6), the card full-screen, made to be held up to a driver's
  window. Below it, the marked-up pictures of where and
  how to park (`site_guide_url`, extended to several pictures with
  captions) and the fill notes.
- The Site guide also shows the bank transfer details — account name,
  account number, the reference for that site — built first as R2 and
  R3 in § 5a. The public `/go/` page never shows them.
- The same card prints to A4 from the Sites page, for a sign.
- Pictures upload from the Sites page to a public Storage bucket.
- The confirmation page and email link to the booked block's
  `/go/<slug>` page. `getting-here.html` with nothing chosen lists every active
  block. `eden-park.html` loses its hard-coded walk from 86 Paice Ave.
- Vendor one small QR library under `assets/vendor/`; B4 uses the same.
- The footer's "86 Paice Ave" is the company address and stays.
- A warden sees the guide only for sites in their blocks.
- Done when: a warden opens the guide for their site in two taps, a
  driver scanning it lands on that site's page and reaches navigation
  in one more tap, the page offers the next events to book, and a
  booking in a second block never shows a Paice Ave direction.

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

**Status, 13 Nov 2026: built** (`feature/block-pricing`), on top of A3.
What differs from the brief above, and why:

- **The database does the following, not `gate-ops`.** `set_tier_price`
  and `apply_price_template` call `apply_price_offsets` before they
  return, so there is no moment at which two sites in a block disagree.
  `gate-ops` no longer makes the second call.
- **The reference block's adjustment is always zero**, refused by name
  (`REFERENCE_BLOCK`) otherwise, and 84 Paice Ave follows 86 exactly.
  A price on any other site is `REFERENCE_PRICE_ONLY`.
- **The adjustments are set from the Sites tab as it is,** under the
  site's details ("Prices in <area>"), until B3 replaces that tab. The
  per-site price difference is gone from it. Tonight shows price
  buttons on the reference site's cards only; the rest say they follow.
- **The checkout guard is `expected_price_cents`**, refused as
  `PRICE_CHANGED` with the new price, and the space given back. A page
  that sends none (one cached from before this change) is not refused:
  it is still charged the database price.
- **An event the reference site does not sell is not re-priced** —
  there is nothing to measure it from, and no price on it can be set.
  Every event today includes 86 Paice Ave.
- **At release:** a new block starts at zero for every type. Gribblehurst
  Rd's adjustments are its $40 / $50 less 86 Paice Ave's prices for that
  night (zero if they match); check them on the Sites tab before it is
  confirmed for sale.

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
- Tap-to-pay is offered to the operator only and hidden from wardens.
- Check `confirm_booking` and the confirmation email behave for a gate
  booking with a placeholder email address.
- Done when: on staging with a test card, a walk-up scans, pays, and
  the warden's list shows paid, with the right surcharge.

### B5 — `placement-oversell-and-lost-spaces`

- **Placement at check-in.** The warden's current site (from the
  selector, B6) is the default, and any site in the block can be chosen.
  For an online Standard booking the screen proposes, in order: a free
  Standard space at the current site, then at another site in the
  block; a Priority space at the current site; a Priority space at
  another site. Never Valet. The warden can override the proposal.
- **Standard spills into Priority, at the gate only.** `sell_at_gate`
  accepts Standard past its count while the block has Priority room,
  taking it in the same order. Priority's availability, online and at
  the gate, is its count minus its sales minus the Standard overflow.
  Priority and Valet are never sold past their own counts. Online
  `hold_booking` is unchanged.
- The sell form defaults to Standard and says when a sale is taking a
  Priority space, and at which site.
- **Lost space:** a warden records "space lost" against a site and type
  with a reason (bad parking, blocked, host's own car). It takes no
  money and is not a booking: its own table, with who and when, and it
  can be undone. It reduces availability everywhere and shows as its own
  line in the night's totals.
- All of it is allowed to a `blocks`-scoped warden, only for their sites.
- Done when: selling one Standard too many removes one Priority from
  the booking page, a lost space does the same and can be undone, and
  the proposal order above holds with two sites in a block.

### B6 — `gate-selector`

- One selector at the top of the gate screen: all, one block, or one
  site. Every tab follows it — the list of parkers, the counts and
  money totals, the sell form's default site, the Site guide, and for
  the operator the Sites page and the night's figures.
- A warden is offered only their blocks and the sites in them, and has
  no "all" unless they hold every block. The server already refuses the
  rest; this does not replace that.
- The choice is remembered per device.
- Done when: totals for each site add up to the block, and blocks to
  all, on every tab.

### B7 — `host-settlement`

- **The rule (§ 3.11),** per night and block:
  - Parking pool = parking takings, less refunds, excluding extras and
    card surcharges. 30% Talli, 20% wardens, 50% hosts.
  - A host's part of the 50% = their spaces provided ÷ the block's
    spaces provided. Spaces provided = the spaces the site was
    confirmed for that night, filled or not, **minus spaces recorded as
    lost** (B5). Talli Limited is a host like any other for 86 Paice Ave.
  - Extras pool = extras takings: 10% wardens, 90% Talli.
  - **Wardens' amount** for a block and night = 20% of parking plus 10%
    of extras. The system stops there. Andrew allocates it between the
    wardens on the settlement screen, which lists who checked in or
    sold in that block as a starting point. The allocation must add up
    to the amount, can be changed until the night is settled, and
    records who set it.
  - Card surcharges: Talli, outside both pools.
  - The percentages are settings, not constants in code, and the values
    in force are stored with each settled night.
- `booking.host_earnings_cents` and `platform_fee_cents` are written at
  hold time from the booked site's host. Under this rule they are wrong
  by design. Stop reading them; compute settlement from the night's
  totals. Leave the columns in place.
- A snapshot of "spaces provided" per site per night is taken when the
  night closes, so a later change to a site's defaults cannot rewrite a
  settled night.
- `host.platform_share` no longer decides anything; stop reading it.
  Editable host details: real email, payout notes. `create_site` today
  writes a placeholder address.
- Report, per night and per block: takings by channel and payment type,
  both pools, each host's spaces and amount owed, the wardens' amount and
  its allocation, and cash held by each warden. Report only. No Stripe Connect here.
- Done when: on test, moving every car to one host's driveway, or
  raising the price halfway through sales, changes no host's figure;
  recording a lost space lowers only that host's; and every night's
  shares add up to its takings to the cent.

### B8 — `warden-access`

- Operator-only actions: list staff, invite by email with blocks, switch
  a block grant on or off, deactivate. A "People" section on the Sites
  page. Today this is SQL (`supabase/test-only/seed-test-block.sql`).
- Must not weaken: the three auth checks, `NO_BLOCKS` for a warden with
  every grant off, and the rule that the email comes from the verified
  token, never the request body.
- `scripts/check.sh`: assert every operator-only action is refused to a
  `blocks`-scoped caller.

### T0 — `test-foundation`

The tests, how they sign in, and where they run. Later workstreams add
to these suites; they do not invent their own.

**Where they run.** Against a local Supabase stack started in CI
(`supabase start`), built from `supabase/migrations/` from empty, with
the edge functions served locally and the site served as static files.
Not against the shared test project: that is Andrew's device-testing
database, and a test run would trample whatever is on his phone.

Building from empty is itself the first test. `supabase/README.md`
records that some migrations reached the test project as raw SQL and
that the ledgers disagree, so the files may not replay cleanly. Fix
that first, with new migrations and no edits to applied ones.

**Four suites.**

| Suite | Tool | Covers |
| --- | --- | --- |
| Database | pgTAP (`supabase test db`) | Two buyers for the last space: one wins. The gate reserve. Hold expiry returns the space. Block pricing and re-pricing. Standard spill into Priority, never Valet. Lost spaces. Settlement arithmetic. The event deletion guard. `anon` reads nothing from `booking`, `host`, `host_user`. Every view keeps `security_invoker`. |
| Functions | `deno test` | `gate-ops` and `check-setup` refuse the anon key, a signed-in non-host, and a warden on an operator action or another block's booking. `create-checkout` never trusts an amount and refuses a price mismatch. `stripe-webhook` rejects a bad signature and handles a repeat once. Stripe is stubbed. |
| Browser | Playwright | Customer: catalogue → night → block → type → checkout → confirmation; sold out online shows walk-ups; the right directions. Gate: check in, place at another site, sell cash, sell by QR, oversell, lost space, selector totals, warden sees one block. On phone, tablet and desktop sizes, with video kept on failure. |
| Units | `node --test` | The front-end modules after S0. `scripts/check-auth.js` moves in here. |

**Getting past Google sign-in.** No bypass in the server code.

- Seeded test users — operator, a warden per block, a warden with every
  grant off, and a signed-in non-host — are created in Supabase Auth
  with a confirmed email and a password, on the local stack and the test
  project. The tests sign in with the password grant and place the
  session where `assets/talli-auth.js` keeps it.
- `gate-ops` then does exactly what it does for a Google session:
  resolve the token, require a confirmed email, look the email up in
  `host_user`. The three checks are exercised, not skipped.
- For device testing as a warden without a second Google account: on
  the test site only, the sign-in screen offers "sign in as a test
  user" with those same accounts.
- **Production must stay Google-only.** The email-and-password provider
  is left off there; that is dashboard configuration, so add it to
  `DEPLOYMENT.md` § 0c. Guards: `scripts/check.sh` asserts the test
  sign-in is behind `TALLI.isTest` and that no seeded address appears in
  a migration; `/release-production` attempts a password sign-in against
  production and stops unless it is refused as disabled.

**Plumbing.**

- A root `package.json` for development tools only. The site still has
  no build step and nothing from `node_modules` is served; confirm
  Cloudflare Pages still deploys the repository as it is.
- `scripts/check.sh` stays the single command and gains the suites, with
  a fast mode that skips the browser run. CI runs all of it on every
  pull request to `staging` and `main`.
- `CLAUDE.md`, `TESTING.md` and the `finish-agent` skill are updated to
  say so.
- Fixtures: extend `supabase/test-only/seed-test-block.sql` — two
  blocks, two or more sites each, different hosts, one series with
  three nights, one night sold out online with gate spaces left.
- Done when: a pull request that breaks the last-space race, drops an
  auth check, or changes a price shown fails CI, and the baseline suite
  passes on `staging` as it stands today.

**Status, 12 Nov 2026: built** (branch `claude/blissful-tesla-bgz5sc`).
What differs from the brief above, and why:

- **The ledger worry did not bite.** Every migration replays from empty
  on a local stack as it stands; no repair migration was needed.
  `check.sh` now proves that on every run.
- **The tools' `package.json` is `tests/package.json`, not the root.**
  Cloudflare Pages installs dependencies when it finds a root
  `package.json`, and could upload `node_modules` as site files. In
  `tests/` it cannot see it, so Pages still deploys the repository as
  it is, with nothing to confirm.
- **The functions suite is `node --test` over HTTP, not `deno test`.**
  It calls the real functions served by the local stack, so the
  language of the test does not matter, and one toolchain is simpler.
  `deno check` stays in CI for the function sources.
- **Stripe is not stubbed inside the functions.** Nothing was added to
  payment code. Locally the Stripe key is a stand-in Stripe refuses,
  which tests that a refused checkout gives its space back; webhooks
  are signed with a local stand-in secret, which tests signatures and
  replays. "create-checkout refuses a price mismatch" belongs to B1,
  which builds that guard, and goes in with it. That a body amount is
  ignored is covered in the database, functions and browser suites.
- **Units hold `talli-auth.js` only** until S0 makes front-end modules.
- **No test password is published.** The local stack has a fixed one
  that opens nothing else; the test project's is chosen by Andrew when
  he seeds the accounts, and the staging sign-in card asks for it.
- **Still for Andrew** (dashboard, no tool reaches it): on `talli-test`,
  Email provider on, sign-ups off, and run
  `supabase/test-only/seed-test-users.sql` with a password of his own
  (DEPLOYMENT.md § 0c); then
  make the CI `check` job a required check on `staging` and `main`.

### C1 — Go-live (Andrew)

1. Device-test staging against the script in `TESTING.md`. Passing
   automated tests do not replace this.
2. `/release-production`: migrations and edge functions first, then
   Pages. This is the first release to carry blocks to production, so
   it is every migration from `20261105100000` onward. After it, check
   `host.is_operator` is true for Talli Limited only.
3. On production: create series and pictures for the upcoming events.
4. Sites page: set up the first block's informal driveways, then the
   second block, its adjustments, its sites and their pictures.
5. Invite the warden. Tick the nights. Confirm each site for sale.
6. One real booking in the new block, followed end to end.

## 7. Rules for every agent on this plan

- Follow `CLAUDE.md`: a worktree on `feature/<task>`, PR base `staging`
  (not GitHub's default), `bash scripts/check.sh` is the validation
  command.
- **A workstream is not done without tests.** Each "done when" above is
  written to be a test: add it to the suites from T0, in the same PR.
- Nothing here is released piecemeal. Do not run `/release-production`.
- Develop against the **test** project only.
- Migrations are additive. Any `create or replace view` re-asserts
  `security_invoker = true` (see `supabase/README.md`).
- `hold_booking`, `v_gate_list`, `v_tier_availability`, `sell_at_gate`
  and `create_gate_event` have each been restated in several migrations.
  Start from the newest definition. P1 is sequential for this reason; in
  P2, B4 and B5 both touch the gate sale path and must agree who goes
  first.
- No test, fixture or helper may weaken a server check to make itself
  pass. If a test cannot sign in honestly, the test is wrong.
- Prices come from the database. Nothing in a request body is an amount.
- What a warden may do is enforced in `gate-ops`. The screen only stops
  offering what the server would refuse.
- Fixtures are invented. Never copy real hosts, customers or addresses
  into test.
