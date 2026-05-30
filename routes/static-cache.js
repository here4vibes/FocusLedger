// Owns: static files that require special cache headers (service worker, CSS).
// Does NOT own: general static file serving (express.static in server.js).
const path = require('path');

module.exports = function (app, __dirname) {
  // WHY no-store on sw.js: browser HTTP cache can hold stale service workers for
  // up to 24h. This caused 4 deploy failures where users never got fresh code.
  app.get('/sw.js', function (req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/javascript');
    res.sendFile(path.join(__dirname, 'public', 'sw.js'));
  });

  // WHY no-cache: science.css was extracted from inline <style> blocks that failed
  // to reach browsers across 5 deploys. must-revalidate forces the browser to check
  // with the server on every request, and the ?v= query string busts stale caches.
  app.get('/css/science.css', function (req, res) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'css', 'science.css'));
  });
};