# Reviews and contact

From the feedback after the 23 November night: people want to say how it
went, and need an easy way to reach us before and during the night.

Three slices, built in this order. Each one ships on its own.

## 1. Rate us (this branch)

A "How was your night?" section at the bottom of the homepage.

- **Form:** 1–5 stars (required), a comment, a name, and contact
  details "only if you'd like a reply". All optional except the stars.
- **Where you parked:** a list of the active sites by name ("86 Paice
  Ave", never the full address), plus "Not sure".
  Optional. Two quick thumbs (easy to find, easy to get out) attach
  feedback to the site itself, separate from the overall rating.
- **From a booking:** if the page is opened with `?s=<checkout session>`,
  the review is tied to that booking. The site is where the car
  *actually* was (`booking.property_id`), the night is the booking's
  event, and the site list is not shown. One review per booking; sending
  it again updates the first one. The booking confirmation page links
  there now, and the morning-after message (slice 3) will too.
- **Storage:** a `review` table that nothing outside the service role
  can read or write. The `submit-review` edge function is the only way
  in. A hidden honeypot field and a limit on length keep the junk out.
  A limit on how often one person can submit waits for a real problem,
  because the function has no reliable caller address to key it on.
- **After sending:** everyone, whatever they rated, sees the same
  "Would you also put that on Google?" link. Asking only the happy ones
  is review gating, which Google's rules forbid.
- **Reading them:** a Reviews section in the gate screen's Insights tab,
  operator-only (`reviews` is in `OPERATOR_ONLY`). It shows the overall
  average, each site's average with its thumbs, and the latest comments.
  Nothing is published on the website. Quoting chosen reviews publicly
  is a later decision.

## 2. Contact us

- Before the night: email stays primary. A short contact form (name,
  email, optional phone, message) plus the phone number with "call or
  text, best for quick questions".
- On the night: a "Text Andrew" `sms:` link prefilled with booking
  reference and plate, prominent during the event window, on the
  confirmation page and the reminder. Signs at each site with the same
  number and a QR code.
- Gate screen: tap-to-call and tap-to-text on a car's sheet, with
  ready-made messages (lights on, please move your car).
- Open question: personal mobile or a second number for the night.

## 3. Morning-after message

A "How was last night?" message to each paid booking, linking to the
rating form with its `?s=`. It needs the email sending in
`stripe-webhook` pulled out so a scheduled job can use it.
