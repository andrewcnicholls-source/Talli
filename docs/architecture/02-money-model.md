# 02 — Money model

Status: first full pass. Supersedes the earlier stub. Reflects the tally
proposed in `10-build-v1.md` §2 — which, if rejected, invalidates §3 onward but
not §1–2.

**Not legal, tax or accounting advice.** §4 and §8 flag the points that need a
NZ lawyer and accountant respectively.

---

## 1. The primary object

**The ledger's primary object is the open bilateral position, not the settled
transaction.** From `01-thesis.md` §7: trust *is* the outstanding stock of
unsettled obligation, so a ledger that nets balances away and stores only
completed transfers destroys the quantity the system exists to grow.

Consequences, unchanged and non-negotiable:

- Positions are per-pair and **open by default**. Settlement is an event, not a
  goal state.
- Obligations are **directional**. `i → j` is a distinct quantity from `j → i`
  and they are never automatically netted. Gross exposure and net position are
  different facts and the system needs both.
- Every position carries an **age**. Age is signal, not staleness.
- Health is measured by volume, age and distribution of open obligation —
  explicitly **not** throughput. A system optimising for settlement burns its own
  asset.

## 2. Unit of account

**NZD throughout. There is no Talli unit.** (Closes Q12/Q98 for V1.)

Nothing in V1 requires one. Inventing a unit would add currency risk, a
conversion surface, an FX-like regulatory question and a marketing burden, in
exchange for nothing the thesis needs. The trust content is in the *position*,
not in the denomination.

Revisit only if a concrete mechanism demands it — most likely candidate is
multilateral clearing at scale (§7), and that's years away.

## 3. The tally

> A **tally** is a non-transferable claim on future goods or services from one
> specific business, bought with money up front, redeemable only in kind.

**Lifecycle.**

```
  OPEN ──partial redemption──▶ OPEN (reduced)
    │
    ├── full redemption ─────▶ CLOSED
    ├── expiry ──────────────▶ LAPSED      (see §8 — consumer law)
    ├── business ceases ─────▶ WRITTEN OFF (member bears it, §6)
    └── forgiveness ─────────▶ RELEASED    (member waives; this is the gift path)
```

`RELEASED` is worth noticing. It's the only state that expresses "keep it, you
needed it more" — the gift preserved inside a hard instrument. It costs nothing
to build and it's the seed of the answer to Q116/Q134.

**Invariants.**

- A position's balance never goes below zero and never increases after issue.
- Redemption events sum to at most the issued face value.
- No position is transferable to a third party in V1 (`10-build-v1.md` §2 rule 1).
- No position is redeemable for cash (rule 2).
- No position accrues yield (rule 3).

**Accounting shape.** Double-entry, event-sourced, append-only. Redemption
writes a new event; nothing mutates. Minimum accounts per business: `tally
liability` (what they owe in goods), `tally revenue recognised` (on redemption).
The member side mirrors it as a claim. The double-entry invariant is testable
and should have a test that runs on every commit.

## 4. Money must never rest with Talli

The single most important architectural consequence of choosing prepaid credit,
and it is easy to get wrong by accident.

If a member's payment lands in a Talli account and is paid out to the business
later, Talli is **holding client funds**. That's float, it invites a stored-value
/ client-money analysis, it needs trust accounting, and it converts a simple
product into a regulated one.

**So: funds settle directly to the business at the moment of purchase.** Talli
routes, never holds. In practice this means Stripe Connect with *direct charges*
onto the business's own connected account, with Talli's fee taken as an
application fee — not separate charges into a Talli balance followed by
transfers out.

This has a real consequence worth stating plainly: **the business has the money
immediately, which is the entire benefit to them, and the member's protection is
therefore the business's continued existence and nothing else.** That's honest
and it must be disclosed at purchase in those words (§6).

Confirm the structure with a lawyer before build (`10-build-v1.md` §8 step 1).

## 5. What Talli charges — open

The tension, stated rather than resolved:

- **A percentage of tally face value** is simplest, businesses already understand
  it (it reads like card fees), and it scales with usage. But it is a **tax on
  trust formation** — a levy on precisely the thing the system exists to
  increase.
- **A flat per-business subscription** doesn't penalise the good behaviour, but
  it doesn't scale with value delivered and it's a hard first sale to a café.
- **Nothing in V1**, funded by the parking business, is viable for months and
  defers the question — which may be right while the thing is still being
  learned.

Leaning: a low flat platform fee per business, plus a small percentage capped per
transaction, so the marginal cost of a *larger* tally approaches zero. That
prices the service without penalising depth. Unresolved — Q70.

## 6. Loss, and saying so

If the business closes, the member loses the balance. There is no guarantee fund
in V1, no insurance, no Talli backstop.

This is not a defect to be engineered away — it is the stake in `01-thesis.md`
§11 doing its job. A stake that can't be lost isn't a costly signal and carries
no information. "If you fail, I'm happy to wear it" is the design.

What that obliges:

- Plain-language disclosure at the point of purchase, in the interface, not in
  terms. *"If this business closes, you lose this. That risk is the point."*
- A suggested ceiling on what any one member holds at any one business, shown as
  guidance rather than enforced (§7).
- No language anywhere — marketing, interface, receipts — implying safety,
  protection, guarantee, or return.

## 7. Deliberately deferred

| Deferred | Reason |
|---|---|
| Multilateral netting (A→B→C→A) | The obvious efficiency, and it burns trust by construction. If ever built: offered, never automatic, and never as a default. |
| Hard position limits | V1 shows guidance, not enforcement. Enforcement needs data on what "too much" actually is, and we have none. |
| Transferability, secondary market | Creates a security (`10-build-v1.md` §2). |
| A Talli unit of account | §2. |
| Default mutualisation / guarantee pool | Would neutralise the stake. Revisit only if losses prove to be the thing that kills adoption. |

## 8. Needs an accountant, not an architect

Flagged because each affects whether the offer is attractive, and none is a
coding problem:

- **GST timing on vouchers.** NZ has specific rules on whether GST falls at issue
  or at redemption for tokens, stamps and vouchers. This directly changes the
  business's cashflow, and therefore whether a tally is worth selling. Confirm
  before pitching a single café.
- **Expiry and consumer law.** Whether a tally may lapse at all, what notice is
  required, and how unredeemed balances must be treated.
- **Revenue recognition** for the business — cash now, revenue later, and the
  liability sitting on their books in between. Small operators will not have
  thought about this and it should be explained to them, not sprung on them.

## 9. Metrics

What the system reports about itself, and the ones it deliberately doesn't.

**Report:** total open obligation; its age distribution; number of distinct
member↔business pairs with an open position; concentration (what share of open
obligation sits in the largest 5% of positions); redemption *without* renewal, as
the churn signal.

**Do not optimise:** transaction throughput, settlement speed, redemption
velocity. All three measure the destruction of the asset. They're worth watching
as diagnostics and must never appear as a target.
