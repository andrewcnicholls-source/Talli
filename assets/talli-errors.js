/* =====================================================================
   Talli — report what went wrong in the browser

   Loaded on every page, straight after talli-config.js. It catches the
   errors a page did not handle — a script that threw, a promise nobody
   caught — and sends a short report to the client-error edge function,
   which writes it to the same log as the server's own lines.

   Pages also call it for failures they did handle but someone should
   still hear about: a request that came back 5xx, or never came back.

     TalliErrors.report(err, { context: 'create-checkout', status: 502, ref })

   Deliberately small and deliberately quiet:

   - It never throws, never shows anything, and never retries. Reporting
     an error must not become a second one.
   - At most five reports a page load, and the same message once.
   - The page's query string and fragment are never sent: the
     confirmation page carries the Checkout Session id there. Nor is
     anything a customer typed. The server scrubs emails and keys from
     whatever does arrive, as it does for every log line.
   ===================================================================== */
(function () {
  'use strict';

  var MAX_REPORTS = 5;
  var sent = 0;
  var seen = {};

  function str(v, max) {
    if (v === undefined || v === null) return undefined;
    var s = String(v);
    return s.length > max ? s.slice(0, max) : s;
  }

  function where(u) {
    try {
      var url = new URL(u, window.location.href);
      return url.origin === window.location.origin ? url.pathname : url.origin + url.pathname;
    } catch (e) {
      return undefined;
    }
  }

  function report(err, extra) {
    try {
      var cfg = window.TALLI || {};
      if (!cfg.supabaseUrl || !cfg.anonKey || sent >= MAX_REPORTS) return;
      extra = extra || {};

      var message = err && err.message !== undefined ? err.message : err;
      message = str(message, 500) || '(no message)';
      var key = (extra.context || '') + '|' + message;
      if (seen[key]) return;
      seen[key] = true;
      sent++;

      var payload = {
        kind: str(extra.kind || 'handled', 40),
        message: message,
        page: window.location.pathname,
        source: extra.source ? where(extra.source) : undefined,
        line: extra.line,
        col: extra.col,
        stack: str(err && err.stack, 1500),
        ref: str(extra.ref, 16),
        status: extra.status,
        context: str(extra.context, 200),
        environment: cfg.environment,
      };

      fetch(cfg.supabaseUrl + '/functions/v1/client-error', {
        method: 'POST',
        // Still delivered when the error is the last thing before the
        // page goes away — a redirect to Stripe, a closed tab.
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          apikey: cfg.anonKey,
          Authorization: 'Bearer ' + cfg.anonKey,
        },
        body: JSON.stringify(payload),
      }).catch(function () { /* nowhere left to report it */ });
    } catch (e) {
      /* never let reporting become the error */
    }
  }

  window.addEventListener('error', function (e) {
    // Resource failures (an image that 404s) do not reach window; what
    // does is a script error. "Script error." with no detail is a
    // cross-origin script (a map tile, an extension) and says nothing.
    if (!e || e.message === 'Script error.') return;
    report(e.error || e.message, {
      kind: 'uncaught', source: e.filename, line: e.lineno, col: e.colno,
    });
  });

  window.addEventListener('unhandledrejection', function (e) {
    report(e && e.reason, { kind: 'unhandledrejection' });
  });

  // A request that failed in a way somebody here should hear about: the
  // server broke (5xx), or the request never got there (no status). A 4xx
  // is the system answering as designed — sold out, signed out — and is
  // the server's own log line already, so it is not reported again.
  function failed(context, status, data, err) {
    if (status && status < 500) return;
    report(err || new Error(context + ' answered ' + status), {
      kind: status ? 'server' : 'network',
      context: context,
      status: status,
      ref: data && data.ref,
    });
  }

  window.TalliErrors = { report: report, failed: failed };
})();
