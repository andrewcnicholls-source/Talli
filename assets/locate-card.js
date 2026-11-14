/* =====================================================================
   Talli Parking — the Locate Us card

   The card Andrew holds up at the driveway, made by the system for every
   site and parking area. Scanning it opens /go/<slug> on the Talli site;
   many people photograph it instead and read it later, so it also has to
   work as a picture:

     - "Talli Parking" across the top, in the brand display face;
     - a car, front on, as a line drawing (assets/locate-car.png), with the
       standard square QR code set in its front panel, between the
       headlights and under the hood line — nothing is drawn over the code
       but a small pin;
     - "Locate Us" with its pin, the street address in large type;
     - the page's short web address in text, so a photo alone is enough.

   Error correction is H (about 30% recoverable), which is what lets the
   pin sit in the middle and a photo taken at an angle still read. The
   code's white margin is two modules, not the spec's four, so the code
   fills its panel; the phone scan test is the check on that.

   One script, two users: the gate screen's Site guide (full screen, held
   up to a driver's window) and the Sites page (printed to A4 for a sign).
   Needs assets/vendor/qrcode-generator/qrcode.js loaded first.

     TalliCard.address(slug)          { url, text } for that slug here
     TalliCard.svg({ slug, address }) the card, as an SVG string
     TalliCard.print({ slug, address, title })  A4, in a new window
   ===================================================================== */
