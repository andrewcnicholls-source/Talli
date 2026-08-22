# 10 — What to build

Status: proposal. This is the first document on the build path. It exists to
answer "what do we actually need to build", and it makes one recommendation that
unblocks everything else.

**Not legal advice.** §2 takes a reasoned position on NZ regulation that must be
confirmed with a financial services lawyer before anything goes live.

---

## 1. The problem this document solves

The instrument question (Q76) has been gating the build: equity, revenue share,
loan, prepaid credit, or something Talli-native. Equity and revenue share put
you inside the Financial Markets Conduct Act — disclosure, licensing, or the
crowdfunding exemption and its caps. That's a nine-month legal project before a
single member exists.

So the sequencing question is: **is there an instrument that carries the full
thesis and doesn't require a licence?**

Yes. And it's the one the project is named after.

## 2. The V1 instrument: the tally

**A member pre-buys credit at a local business they already use.**

That's it. Money moves to the business today. The member holds a claim on future
goods or services. The position stays open until it's spent.

Check it against every claim in `01-thesis.md`:

| Thesis requirement | Does prepaid credit satisfy it? |
|---|---|
| Open bilateral position as the primary object (§7) | Yes — the business owes goods until redeemed. Unsettled by construction. |
| Trust *is* the unsettled balance (§7) | Yes, and it's the literal ledger balance. Nothing to model. |
| Stake as costly signal (§11) | Yes — real capital, at real risk. |
| Downside accepted willingly (§11) | Yes — if they close, you lose it, and you knew that. |
| Invest where you spend (§3) | Structurally enforced: you can only hold credit somewhere you'd actually spend. |
| Working capital for the business | Yes, and it's *better* than a loan — no interest, no repayment schedule. |
| A tally (§9) | It is one. Both sides hold the record of the same unsettled obligation. |

The regulatory position: this is a consumer prepayment — the same legal object
as a gift voucher, which every café in the country already issues. The
distinguishing feature of a security is the expectation of a financial return,
and here the return is **goods you were going to buy anyway**. No dividend, no
capital gain, no secondary market in V1.

**The three things that would break that position, and are therefore rules:**

1. **No transferability in V1.** The moment a tally can be sold to a third party
   you have created a tradeable instrument. Non-transferable, or gift-once-to-a-
   named-person at most.
2. **No cash redemption.** Convertible back to money, it looks like a deposit.
   Redeemable in goods only.
3. **No promised financial return.** A discount for pre-paying is normal retail.
   A *yield* is a security. The line is real and it's worth staying well clear
   of it.

Confirm all three with a lawyer. But note what this buys: you can start now, with
real money, real stakes and a real ledger, and defer equity to v2 — by which
point you'll have a network, evidence, and a reason.

## 3. What V1 actually is

> **A member holds tallies at the local businesses they use. They can see where
> the people they trust hold theirs.**

Two mechanisms, and nothing else. Everything in `01-thesis.md` is either one of
these or is deferred.

## 4. The minimum system

**Ledger.** Double-entry, event-sourced, in Postgres.
- Positions are per-pair, directional, and never auto-netted (`02-money-model.md`).
- Every event is append-only. Redemption is a new event, not a mutation.
- Every position carries an age, because age is signal.
- Nothing anywhere computes a "trust score". The stake graph *is* the score.

**Members and businesses.** Identity, and membership of nested places
(neighbourhood ⊂ city ⊂ country), overlapping and multiple per §13.

**Buy a tally.** Card payment in, money out to the business, position opened.

**Redeem a tally.** The business marks credit spent. This is the hard part in
practice, not in code — it has to work at a counter, in seconds, by someone who
isn't paid to care. A code the member shows and the staff type is probably
right. Anything requiring an app install on the business side will fail.

**The graph view.** Where do the people I trust hold tallies? First-order is
trivial. Second-order — where *their* circles hold — is the `α²` term from §14,
and it's the actual product insight. Ship it as **discovery only**.

> **Discovery, never allocation.** Showing you where your network holds is
> information. Automatically placing your money across businesses on your behalf
> is managing investments, and that needs a licence. Keep the human in the loop
> on every placement. This is a legal boundary and a design one.

## 5. Stack

Recommended, and it's what's already connected rather than what's fashionable:

- **Supabase** (Postgres, auth, row-level security, edge functions) — the ledger
  and the graph. Postgres does recursive CTEs, so the path-sum in §14 is a query,
  not a service.
- **Stripe** — payments in, payouts to businesses. *Currently needs authorising
  before it can be used from this session.*
- **Netlify** — hosting, already in use for the existing site.
- Front end continues as static HTML/CSS in the existing house style. No
  framework until something needs one.

The path sum `(I − αA)⁻¹` does not need a graph database, TensorFlow, or a
matrix library at V1 scale. At a few thousand nodes it's a two-hop SQL query with
a damping constant. Build it that way; revisit if it ever gets slow.

## 6. The first merchant is Talli Parking

It's yours, it's live, it has real customers and a payment flow, and it answers
Q51 by making the parking business the test bed rather than a distraction.

A season tally — pre-buy the year's parking, get a better rate, hold an open
position — is a real tally, sold to real people, settled over a real season. It
tests redemption at a gate, in the dark, in the rain, with a queue behind. If it
survives that it will survive a café.

## 7. Explicitly deferred

Not "later maybe" — deliberately out of V1, with a reason:

| Deferred | Why |
|---|---|
| Equity / revenue share | Licensing. Revisit once there's a network worth the legal spend. |
| Transferable or tradeable tallies | Creates a security and a secondary market. |
| Automatic allocation across businesses | Managing investments. Licence. |
| Trust scores, ratings, reviews | The stake graph already carries it, and public grading of local businesses destroys the ones it grades (Q87). |
| Any Talli-denominated currency | Nothing in V1 needs it. NZD throughout. |
| Curvature, tensors, the frame transformation | Research track, concurrent, non-blocking (`01a-formalism.md` §9). |

## 8. Order of work

1. Confirm §2 with a NZ financial services lawyer. One conversation. Do it
   before writing schema, because a "no" changes the schema.
2. Ledger schema and the event model — the smallest thing that records an open
   position correctly, with a real double-entry invariant and tests.
3. Buy and redeem, end to end, for one business: Talli Parking.
4. Sell season tallies to actual customers. Learn what breaks at the gate.
5. A second and third business on the same street. This is where it stops being
   a booking system and becomes a network.
6. The graph view, once there are enough members for second-order to mean
   anything. Roughly 30–50 members and 5+ businesses; below that it shows you
   your own reflection.

Steps 2–4 are weeks, not months. Step 5 is the one that decides whether any of
this is real, and it isn't a technical step — it's whether two more businesses on
Paice Ave will say yes.
