# Google review QR code

A code on a windscreen card is the only realistic moment a customer will
leave a review: they are standing at the car, the night went fine, and
the alternative is remembering to do it at home.

## What's here

| File | What it is |
| --- | --- |
| `review-qr.svg` | the code itself, vector — use this for anything printed |
| `review-qr.png` | the same code, 888px — for a screen, a post, an email |
| `review-card.html` | four A6 cards on an A4 sheet, ready to print and cut |
| `review-cards-a4.pdf` | that sheet already rendered, for a print shop |

Regenerate the code with `python3 scripts/make-review-qr.py` (needs
`pip install segno`). The PDF is a rendering of `review-card.html` —
re-print the page from a browser if the card changes.

## It does not point at Google

The code encodes `https://talli.co.nz/review`, a page on our own site
that forwards to the Google review form. One hop more for the customer,
and one thing gained: **the destination is editable after the cards are
printed**. A code pointing straight at a `g.page` link is dead the day
that link changes, and every card in the box goes in the bin with it.

`review.html` is `noindex`, so it stays out of Google's index and out of
`sitemap.xml` — `scripts/check.sh` enforces the pairing.

## Changing the destination

`review.html` has a single constant near the bottom, and it is the only
thing that decides where a scanned card ends up:

```js
var GOOGLE_REVIEW_URL = 'https://g.page/r/CW5D_AL_8pSwECE/review';
```

Empty it and `/review` stops forwarding, showing its "search us in Google
Maps" fallback instead — which is also what a phone with JavaScript off
sees, so the page is never a dead end.

### Getting the link again

Signed in to the Google account that owns the Talli Business Profile:

1. Search **Talli Parking** on google.com, or open the Google Maps app and
   go to the **Business** tab.
2. In the profile management panel, choose **Ask for reviews** (sometimes
   **Get more reviews** / **Share review form**).
3. Copy the link. It looks like `https://g.page/r/XXXXXXXXXXXX/review`.

Paste that between the quotes. That is the whole change.

### If you'd rather use the Place ID

Google's [Place ID
Finder](https://developers.google.com/maps/documentation/places/web-service/place-id)
gives an ID starting `ChIJ…` for any listing. The review form is then:

```
https://search.google.com/local/writereview?placeid=ChIJ…
```

Either form works in the same constant.

## Printing

Print at **100% / Actual size**, not "fit to page". The QR is 46mm on the
card; below roughly 30mm it stops reading reliably on a phone held at
arm's length in a dark car park. Cut on the dotted lines.
