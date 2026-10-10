// report-errors.js: report this page's JavaScript errors to the server log, so
// problems on phones (no devtools) can be read with ~/webdata/bin/webdata-errors.
//
// A classic script, not a module, loaded first in <head>: it must be running
// before any module, because a module that fails to load or link never runs
// its own error handling. Errors go out as GET /_client-error?...; the server
// answers 404 and the access log keeps the query string. At most 5 per page.
(function () {
  // webdata-bake's headless renders report their own failures to webdata-sync.
  if (/[?&]kit-bake\b/.test(location.search)) { window.__reportError = function () {}; return; }
  var sent = 0;
  function send(kind, message, source, line, col) {
    if (sent >= 5) return;
    sent += 1;
    var q = [
      'k=' + encodeURIComponent(kind),
      'm=' + encodeURIComponent(String(message).slice(0, 600)),
      's=' + encodeURIComponent(String(source || '').slice(0, 200)),
      'l=' + (line || 0) + ':' + (col || 0),
      'p=' + encodeURIComponent(location.pathname),
      't=' + Date.now(),
    ].join('&');
    try { fetch('/_client-error?' + q, { cache: 'no-store', keepalive: true }); } catch (e) { /* nothing to do */ }
  }
  // Capture phase also sees failed <script>/<link> loads, which don't bubble.
  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t !== window && (t.src || t.href)) send('load', 'failed to load ' + (t.src || t.href), t.src || t.href);
    else send('error', e.message || 'error', e.filename, e.lineno, e.colno);
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    send('rejection', (r && (r.stack || r.message)) || r);
  });
  // kit.js reports errors it catches itself (render failures) through this.
  window.__reportError = send;
})();
