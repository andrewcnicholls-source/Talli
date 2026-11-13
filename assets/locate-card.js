/* =====================================================================
   Talli Parking — the Locate Us card (plan A4)

   The card Andrew holds up at the driveway, made by the system for every
   site and parking area. Scanning it opens /go/<slug> on the Talli site;
   many people photograph it instead and read it later, so it also has to
   work as a picture:

     - "Talli Parking", so it is recognised as ours at a glance;
     - a car, as on the card in use, with a standard square QR code set
       in its body — the car is for recognition, the square is for
       scanning, and nothing is drawn over the code but a small pin;
     - "Locate Us" and the street address in large type;
     - the page's short web address in text, so a photo alone is enough.

   Error correction is H (about 30% recoverable), which is what lets the
   pin sit in the middle and a photo taken at an angle still read.

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

  // The QR code as one path of unit squares, size × size, quiet zone
  // included. Null when the library is missing.
  function qrPath(url) {
    if (typeof window.qrcode !== 'function') return null;
    var qr = window.qrcode(0, 'H');
    qr.addData(url);
    qr.make();
    var n = qr.getModuleCount();
    var quiet = 4;
    var d = '';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += 'M' + (c + quiet) + ' ' + (r + quiet) + 'h1v1h-1z';
      }
    }
    return { d: d, size: n + quiet * 2 };
  }

  // Text that may be long (an address, a web address) is squeezed to fit
  // the card rather than running off it.
  function fitText(x, y, size, max, weight, fill, text) {
    var guess = String(text).length * size * 0.56;
    var squeeze = guess > max
      ? ' textLength="' + max + '" lengthAdjust="spacingAndGlyphs"' : '';
    return '<text x="' + x + '" y="' + y + '" text-anchor="middle" font-family="' + esc(FONT) +
      '" font-size="' + size + '" font-weight="' + weight + '" fill="' + fill + '"' + squeeze + '>' +
      esc(text) + '</text>';
  }

  // A map pin, its point at (0, 0), height h.
  function pin(h, fill) {
    var s = h / 40;
    return '<path transform="scale(' + s + ') translate(-15 -40)" fill="' + fill + '" ' +
      'd="M15 0C6.7 0 0 6.7 0 15c0 11.3 15 25 15 25s15-13.7 15-25C30 6.7 23.3 0 15 0z"/>' +
      '<circle cx="0" cy="' + (-25 * s) + '" r="' + (5.5 * s) + '" fill="#fff"/>';
  }

  function svg(opts) {
    var where = address(opts.slug);
    var qr = qrPath(where.url);
    var line = street(opts.address) || opts.address || '';

    // The car, front on: cabin and windscreen above, the body below with
    // the code in it, mirrors, and the wheels underneath. 600 × 960.
    var car = [
      // wheels
      '<rect x="104" y="690" width="78" height="64" rx="16" fill="' + BLUE_DEEP + '"/>',
      '<rect x="418" y="690" width="78" height="64" rx="16" fill="' + BLUE_DEEP + '"/>',
      // mirrors
      '<path d="M86 300 h-42 a16 16 0 0 0 0 32 h42z" fill="' + BLUE + '"/>',
      '<path d="M514 300 h42 a16 16 0 0 1 0 32 h-42z" fill="' + BLUE + '"/>',
      // cabin and windscreen
      '<path d="M160 120 h280 q22 0 30 20 l48 132 h-436 l48 -132 q8 -20 30 -20z" fill="#fff" stroke="' +
        BLUE + '" stroke-width="10" stroke-linejoin="round"/>',
      '<path d="M178 146 h244 l36 108 h-316z" fill="' + '#EEF2F7' + '" stroke="' + BLUE +
        '" stroke-width="5" stroke-linejoin="round"/>',
      // body
      '<rect x="78" y="268" width="444" height="440" rx="44" fill="#fff" stroke="' + BLUE +
        '" stroke-width="10"/>',
      // headlights, either side of the code
      '<rect x="92" y="300" width="16" height="44" rx="8" fill="' + BLUE + '"/>',
      '<rect x="492" y="300" width="16" height="44" rx="8" fill="' + BLUE + '"/>',
    ].join('');

    // The code: a square inside the body, never over its outline.
    var code = '';
    var box = 372;
    var bx = 300 - box / 2;
    var by = 302;
    if (qr) {
      var scale = box / qr.size;
      code = '<g transform="translate(' + bx + ' ' + by + ') scale(' + scale + ')">' +
        '<rect width="' + qr.size + '" height="' + qr.size + '" fill="#fff"/>' +
        '<path d="' + qr.d + '" fill="' + INK + '" shape-rendering="crispEdges"/></g>' +
        // The pin at the centre: about 2% of the code, well inside what H
        // error correction recovers.
        '<circle cx="300" cy="' + (by + box / 2) + '" r="27" fill="#fff"/>' +
        '<g transform="translate(300 ' + (by + box / 2 + 19) + ')">' + pin(40, BLUE) + '</g>';
    } else {
      code = fitText(300, by + box / 2, 22, 340, 400, INK, 'The QR code could not be drawn.');
    }

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 960" ' +
      'role="img" aria-label="' + esc('Talli Parking — Locate Us — ' + line + ' — ' + where.text) + '">' +
      '<rect width="600" height="960" fill="#fff"/>' +
      fitText(300, 76, 44, 520, 500, BLUE_DEEP, 'Talli Parking') +
      car + code +
      '<g transform="translate(150 842)">' + pin(62, BLUE) + '</g>' +
      '<text x="190" y="836" font-family="' + esc(FONT) + '" font-size="66" font-weight="500" fill="' +
        INK + '">Locate Us</text>' +
      fitText(300, 892, 40, 540, 500, INK, line) +
      fitText(300, 936, 28, 540, 400, BLUE, where.text) +
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
      '<link href="https://fonts.googleapis.com/css2?family=Jost:wght@400;500&display=swap" rel="stylesheet">' +
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
