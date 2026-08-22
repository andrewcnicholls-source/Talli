# Discovery questions

Answer inline, under each question, in whatever form suits — a sentence, a
paragraph, a "don't know yet", a "this is wrong, the real question is X".
Rewriting the questions is a legitimate answer.

Questions marked **[unblocks]** are the ones that change the most downstream if
answered; the rest can wait.

---

## A. Prior work and how we work

1. You've written some of this down already. Where does it live — Drive, Docs,
   notebooks, email to yourself, someone else's inbox? (Drive and Gmail are
   connected here; point me at it and I can pull it in rather than have you
   re-type it.)
2. How much of the architecture is settled in your head vs still moving? Which
   parts feel locked, and which parts do you keep re-deciding?
3. Is "Talli" the name for both the parking business and the financial system,
   or does the financial system get its own name later? (You said "Telly" —
   different thing, alternate spelling, or a working title?)
4. What's the cadence you want? A doc a week, an hour when you have one,
   something that sits until you poke it?
5. Who else, if anyone, is in this with you — co-founder, advisors, people whose
   buy-in matters early?

## B. The thesis

6. **[unblocks]** In one paragraph, what is broken about how people transact
   locally today? Not the abstract critique of finance — the specific thing you
   watch happen and think "that's wrong".
7. **[unblocks]** "A new type of equality and relative fairness" — what does
   *relative* fairness mean concretely? Fair relative to what: income, effort,
   time, need, local cost of living, what a person has already given?
8. Is the target outcome that people transact *more* (volume), *more locally*
   (substitution away from distant/corporate), or *more fairly* (same volume,
   different distribution)? If you had to sacrifice two of those three?
9. Who is the person this is unambiguously for? Describe one real person in
   Sandringham (or anywhere) whose week gets better because Talli exists.
10. Who is it explicitly *not* for? A system that serves everyone usually serves
    the already-powerful; where do you draw the line?
11. What does success look like in 10 years — a neighbourhood, a city, a
    protocol others build on, a co-op with members, a company with users?

## C. Money and the ledger

12. **[unblocks]** Is there a Talli unit of value, or does Talli only ever record
    and route existing money (NZD)? These are very different systems.
13. If there is a unit: is it issued (someone creates it), earned (you get it by
    giving), or purely relational (it exists only as a balance between two
    people, like mutual credit / LETS / Sardex / WIR)?
14. Is it pegged to NZD 1:1, floating, or deliberately non-convertible?
15. Can a balance be negative? If yes, who decides how negative, and what happens
    at the limit?
16. Does holding value cost anything over time (demurrage), earn anything
    (interest), or neither? What's the intended behavioural effect?
17. Is the ledger a single shared book, or a mesh of bilateral balances that
    only sometimes clear? (This is the deepest structural fork in the whole
    design.)
18. How does someone exit — convert out, walk away with a positive balance, walk
    away with a negative one?
19. Does the system ever need to touch a bank? For what: on-ramp, off-ramp, GST,
    payroll, nothing?

## D. Trust

20. **[unblocks]** What is "trust" in this system — a score, a credit limit, a
    graph of who vouches for whom, a history of completed transactions, or
    something you feel rather than compute?
21. Is trust earned per-person (I trust you) or per-community (the neighbourhood
    trusts you)? Can it be transferred or inherited?
22. What does a new person with no history get? Zero capability, a small
    community-backed float, or capability borrowed from whoever vouched?
23. What does someone lose when they break trust, and is it recoverable? Is there
    a path back, or is exclusion permanent?
24. How do you stop one person being many people (Sybil)? Real-world identity,
    physical presence, vouching cost, staking something?
25. Is the trust graph visible? Can I see who vouched for you, who you've traded
    with, what you owe? Where's the line between accountability and surveillance?
26. Does trust decay if unused?

## E. Fairness mechanics

27. **[unblocks]** Concretely: two people buy the same thing and pay different
    amounts. What is the rule? Who computes it, who can see it, and does the
    seller know?
