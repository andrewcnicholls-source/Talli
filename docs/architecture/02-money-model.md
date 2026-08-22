# 02 — Money model

Status: stub. One principle is decided; almost everything else is open. Written
now only because the principle constrains the data model, and the data model is
the first thing that gets built wrong if it's assumed.

## Decided

**The ledger's primary object is the open bilateral position, not the settled
transaction.** See `01-thesis.md` §7 — trust *is* the outstanding stock of
unsettled obligation, so a ledger that nets balances away and stores only
completed transfers destroys the quantity the system exists to grow.

Design consequences that follow directly:

- Positions are recorded per-pair and remain open by default. Settlement is an
  event, not a goal state.
- Obligations are directional: `i → j` is a distinct quantity from `j → i`, and
  they are **not** automatically netted. Gross exposure and net position are
  different facts and both are needed (`01a-formalism.md` §6a).
- Every position carries an age. Age is signal, not staleness.
- System health metrics are volume, age and distribution of open obligation.
  Explicitly *not* throughput — optimising settlement would consume the asset.

## Open — blocking

- **The instrument** (Q76). Equity, revenue share, loan, prepaid credit, or a
  Talli-native claim. Nothing further can be specified until this is chosen, and
  it decides the regulator.
- Is there a Talli unit of account at all, or is every position denominated in
  NZD? (Q12, Q98.)
- Can a position be transferred to a third party? That single question separates
  a record-keeping system from a securities market.
- What closes a position other than payment — expiry, forgiveness, offset
  against a third party, death?

## Open — important

- Multilateral netting: if A owes B owes C owes A, does the system offer to
  clear the cycle? It's the obvious efficiency and it burns trust by
  construction. Probably it should be *offered* and never automatic.
- Limits: how large an open position is prudent, who sets it, and is it a hard
  constraint or a warning?
- Default: who absorbs an unrecoverable position (Q65)?
- Disclosure: can I see my own positions only, my counterparties', or the
  network's shape?
