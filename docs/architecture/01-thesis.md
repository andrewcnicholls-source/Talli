# 01 — Thesis

Status: first capture, from conversation. Andrew's model in his terms, plus a
formalisation of it. Anything marked **[open]** is not yet decided.

---

## 1. The starting model, and why it's too simple

The standard picture is an Edgeworth box. Person A can produce X or Y. Person B
can produce X or Y. A is better at X, B is better at Y. Comparative advantage
says: specialise, trade, both end up better off than in autarky. There is a
contract curve, and any point on it beats not trading.

The model is a square with a clean interior. Real exchange is not that shape.

What the box assumes away is **information**. It assumes each party knows the
other exists, knows what they can produce, knows they'll show up, and knows the
trade will be honoured. Strip that assumption and the geometry changes.

## 2. Information determines how far you specialise

The behavioural claim, which is the heart of this:

> Trust and proximity give you information. With information, you take the most
> cooperative action, because it's in your interest to. As information about the
> counterparty falls away, you buy insurance instead.

"Insurance" here is not a financial product. It is **retained capacity**. If
you're not sure B will trade with you, you keep making some of your own Y — badly,
at a worse rate than B could — because self-sufficiency is the hedge against B not
being there. You under-specialise on purpose.

That hedge is the cost of low information. It shows up in two places:

1. **Depth of specialisation.** Low trust → you keep redundant capacity → the
   joint surplus that specialisation would have created never exists. This is a
   deadweight loss, and nobody sees it, because you can't observe the trade that
   didn't happen.
2. **Terms of trade.** Even when the trade does happen, uncertainty is priced in.
   You give up a lot to get a little — the gap is a risk premium paid to
   ignorance, not to value.

So trust is not a soft virtue bolted onto the economics. Trust is the variable
that sets how large the pie is *and* how the pie splits. Both.

## 3. What follows

If information is the binding constraint, then the leverage is in supplying
information that people don't currently have a way to act on — and the people
who already hold that information are the people who are physically there.

That's the pitch:

> **Invest where you spend.**

You already know which places in your life are good. You go there. You see
whether it's busy on a Tuesday. You know the owner turns up. You know the vibe
changed after the refit. That is real information — it's the kind institutional
capital pays analysts to approximate badly and late — and right now there is no
instrument that lets you act on it. Your local knowledge earns you nothing. It
just makes you a well-informed customer.

Talli's job is to close that gap: let the people with the local information put
capital where their feet already go.

## 4. The scaling layer: network as insurance

One person's local information covers a handful of places. It doesn't scale, and
concentrated bets on a handful of places are fragile.

The proposed answer is social: **you copy the strategies of the people around
you.** Not because they're smarter, but because copying is a defensible fallback
under uncertainty — it's the same insurance instinct as section 2, redirected
somewhere useful. Instead of hedging by hoarding capacity, you hedge by pooling
judgement with people whose information overlaps yours but isn't identical.

So the network does two jobs at once: it's the distribution mechanism for local
information, and it's the risk-management layer.

## 5. Where "fairness" enters — **[open]**

Two candidate readings, not yet resolved:

- **Distributional.** Returns on local commerce currently flow to distant capital.
  If the people who generate the revenue also hold the claim on it, the return
  stays in the community that produced it. Equality of *ownership over what you
  already sustain*.
- **Terms-of-trade.** Trust compresses the risk premium (section 2), so more of
  the surplus is shared rather than extracted by whoever has the information
  advantage. "Relative fairness" = fairness relative to your information
  position, not relative to your income.

These are compatible but imply very different mechanics. Needs resolving before
`04-fairness-mechanics.md` can be written.

## 6. Tensions to resolve, not to paper over

1. **Concentration.** "Invest where you spend" correlates your portfolio with
   your neighbourhood — and your neighbourhood already carries your job, your
   house and your amenity. A local downturn takes all four at once. Copying your
   neighbours diversifies you *within* the locality while concentrating you
   *in* it. The insurance framing in section 4 may be the opposite of what it
   claims. This needs an honest answer, not a footnote.