(function () {
  'use strict';

  var BLUE = '#2B4C7E';
  var BLUE_DEEP = '#1C3255';
  var INK = '#1A1A1A';
  var FONT = "Jost, 'Work Sans', Arial, sans-serif";
  // Brand faces, from style.css: Poiret One for display, Jost for body.
  var DISPLAY = "'Poiret One', 'Jost', sans-serif";

  var W = 600, H = 800;
  var TITLE_SIZE = 55.2;      // "Talli Parking": 15% larger than 48
  var LOCATE_SIZE = 72;
  // "Locate Us" in Poiret One at 72, measured in Chrome. The pin and the
  // words are centred as one group on the card's centre line from this.
  var LOCATE_W = 286.42;
  var PIN_H = 62, PIN_W = 46.5, PIN_GAP = 17;
  var LOCATE_BASE = 660;      // the baseline of "Locate Us"; the pin's tip sits on it

  // The car drawing (assets/locate-car.png) is 460 × 1024. The top car is
  // the crop below, placed on the card at CAR.
  var CAR_SRC = 'assets/locate-car.png';
  var CROP = { x: 100, y: 130, w: 260, h: 200 };
  var CAR = { x: 24, y: 130, w: 552 };
  // The QR tile in drawing coordinates: between the headlights, under the
  // hood line, down to the base of the car.
  var TILE = { x: 194, y: 209, s: 82 };
  var QUIET = 2;

  var seq = 0;

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Where the code points, and the same address as printed. Production is
  // always talli.co.nz — www and the apex are one site — so a card printed
  // from either never differs. Anywhere else (staging, a local server) it
  // is this host, so a test card scans to the test site and never to the
  // live one.
  function address(slug) {
    var cfg = window.TALLI || {};
    var host = cfg.environment === 'production' ? 'talli.co.nz' : window.location.host;
    var path = '/go/' + encodeURIComponent(String(slug || ''));
    var secure = cfg.environment === 'production' || window.location.protocol === 'https:';
    return { url: (secure ? 'https://' : 'http://') + host + path, text: host + path };
  }

  // "86 Paice Avenue, Sandringham, Auckland 1025" → "86 Paice Avenue".
  function street(addr) {
    return String(addr || '').split(',')[0].replace(/\s*\(.*?\)\s*/g, ' ').trim();
  }

  // The QR code as one path of unit squares, size × size, with a quiet zone
  // of QUIET modules. Null when the library is missing.
  function qrPath(url) {
    if (typeof window.qrcode !== 'function') return null;
    var qr = window.qrcode(0, 'H');
    qr.addData(url);
    qr.make();
    var n = qr.getModuleCount();
    var d = '';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += 'M' + (c + QUIET) + ' ' + (r + QUIET) + 'h1v1h-1z';
      }
    }
    return { d: d, size: n + QUIET * 2 };
  }

  // Text that may be long (an address, a web address) is squeezed to fit
  // the card rather than running off it.
  function fitText(x, y, size, max, weight, fill, text, font) {
    var guess = String(text).length * size * 0.56;
    var squeeze = guess > max
      ? ' textLength="' + max + '" lengthAdjust="spacingAndGlyphs"' : '';
    return '<text x="' + x + '" y="' + y + '" text-anchor="middle" font-family="' + esc(font || FONT) +
      '" font-size="' + size + '" font-weight="' + weight + '" fill="' + fill + '"' + squeeze + '>' +
      esc(text) + '</text>';
  }

  // A map pin with its tip at (x, y), height h.
  function pin(x, y, h, fill) {
    var k = h / 40;
    return '<g transform="translate(' + x + ' ' + y + ')">' +
      '<path transform="scale(' + k + ') translate(-15 -40)" fill="' + fill + '" ' +
      'd="M15 0C6.7 0 0 6.7 0 15c0 11.3 15 25 15 25s15-13.7 15-25C30 6.7 23.3 0 15 0z"/>' +
      '<circle cx="0" cy="' + (-25 * k) + '" r="' + (5.5 * k) + '" fill="#fff"/></g>';
  }

  // The QR code on a white tile inside the drawing, with the pin at its centre.
  function code(q) {
    var t = TILE;
    var k = t.s / q.size;
    var cx = t.x + t.s / 2, cy = t.y + t.s / 2;
    var r = t.s * 0.075;
    return '<rect x="' + t.x + '" y="' + t.y + '" width="' + t.s + '" height="' + t.s + '" fill="#fff"/>' +
      '<path transform="translate(' + t.x + ' ' + t.y + ') scale(' + k + ')" d="' + q.d +
        '" fill="' + INK + '" shape-rendering="crispEdges"/>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="#fff"/>' +
      pin(cx, cy + r * 0.85, t.s * 0.12, BLUE);
  }

  // Pushes the drawing's off-white paper to pure white and keeps its black lines.
  function whiten(id) {
    var f = '<feFuncX type="linear" slope="8" intercept="-5.7"/>';
    return '<filter id="' + id + '" color-interpolation-filters="sRGB"><feComponentTransfer>' +
      f.replace('X', 'R') + f.replace('X', 'G') + f.replace('X', 'B') +
      '</feComponentTransfer></filter>';
  }

  function svg(opts) {
    var where = address(opts.slug);
    var qr = qrPath(where.url);
    var line = street(opts.address) || opts.address || '';
    var id = 'locate-card-' + (++seq);

    // "Locate Us" and its pin, centred as one group.
    var group = PIN_W + PIN_GAP + LOCATE_W;
    var left = 300 - group / 2;
    var pinX = left + PIN_W / 2;
    var textX = left + PIN_W + PIN_GAP;

    // The crop of the drawing, scaled onto the card. A group and a clip path
    // rather than a nested <svg>, so the card stays a single svg element.
    var s = CAR.w / CROP.w;
    var car = '<defs>' + whiten(id + '-w') +
      '<clipPath id="' + id + '-c"><rect x="' + CROP.x + '" y="' + CROP.y + '" width="' + CROP.w +
        '" height="' + CROP.h + '"/></clipPath></defs>' +
      '<g transform="translate(' + CAR.x + ' ' + CAR.y + ') scale(' + s + ') translate(' + (-CROP.x) + ' ' + (-CROP.y) + ')">' +
      '<g clip-path="url(#' + id + '-c)">' +
      '<image href="' + esc(new URL(CAR_SRC, window.location.href).href) + '" x="0" y="0" width="460" height="1024" ' +
      'preserveAspectRatio="none" filter="url(#' + id + '-w)"/>' +
      (qr ? code(qr) : '') +
      '</g></g>';

    var noCode = qr ? '' : '<text x="' + TILE.x + '" y="' + (TILE.y + TILE.s / 2) +
      '" font-family="' + esc(FONT) + '" font-size="18" fill="' + INK + '">The QR code could not be drawn.</text>';

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" ' +
      'role="img" aria-label="' + esc('Talli Parking — Locate Us — ' + line + ' — ' + where.text) + '">' +
      '<rect width="' + W + '" height="' + H + '" fill="#fff"/>' +
      '<text x="300" y="76" text-anchor="middle" font-family="' + esc(DISPLAY) + '" font-size="' + TITLE_SIZE +
        '" fill="' + BLUE_DEEP + '">Talli Parking</text>' +
      car + noCode +
      pin(pinX, LOCATE_BASE, PIN_H, BLUE) +
      '<text x="' + textX + '" y="' + LOCATE_BASE + '" font-family="' + esc(DISPLAY) + '" font-size="' + LOCATE_SIZE +
        '" fill="' + INK + '" textLength="' + LOCATE_W + '" lengthAdjust="spacing">Locate Us</text>' +
      fitText(300, 716, 40, 540, 500, INK, line) +
      fitText(300, 760, 28, 540, 400, BLUE, where.text) +
      '</svg>';
  }

  // The card on its own A4 page, in a new window, and the print dialog.
  // The window is opened from the click, so a pop-up blocker allows it.
  function print(opts) {
    var w = window.open('', '_blank');
    if (!w) return false;
    var title = 'Locate Us — ' + (street(opts.address) || opts.slug);
    w.document.open();
    w.document.write('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
      '<title>' + esc(opts.title || title) + '</title>' +
      '<link href="https://fonts.googleapis.com/css2?family=Jost:wght@400;500&family=Poiret+One&display=swap" rel="stylesheet">' +
      '<style>@page{size:A4 portrait;margin:10mm}html,body{margin:0;background:#fff}' +
      '.sheet{display:flex;align-items:center;justify-content:center;height:277mm}' +
      '.sheet svg{height:100%;width:auto;max-width:190mm}' +
      '@media screen{body{padding:16px}.sheet{height:90vh}}</style></head><body>' +
      '<div class="sheet">' + svg(opts) + '</div>' +
      '<script>(document.fonts?document.fonts.ready:Promise.resolve()).then(function(){' +
      'setTimeout(function(){window.print()},150)});<\/script></body></html>');
    w.document.close();
    return true;
  }

  window.TalliCard = { address: address, svg: svg, print: print, street: street };
})();
