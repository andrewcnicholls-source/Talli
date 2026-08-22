# 01a — Formalism (research track)

Status: capture and assessment. **Not on the build path.** See §9.

The intuitions being tested here: *law of interaction rather than law of
action*; parallels to special/general relativity; tensors; and a long-held
hunch that complex numbers are needed because choices are two-way and
undetermined until everyone shows up to market.

Verdict up front: the interaction-primitive framing is right and has a
standard mathematical home. The geometry is more than metaphor — there is a
computable curvature. The complex-number hunch is sound but not for the reason
it feels like it is, and it has two good homes and one weak one.

---

## 1. Law of interaction, not law of action

Physics gets its dynamics from an action functional, `S = ∫L dt`, minimised
over paths. Economics did the same move: agents with utility functions,
maximised subject to constraints. In both cases the *agent* is the primitive
and the interaction is derived.

The claim here inverts that: the **edge** is the primitive. What exists is the
interaction — mediated by information — and agent behaviour is what falls out.

This is not a fringe position mathematically. It's the structure of an energy-
based graphical model: a global quantity written as a sum of potentials over
edges rather than over nodes.

```
E(state) = Σ_(i,j) φ_ij(x_i, x_j)     ← interactions carry the model
         + Σ_i    ψ_i(x_i)            ← node terms are a correction, not the base
```

Ising models, Markov random fields, and graphical games all have this shape. The
useful consequence: once the model is edge-primitive, "how much do I specialise"
stops being a private optimisation and becomes a property of the *configuration*
of the network — which is exactly the claim in `01-thesis.md` §2.

## 2. The relativity parallel — what's load-bearing

Two parts are real. One is decoration.

**Load-bearing: finite propagation of information.** In relativity, no influence
travels faster than light, so every event has a causal past and future — a light
cone. Trust and reputation also propagate at finite speed through a social
network: there is a set of people who *could* know about you by now, and a set
who couldn't. Economic locality becomes causal locality. This is formalisable
and it directly explains why the model can't be "flat": the reachable set is a
cone, not a plane.

**Load-bearing: no privileged frame.** There is no god's-eye price. What a thing
costs depends on the observer's position in the information network. This is the
precise version of *relative fairness*: not fairness relative to income, but
fairness relative to an information position — and the interesting quantities
are the ones **invariant** across observers. That's the right question to ask of
any fairness rule proposed later: what does it hold invariant?

**Decoration: the field equations.** Writing something in the shape of
`G_μν = 8πT_μν` would be analogy-chasing. The Einstein equations get their
content from specific physical conservation laws that have no economic
counterpart. Resist that one; it's where this kind of project usually dies.

## 3. The metric: trust as distance

If trust lowers the cost of transacting between `i` and `j`, then trust defines
a **distance**, and the network becomes a metric space. Goods then flow along
cheapest paths — geodesics.

This has a mature mathematical home: **optimal transport**. Move a distribution
of supply to a distribution of demand at minimum cost over a metric space. And
critically, the *dual* problem (Kantorovich duality) produces potentials that
are interpretable as **prices**.

That matters more than it sounds. It means: define trust as a metric, and prices
fall out of the geometry as dual variables rather than being assumed. The
fairness question in `01-thesis.md` §5 then becomes a question about the dual
potentials, which is a concrete thing to reason about.

Lead to check: Galichon, *Optimal Transport Methods in Economics* (2016) — OT
applied to matching and equilibrium pricing.

## 4. Curvature — and this one is computable today

Networks have curvature, and it isn't a metaphor. **Ollivier–Ricci curvature**
is defined on graph edges via optimal transport between the neighbourhood
distributions of the two endpoints. Same machinery as §3.

Interpretation maps almost too neatly onto the thesis:

| Curvature | Network shape | Economic reading |
|---|---|---|
| Positive | dense, clustered, redundant paths | many ways to route around a defector — trust is cheap, insurance unnecessary, deep specialisation is safe |
| Near zero | grid-like | neutral |
| Negative | tree-like, bridges, bottlenecks | few alternate routes — counterparty risk is real, self-insurance rational, specialisation shallow |

So "how much do I specialise" plausibly correlates with **local curvature of the
trust graph**. That is a testable statement, on real data, without building
anything.

