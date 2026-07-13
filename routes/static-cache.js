// Owns: static files that require special cache headers (service worker, CSS),
// and the landing page root route which must run before express.static so it
// cannot be shadowed by a Render persistent disk mounted at public/.
const path = require('path');
const fs = require('fs');

module.exports = function (app, rootDir) {
  // WHY no-store on sw.js: browser HTTP cache can hold stale service workers for
  // up to 24h. This caused 4 deploy failures where users never got fresh code.
  app.get('/sw.js', function (req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/javascript');
    res.sendFile(path.join(rootDir, 'public', 'sw.js'));
  });

  // WHY no-cache: science.css was extracted from inline <style> blocks that failed
  // to reach browsers across 5 deploys. must-revalidate forces the browser to check
  // with the server on every request, and the ?v= query string busts stale caches.
  app.get('/css/science.css', function (req, res) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(path.join(rootDir, 'public', 'css', 'science.css'));
  });

  // WHY views/ not public/: a Render persistent disk mounted at public/ would
  // shadow any file in that directory across deploys. By serving the landing page
  // from views/ (outside public/), every deploy gets the current version.
  // WHY before express.static: express.static would otherwise intercept GET /
  // by finding public/index.html and serving it directly, bypassing this handler.
  const landingPath = path.join(rootDir, 'views', 'index.html');
  app.get('/', function (req, res) {
      const html = fs.readFileSync(landingPath, 'utf8');
    const injected = html;
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.type('html').send(injected);
  });
};