28. Where does fairness get applied — the price, the fee, a rebate afterwards, a
    pooled fund, or credit terms (same price, different time to pay)?
29. Does the system need to know someone's income or circumstances? If yes, who
    holds that, and how do you avoid it becoming means-testing with the
    indignity that carries?
30. Is there a cap on accumulation — can someone hold an unbounded Talli balance,
    or does the design push value back into circulation?
31. If a seller consistently loses out under fair pricing, why do they stay?
    What's the compensating benefit?
32. Is fairness opt-in per transaction, per member, or structural and
    unavoidable?
33. What's the failure you'd most hate: fairness that feels like charity, or
    fairness that feels like surveillance?

## F. Locality and membership

34. **[unblocks]** What defines "local" — a radius, a suburb boundary, a school
    zone, who you already know, self-declared? What's the actual boundary object
    in the data model?
35. Can I belong to more than one local community? Do balances move between them,
    or are they walled?
36. Who lets someone in — open signup, invite, vouch, a person who decides?
37. What's the minimum viable size for a community to work? What happens below
    it, and what breaks above it?
38. Do businesses join as members, or as a different class of participant? A sole
    trader vs a supermarket — same rules?
39. What stops a community becoming exclusionary — a closed, self-congratulating
    in-group with a nice ledger?

## G. Governance and ownership

40. **[unblocks]** Who owns Talli — you, a company, a co-op, the members, a
    trust? Is that decided or open?
