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

## 2. Contact us (built)

- **The number** is 021 347 028, Andrew's mobile, kept once in
  `TALLI.contact` (`assets/talli-config.js`). `assets/contact-us.js` points
  every `data-talli-phone`, `data-talli-sms` and `data-talli-email` link
  at it; the markup carries the same number so it works without
  JavaScript. The confirmation email has its own copy in `stripe-webhook`
  (`TALLI_NIGHT_PHONE`). To move to a second number later, change both.
- **Before the night:** a Contact us section on the homepage. Email is
  recommended for most things, call or text for quick questions, plus a
  "Send us a message" form (message, name, email, phone; an email or a
  phone is required). `submit-contact` stores each message in
  `contact_message`, then emails it to bookings@ with Reply-To set to the
  sender. With no Resend key (the test project) it is stored and not
  emailed.
- **On the night:** "Text Andrew" on the homepage, and on the booking
  confirmation with the reference and plate already in the text. It is
  the main button from six hours before the event until six after. The
  confirmation email says to text, and gives the number.
- **Gate screen:** a car's sheet has Call and Text buttons, plus ready-made
  texts (lights on, please move, where are you?) that name the plate.
  Shown when the booking has a phone number, for wardens too.
- **Insights:** a Messages list for the operator, with Mark as answered.
- Every page footer links to the Contact us section.
- Still to do: the signs at each site (print), and a second number if
  Andrew wants one.

## 3. Morning-after message

A "How was last night?" message to each paid booking, linking to the
rating form with its `?s=`. It needs the email sending in
`stripe-webhook` pulled out so a scheduled job can use it.