Lead to check: Ollivier (2009) for the definition; Sandhu, Georgiou &
Tannenbaum, *Ricci curvature: an economic indicator for market fragility and
systemic risk* (Science Advances, 2016) for the financial-network application.
`GraphRicciCurvature` (Python) computes it off the shelf.

## 5. Tensors — where the transformation law actually bites

Worth separating two meanings that the word is doing double duty for.

**Tensor as multi-index array.** Bilateral flows of good `k` from `i` to `j`
give `F_ijk` — three indices. True, and mildly useful, but any array is that.

**Tensor as an object with a transformation law.** This is the real content, and
economics genuinely has it. Under a change of numéraire — re-denominate the
units — quantities transform one way and prices transform the other, and the
value `p·q` is **invariant**. Prices are naturally covectors, quantities are
vectors, value is the pairing. That is a real tensorial structure, not borrowed
language, and it's the formal reason "value" survives a change of units while
"price" doesn't.

The metric `g_ij` from §3 is a genuine rank-2 tensor on the trust network. That's
where the tensor formalism earns its place.

**One naming caution.** *Tensors* (the mathematics) and *TensorFlow* (a specific
ML library) are unrelated in everything but the word. If the model is graph
geometry, the tooling is more likely `POT` (Python Optimal Transport),
`GraphRicciCurvature`, `NetworkX`, and PyTorch Geometric than TensorFlow. Don't
let the shared word pick the stack.

## 6. Complex numbers — the hunch is right, the reason isn't

The stated intuition is superposition: two-way options, undetermined until
chosen, resolved when everyone shows up to market. That *feels* quantum.

Honest assessment: classical uncertainty does not need complex numbers. Real
probabilities handle "undetermined until chosen" perfectly well. Complex
amplitudes earn their keep in physics for one specific reason — **interference**,
where two routes to the same outcome can cancel. So the test is: do two paths to
the same market outcome ever *cancel*, rather than just adding with weights? If
no, complex numbers are ornamental here.

But there are two places where they're genuinely necessary, and both fit:

**(a) Direction in the network — the magnetic Laplacian. [strongest]**
Trade is directed: `i → j` is not `j → i`. A real symmetric adjacency matrix
throws that away, and a plain asymmetric one loses the spectral theory that makes
graph analysis work. The standard fix puts a complex phase `e^{iθ}` on each edge,
producing a **Hermitian** Laplacian that keeps direction *and* keeps real
eigenvalues. Complex numbers are not decorative there — they are the only way to
have both. Encode magnitude of interaction as modulus and net direction of
obligation as phase, and the algebra works.

**(b) Timing and coordination — phase. [strong]**
"Everyone shows up to market" is literally a synchronisation problem. The
standard model is Kuramoto, whose order parameter `r·e^(iψ)` is complex by
construction: modulus `r` = how coordinated the population is, argument `ψ` = the
collective timing. A market clears when enough participants are phase-aligned.
If *when* people show up matters as much as whether, phase is the right object
and complex numbers come free with it.

**(c) Quantum decision theory. [weak, contested]**
There is a real literature arguing human preference reversals and order effects
violate classical probability in ways complex amplitudes capture (Busemeyer &
Bruza 2012; Yukalov & Sornette). It exists, it is mostly descriptive, and it is
not settled. Available, but don't build a foundation on it.

## 7. The unification worth noticing

The "two-way option, undetermined until chosen" intuition and the "insurance"
mechanism in `01-thesis.md` §2 are **the same object**, and it already has
rigorous mathematics: a **real option**.

Retained capacity — making your own Y badly, just in case — is the purchase of an
option on self-sufficiency. Its value comes precisely from the choice not yet
being made. Which yields a clean, quantitative statement of the whole thesis:

> Low information raises the value of the option to not-trade. Rational agents
> buy that option by under-specialising. **The premium on that option is the
> deadweight loss the system is trying to eliminate.** Trust reduces the option's
> value; the surplus released is what Talli captures and redistributes.

Real options theory (stochastic calculus, martingales — not complex numbers)
prices exactly this. If one formal statement of the thesis is wanted, it's this
one, and it's the most defensible thing on the page.

## 8. What would make this more than metaphor

A formalism earns its place by producing a claim you could be wrong about.
Candidates, roughly in order of how cheaply they could be tested:

