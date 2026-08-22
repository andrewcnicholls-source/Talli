# Talli — architecture

Talli is two things at once right now:

1. **Talli Parking** — a live, small, local transaction business (matchday parking at
   86 Paice Ave, Sandringham). Code for it is in the repo root.
2. **Talli** — the underlying product: a financial system for transacting locally,
   built on trust, aiming at a new kind of equality and relative fairness.

This directory is for (2). It is deliberately slow-burn: the point is to get the
thinking down in a form that can be picked up cold months later, and to let the
architecture harden before any of it is built.

## Intended documents

Each lands once the questions behind it are answered. Nothing here is written
speculatively — a doc only exists when there are real answers to put in it.

| Doc | Covers | Status |
|---|---|---|
| `00-discovery-questions.md` | The open questions, by layer | in progress |
| `01-thesis.md` | Information, specialisation, and "invest where you spend" | first draft |
| `02-money-model.md` | Unit of account, issuance, settlement, the ledger | not started |
| `03-trust-model.md` | Identity, vouching, credit limits, reputation | not started |
| `04-fairness-mechanics.md` | How "relative fairness" is actually computed | not started |
| `05-locality-membership.md` | Boundaries, joining, leaving, inter-community | not started |
| `06-governance.md` | Ownership, rule-setting, disputes | not started |
| `07-compliance-nz.md` | AML/CFT, FSP registration, tax/GST, stored value | not started |
| `08-technical.md` | Ledger implementation, rails, data model, privacy | not started |
| `09-adversarial.md` | Failure modes, collusion, default, exit, runs | not started |
| `10-sequencing.md` | What ships first, what the wedge is, cadence | not started |

## How to use this

Answers go into `00-discovery-questions.md` inline, in your own words — rough is
fine, half-formed is fine. When a section has enough in it, it gets promoted into
its own numbered doc and the question list points at it.
