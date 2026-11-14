# Backlog after the A and B workstreams

Andrew's feedback from device-testing, recorded 14 Nov 2026 and checked
against what A1–A4 and B1–B8 delivered. Ticked items have landed on
`staging`. Device-test each one there before a release.

## Already delivered by A/B

- [x] **Footer "86 Paice Ave"** stays: it is the company address (A4).
      Marshal messages point at the booked area.
- [x] **QR on the gate screen**: Site guide shows the Locate Us card
      full-screen, then where-to-park pictures, then bank details (A4).
      *Still to do:* scan the card with a real phone, from a screen and
      from a photo of a print, before printing any.
- [x] **Gate selector as a tree**: All → area → site, every tab follows
      it, and Arrivals searches the cars in scope (B6).
- [x] **Getting Here lists every area**, and an old `?block=` link goes
      to that area's `/go/` page (A4).

## Done in this round

- [x] **Placement goes to the nearest house with the space paid for**
      (`20261123100000_talli_placement_nearest`). A Priority car whose
      Priority space here is gone is offered a Priority space along the
      street; it was offered nothing. Other houses are tried nearest
      first, where it was the anchor first. The warden still decides —
      *Parked at* overrides it.
- [x] **The car's sheet says which site it is booked into**, and where
      it was moved to.
- [x] **Booking page "All" chip**: each area once at "from $X", opening in
      place to its types and prices. A map pin under "All" opens that
      area. Standard stays the chip that is on by default.
- [x] **The chosen map pin is a different colour**, with a tick, and its
      card carries the same colour on its edge.
- [x] **Extras cards**: price top right, stepper bottom right, picture
      as tall as the card.
- [x] **Getting Here has a map**: Eden Park and a pill per area, each
      opening that area's `/go/` page.
- [x] **Prices by ring** (`20261124100000_talli_price_rings`): rings of
      200m around Eden Park, a price adjustment per ring and type, an area
      in its anchor's ring by default and in another by hand from the
      Sites page. Replaces B1's adjustment per area.

## Still open

- [ ] **What's On pictures**: the screen takes a picture per series (A1);
      find and upload one for each series. Check usage rights.
- [ ] **Moving a booking to another area**: operator only, after the
      Robbie Williams night. Decide which area's pool keeps the money and
      what happens to a price difference. Within an area, *Parked at*
      already does it, and wardens keep it.

## At release (prices by ring)

The migration starts each ring at the old per-area adjustment of an area
in it, and the reference site's ring at zero. **Any area in the same ring
as 86 Paice Ave now sells at Paice Ave's price.** The migration's NOTICE
lines name every area whose price moves. On the test project both
Gribblehurst and Paice Ave are 600–800m out (ring 4); the fixture puts
Gribblehurst in ring 5 by hand. Before confirming a night for sale after
release, open Sites for each area and check its ring and prices.