2. **Affection bias.** Local information is real, but so is loving your café.
   Retail investors lose money on businesses they like. What in the design
   separates "I know this place is good" from "I want this place to survive"?
3. **The instrument decides the regulator.** Equity, revenue share, loan, or
   prepaid credit are four different legal universes. Section 3 is silent on
   which one this is, and that silence is currently doing a lot of work.
4. **Information asymmetry cuts both ways.** The same closeness that gives you
   good information gives the business owner social leverage over you. Being the
   neighbour who pulled their money out is costly in a way selling a share of a
   listed company is not.

---

## 7. Trust is the unsettled balance

This is the load-bearing addition, and it makes the thesis measurable.

Start with the repeated game. A single-round prisoner's dilemma has a defection
equilibrium. Repeat it with the same counterparty and behaviour changes — not
because anyone became virtuous, but because the shadow of the future changes the
payoff. Interaction frequency manufactures trust.

What trust then *looks like* in behaviour is **giving**. People do things for
each other without settling up. A favour, a hand, a discount, a shift covered.
Each of those is a real transaction, transferred now, unresolved. It is debt —
just debt nobody wrote down and nobody intends to call.

Which yields the definition:

> **Trust is the outstanding stock of unsettled obligation in the network.**

Not a proxy for it. Not correlated with it. It *is* it.

### Why this matters

The standard picture treats market clearing as the goal and non-clearing as
friction. Invert it. A market that fully clears — every transaction closed,
nobody owes anybody anything — has **zero trust in it by construction**. Two
strangers settling in cash and walking away is a perfectly cleared market and a
perfectly trustless one.

So the imbalance isn't the inefficiency. **The imbalance is the asset.** It's the
accumulated open position that lets people commit to pure specialisation —
because you can only stop making your own Y if you're carrying a credible claim
on someone else's. Unsettled obligation is what buys the right to specialise.

This closes the loop with `01a-formalism.md` §7 exactly: the outstanding gift is
the option, held rather than exercised. Under-specialisation and unsettled
obligation are the same quantity seen from opposite sides — one is the premium
you pay for *not* having trust, the other is the asset you hold *because* you do.

### What it implies for the build

If trust is unsettled obligation, then it is a **ledger quantity**, not a score.
Consequences, and they're sharp:

- The core object in the data model is the **open bilateral position**, not the
  completed transaction. Completed transactions are the exhaust; open ones are
  the product.
- The health metric is the **volume, age and distribution of unsettled
  obligation** — not throughput. Throughput would measure exactly the wrong
  thing. A system optimising for settlement would be burning its own asset.
- There is no need to invent a trust score. It's already in the books, if the
  books are kept in a way that records what's open rather than netting it away.
- It answers Round 1 Q17: bilateral balances that *deliberately* don't clear.
  Which is close to mutual credit — but with the sign flipped on the intent.
  Mutual-credit systems tolerate imbalance; this one is *trying to accumulate*
  it.

### Open, and important

- **Does formalising the gift kill it?** Writing down what your neighbour owes
  you converts a gift into a debt, and the anthropology of gift economies says
  that transformation destroys the thing. Talli's entire mechanism is making the
  unsettled balance legible. That may be the deepest risk in the design — not
  regulatory, not technical, social.
- **Where's the line between trust and exposure?** A large open position is
  trust from one angle and unhedged credit risk from the other. Same number.
- **What stops accumulation becoming extraction?** If holding claims is the
  asset, the person with the most claims has the most power, and that is the
  ordinary shape of creditor economies — the one this project exists to escape.

## 8. Investment as durable gift

The through-line to "invest where you spend": an investment is a formalised,
durable, transferable version of the unsettled gift. It's the same object —
value transferred now, claim resolved later, sustained by information about the
counterparty — made explicit enough to survive beyond the relationship that
generated it.

That's a cleaner statement of what Talli builds than "a local investment
platform": **infrastructure for holding open positions with people and places you
have information about.**
