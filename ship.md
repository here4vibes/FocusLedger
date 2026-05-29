# Ship Checklist

Run the full pre-ship checklist for FocusLedger before any deploy to main.

## Steps

1. **Syntax check**
   ```bash
   node --check server.js
   ```

2. **Dependency check** — scan for any `require()` of packages not in package.json
   ```bash
   node -e "const pkg = require('./package.json'); console.log('deps:', Object.keys(pkg.dependencies).length)"
   ```

3. **Git status** — confirm no uncommitted changes, no secrets staged
   ```bash
   git status
   git diff --cached --name-only
   ```

4. **Migration check** — list any migration files and confirm they've been run on Neon
   ```bash
   ls migrations/
   ```

5. **Shared CSS/nav audit** — if any of these files were changed, flag them:
   - `public/shared-nav.css`
   - `public/shared-nav.js`  
   - `public/buddy-widget.css`
   - Any file in `public/css/`

6. **Report** — summarize what passed, what needs attention, whether it's safe to merge to main

$ARGUMENTS
