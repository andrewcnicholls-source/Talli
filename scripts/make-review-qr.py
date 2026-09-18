#!/usr/bin/env python3
# =====================================================================
#  Talli — regenerate the Google-review QR code.
#
#      python3 scripts/make-review-qr.py            # the usual case
#      python3 scripts/make-review-qr.py <url>      # any other target
#
#  Writes print/review-qr.svg (vector, for anything printed) and
#  print/review-qr.png (raster, for anything on a screen).
#
#  Both are committed, so this script only needs running if the target
#  URL changes — and it should not. The QR points at talli.co.nz/review,
#  a page on our own site that forwards to Google. Pointing it straight
#  at a g.page link would mean every printed card dies the day that link
#  changes; this way the destination is one line of review.html.
#
#  Requires segno (`pip install segno`), a pure-Python QR encoder with
#  no image dependencies for SVG. PNG output needs Pillow as well; the
#  script says so rather than failing obscurely if it is missing.
# =====================================================================
import os
import sys

REVIEW_URL = 'https://talli.co.nz/review'
OUT_DIR = 'print'

# Talli's ink, not pure black, so the card matches the rest of the brand.
# Contrast against white is ~15:1 either way, far past what a scanner needs.
INK = '#1A1A1A'

try:
    import segno
except ImportError:
    sys.exit('segno is not installed. Run:  pip install segno')


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else REVIEW_URL

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(root, OUT_DIR)
    os.makedirs(out, exist_ok=True)

    # error='q' is 25% recovery: enough that a smudged, creased or
    # rain-spotted windscreen card still reads, without inflating the
    # module count the way 'h' would on a URL this short.
    qr = segno.make(url, error='q')

    svg = os.path.join(out, 'review-qr.svg')
    qr.save(svg, kind='svg', scale=10, border=4, dark=INK, light='#FFFFFF')

    png = os.path.join(out, 'review-qr.png')
    try:
        qr.save(png, kind='png', scale=24, border=4, dark=INK, light='#FFFFFF')
    except Exception as exc:                       # noqa: BLE001 - reported
        print('SVG written, PNG skipped (%s).' % exc)
        print('PNG output needs Pillow:  pip install pillow')
        return

    print('%s  version %s-%s, %d modules square'
          % (url, qr.version, qr.error.upper(), qr.symbol_size(border=0)[0]))
    for path in (svg, png):
        print('  %s  (%d bytes)' % (os.path.relpath(path, root),
                                    os.path.getsize(path)))


if __name__ == '__main__':
    main()
