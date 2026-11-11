# qrcode-generator 1.4.4

`qrcode.js` is the unmodified `qrcode.js` from the npm package
`qrcode-generator@1.4.4` (Kazuhiko Arase, MIT licence; the licence header
is at the top of the file). Vendored so the gate screen can draw a QR code
with no network call and no build step.

Used by the walk-up "Card by QR" sheet in `assets/admin.js`. The plan's
site guide (A4) uses the same copy.

To update: `npm pack qrcode-generator@<version>`, copy `package/qrcode.js`
here unchanged, and change the version in this file and in `admin.html`.