41. Who can change the rules (credit limits, fairness formula, who's excluded)?
    You, an algorithm, a member vote, a council?
42. When two members dispute a transaction, what happens? Is there a human?
    Who pays for that human's time?
43. What's the commitment you're willing to make now about what Talli will never
    do — sell data, extract rent, take equity investment, be acquired?
44. If you got hit by a bus, what should happen to it?

## H. Regulation, tax, compliance (NZ)

45. **[unblocks]** Have you taken any advice yet, or is this all pre-legal? (Not a
    blocker to design, but it changes what V1 can look like.)
46. Do you know whether what you're describing lands as a financial service
    (FSP registration), a payment service, stored value, or none of the above?
    A mutual-credit system and a wallet holding NZD are regulated very
    differently.
47. AML/CFT — does the design assume identity verification at signup, or is that
    something you're hoping to avoid via the trust model?
48. Tax: IRD treats barter and non-cash consideration at market value. Does the
    design create a tax event on every trade, and do members know that?
49. GST — are members transacting as consumers, or are businesses in the loop?
50. Is there an existing NZ scheme you're consciously with or against — Timebank,
    LETS groups, Sharetribe-likes, Māori/iwi economic models, credit unions?

## I. Product and the first mile

51. **[unblocks]** Is Talli Parking the wedge, a test bed, a source of income
    while you build, or unrelated?
52. What is the very first transaction on Talli-the-system? Describe it end to
    end: who, what, how they pay, what the ledger records.
53. What does a member actually open — an app, a web page, a text message, a
    shared spreadsheet?
54. Does the first version need money to move at all, or can it start as pure
    record-keeping between people who already trust each other?
55. What would make you say "this works" after 20 members and three months?
56. What's the smallest thing that would prove the fairness mechanic works, as
    opposed to proving people will use a booking app?

## J. Technical architecture

57. **[unblocks]** Ledger implementation: double-entry in a normal database
    (Postgres), event-sourced log, or a distributed/blockchain ledger? What
    property are you actually buying with the harder options — auditability,
    trustlessness, censorship-resistance, ideology?
58. Does anything need to work offline or at a gate with no signal? (The parking
    gate screen suggests yes.)
59. Where does it run — a web app, a phone app, both? Who runs the servers?
60. Payment rails if NZD moves: Stripe, bank transfer, Akahu/open banking,
    POLi-style, cash?
61. Is any part meant to be open source or forkable by another community?
62. What's your own build capacity — how much of this do you want to write, and
    how much should be off-the-shelf?
63. Data: what is stored forever, what is deletable, and who can subpoena it?

## K. Adversaries and failure modes

64. **[unblocks]** What's the first way a smart, bad-faith person breaks this?
65. What happens when someone defaults on a large negative balance — who eats it:
    the counterparty, the community pool, everyone pro-rata, the company?
66. Collusion: two or three members trading in a circle to manufacture trust or
    balance. Does the design notice?
67. What happens if the whole thing works and then people want out at once —
    is there a run risk?
68. What's the reputational failure that kills it — a scam, a fight between
    neighbours, a media story about a debt, a regulator letter?
69. What's the boring failure that kills it — nobody uses it after month two?

## L. Business model

70. **[unblocks]** How does Talli sustain itself without contradicting its own
    fairness claim? Fees, membership, the parking business, grants, nothing?
71. Do you need this to pay you a living, and by when?
72. Is outside capital acceptable? If yes, what would you refuse to give up for
    it?

## M. Sequencing

73. **[unblocks]** Of everything above, what do you most want *nailed down* in
    the next month — and what are you happy leaving fuzzy for a year?
74. What's the artefact that would most help you: a written architecture doc, a
    diagram, a data model, a working prototype, a one-pager you can show people?
75. What's made you stall on this before? Knowing that shapes how we structure
    the work more than any answer above.

---

# Round 2 — questions the thesis raises

Sections B (thesis) and parts of C/E are now partly answered — see
`01-thesis.md`. These are the questions that model opens up. Same rules:
answer inline, rewrite the question if it's the wrong one.

## N. The instrument

76. **[unblocks]** When someone "invests where they spend", what do they actually
    hold? Equity in the business, a revenue share, a loan, a bond, prepaid
    credit, or a Talli-native claim that isn't any of those?
77. What's the return — cash distributions, capital appreciation on resale,
    discounts and perks at the business, or the business simply continuing to
    exist near you?
78. Who issues it: the business itself, Talli on the business's behalf, or a
    vehicle that holds a pool of businesses?
79. Can it be sold? To whom — anyone, other members, only locals, back to the
    business? An open secondary market is an exchange, with everything that
    brings.
80. What does the business get that it can't get from a bank loan, Prospa-style
    lender, or crowdfunding platform? Be specific — cheaper capital, patient
    capital, customers who are now owners, or something structural.
81. What does the business give up? If it's control, most small owners will say
    no. If it's nothing, why would anyone fund it?
82. Minimum ticket size — is this $20 from 200 people, or $2,000 from 20?

## O. The information layer

83. **[unblocks]** "You turn up and you see if it's busy." How does that become a
    signal the system can use? Self-reported, inferred from members' spending,
    inferred from foot traffic, or never digitised at all — it just informs the
    individual's own decision?
84. Does Talli need to see where people actually spend? If yes, how — open
    banking (Akahu), card linking, receipts, manual logging? That's the single
    heaviest data dependency in the design.
85. Is spend history *proof of standing* — i.e. you can only invest where you've
    demonstrably been? Or is "where you spend" just the pitch, not a rule?
86. Does spending automatically accrue a claim (round-ups, a share of every
    dollar), or is investing a separate deliberate act?
87. What stops the information layer becoming a rating system that publicly
    grades local businesses — and destroys the ones it grades badly?
88. How much of the signal is private (only you see your own read) vs. shared
    (the network sees aggregate)? The whole copying layer depends on the answer.

## P. The network / copying layer

89. **[unblocks]** What exactly does copying mean — I see what my neighbours
    hold and choose to mirror it, or I delegate and it happens automatically?
90. Whose strategies can I see? Everyone's, my vouched circle's, aggregates
    only? Portfolio visibility is financially revealing in a way people
    underestimate.
91. Do the copied get anything? If good judgement is a public good here, does
    the system reward it — and does that create influencers, and then bad
    incentives?
92. Is copying weighted by anything — track record, proximity, how much of their
    own money they have in?
93. If everyone copies, the information the system runs on stops being produced.
    What keeps original local judgement in the mix?

## Q. Concentration — the honest question

94. **[unblocks]** Your job, your house, your amenities and now your savings all
    load onto the same suburb. A local downturn takes all four. Is that a bug you
    want mitigated, or a feature you accept — skin in the game, deliberately?
95. If it's a bug: what's the mitigation — position caps, a cross-locality layer,
    a stabilisation pool, or just disclosure and let people choose?
96. Is there a hard cap on how much of one person's capital can sit in Talli at
    all? A system that makes it easy to over-commit to your neighbourhood is
    dangerous in a way a share app isn't.
97. What happens when a funded local business fails and its investors are its
    customers and its neighbours? That's not a support ticket, it's a street with
    a grievance. What does the system owe them?

## R. Rewrites to Round 1

98. **[unblocks]** Given all this — is there still a Talli *currency* at all
    (Q12–19), or was that my misread and it's capital allocation over ordinary
    NZD end to end?
99. Which fairness reading is it — distributional (locals own what they sustain)
    or terms-of-trade (trust compresses the risk premium)? Or is the second the
    theory and the first the product? See `01-thesis.md` §5.
100. Trust (Q20–26): is trust here primarily about *counterparty risk* (will they
     honour the trade) or *information quality* (is their read of the café worth
     copying)? These need different mechanics and I've been conflating them.
101. If this is investment in real businesses with real returns, the NZ
     regulatory questions (Q45–50) get much heavier — Financial Markets Conduct
     Act, disclosure, licensed intermediary, the crowdfunding exemption. Is that
     a wall you've already looked at, or one we map next?

## S. How you'd know it worked

102. The thesis says low trust makes people under-specialise and over-insure.
     Is there anything observable that would show that reversing — locally, at
     small scale, within a year?
103. What's the measurement that isn't just "transaction volume went up"? Volume
     is the easy metric and the one least connected to your actual claim.
104. Would you rather prove the *investment* mechanic (money flows to good local
     businesses via local information) or the *trust* mechanic (better terms
     between people who know each other)? You probably can't test both first.

---

# Round 3 — the formalism, and the fork it creates

See `01a-formalism.md` for the assessment behind these.

## T. Which formal claim is the real one

105. **[unblocks]** Of the four candidate claims in `01a-formalism.md` §8, which
     one do you believe hardest? That's the one worth trying to break first.
106. The real-options statement in §7 — "the premium people pay to under-
     specialise *is* the deadweight loss Talli eliminates" — is the tightest
     version of your thesis I can construct. Is it your thesis, or has it lost
     something in the compression?
107. Do two routes to the same market outcome ever *cancel*, or only add with
     weights? This is the single test for whether complex numbers are structural
     or ornamental. Take your time on it — your hunch may be pointing at
     something I haven't found.
108. Does *timing* matter as much as quantity — is "everyone shows up to market"
     a coordination problem in its own right, or shorthand for liquidity?
109. Direction of obligation vs. volume of interaction: are those two quantities
     you'd want to carry on a single edge? If yes, the Hermitian/magnetic
     encoding is the natural home and the complex-number hunch is vindicated on
     unglamorous grounds.
110. Relativity gave you the intuition — but is the invariant identified? What is
     the quantity every observer agrees on, whatever their position in the
     network? A fairness rule that holds nothing invariant isn't fair, it's just
     variable.

## U. Research track vs. build track

111. **[unblocks]** Do you want the formalism *resolved* before the product is
     designed, or running alongside it? There's no wrong answer, but an unstated
     answer defaults to "resolved first", which can absorb years.
112. Would a small empirical test — Ricci curvature on an existing trade or
     social dataset, no product involved — be motivating or a distraction right
     now?
113. Is the maths load-bearing for the *product*, or for *conviction* — yours,
     and eventually investors' and members'? Both are legitimate; they justify
     very different amounts of it.
114. Has the formalism been where this stalled before? (Round 1, Q75 — still the
     question I most want answered.)

## V. Still outstanding from Round 2

115. The instrument (Q76) — equity, revenue share, loan, prepaid credit, or
     Talli-native. Nothing on the build path can be decided until this is.