1. Specialisation depth correlates with local Ollivier–Ricci curvature of the
   trust/trade graph. Testable on existing datasets. No product required.
2. Terms of trade contain a measurable risk premium that falls with network
   proximity — and the decay follows the metric of §3.
3. Market participation exhibits phase-locking: coordination, not just volume,
   predicts clearing.
4. The observer-invariant quantity of §2 exists and can be named.

If none of these can be stated sharply, the formalism is a language for
describing the system rather than a theory of it — which is still useful, but
should be labelled as such.

## 9. Track discipline

This is a **research track**. It runs alongside the product, and nothing in
`docs/architecture/02+` should block on it. The failure mode for a project with
a good mathematical intuition at its centre is that the formalism becomes the
work, indefinitely, because it's more enjoyable than regulatory questions and
never quite finished.

Concretely: the instrument question (Q76) gates the build. Curvature does not.

---

## 10. Variance is the missing index

The triple is **price, quantity, variance** — and adding the third fixes the
formalism rather than decorating it.

- **Quantity** — a vector. What you hold or produce.
- **Price** — a covector. Contracts with quantity to give value.
- **Variance** — a **rank-2 object**. Not a scalar: the covariance matrix
  `Σ_ij` of outcomes across goods and counterparties.

Variance is where the whole insurance story lives. Uncertainty about the
counterparty isn't a single number attached to a person — it's a covariance
structure across everything you might have specialised in. That's why the model
"can't be flat": a flat model has no room for the second moment.

It also settles the tensor question from §5. Value `p·q` is a rank-0 invariant.
The metric `g_ij` is rank-2. Covariance `Σ_ij` is rank-2 and transforms
correctly under change of basis in goods space. The formalism has genuine
rank-2 content, so tensor language is doing work rather than dressing.

## 11. The transformation is the object

The relativity intuition, stated precisely: what's wanted is not curvature or
field equations but the **transformation between observer frames** — the map
that takes `(p, q, Σ)` as *I* see it to `(p, q, Σ)` as *you* see it. Lorentz's
role, not Einstein's.

That's a well-posed mathematical request. What it needs, in order:

1. **What is a frame?** Presumably a position in the network — who you can
   reach, at what informational cost. Frame ≈ your row in the trust metric.
2. **What is the group?** Lorentz transformations form a group preserving the
   spacetime interval. What is the corresponding structure here — what
   composition law holds when you go from my frame to yours to a third party's?
   A transformation set that doesn't compose is a lookup table, not a geometry.
3. **What is preserved?** In relativity the interval is invariant. Here: value?
   Total obligation? Something involving `Σ`? **This is the crux.** A "relative
   fairness" that holds nothing invariant is just variability. The invariant is
   what makes it fairness.

Question 3 is the highest-value unsolved problem in the formalism, and it's the
one worth thinking about in the shower. It also has a direct product
consequence: whatever is invariant is what the ledger should record, because it's
the only thing all parties will agree on.

## 12. Feynman diagrams — the picture is right, and there's a rigorous version

The intuition: two point particles approach, exchange something, and each leaves
with a changed production vector. Trade as a scattering event; goods as momentum.

As a *picture* this is good, and worth drawing — it captures that trade changes
both parties' trajectories rather than just moving stock between them.

As *machinery*, be careful: Feynman diagrams are a bookkeeping device for a
perturbative sum over interaction histories, and their content is that
amplitudes **interfere**. That returns to the open question in §6 — without
cancellation, the diagrams are a notation rather than a method.

But there is a rigorous economic object with exactly the shape being reached
for. Trust propagating through a network is a **sum over all paths**, discounted
by length:

```
T = I + αA + α²A² + α³A³ + … = (I − αA)⁻¹        (α‖A‖ < 1)
```

Each term is "influence reaching you via paths of length k" — the network
analogue of summing diagrams by order. This is standard (Katz centrality, and
the Bonacich family), it converges under a stated condition, and it's the honest
version of the diagram intuition: **trust is a resolvent**. It's also precisely
the mechanism behind the copying layer in `01-thesis.md` §4 — copying your
neighbours is the second-order term.

If the edge weights carry direction as complex phase (§6a), this path sum runs
over a Hermitian operator and stays spectrally well-behaved. The direction
intuition, the Feynman intuition and the complex-number hunch converge on one
object.
