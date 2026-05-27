const fs = require('fs');
let c = fs.readFileSync('public/vault.html', 'utf8');

// 1. Add getDocMeta helper before renderGrid
const marker = '  // ── Render grid ────────────────────────────────────────────────────────────';
const idx = c.indexOf(marker);
if (idx === -1) { console.error('marker not found'); process.exit(1); }

const helperLines = [
  '  // ── Extract title + summary from metadata_json ─────────────────────────────',
  '  // Handles both fresh extraction (object) and double-encoded existing docs (string).',
  '  function getDocMeta(doc) {',
  "    var meta = doc.metadata_json;",
  "    if (!meta) return { title: null, summary: null, document_type: null };",
  "    if (typeof meta === 'string') {",
  '      try {',
  "        var inner = meta.replace(/^\u0060\u0060\u0060json\\n?/, '').replace(/\\n?\u0060\u0060\u0060$/, '').trim();",
  '        meta = JSON.parse(inner);',
  '      } catch (e) {',
  "        return { title: null, summary: null, document_type: null };",
  '      }',
  '    }',
  "    var title = meta._card_title || meta.document_type || null;",
  "    var summary = meta._plain_summary || meta.summary || null;",
  "    return { title: title, summary: summary, document_type: meta.document_type || null };",
  '  }',
  ''
];
const helper = helperLines.join('\n');
c = c.slice(0, idx) + helper + c.slice(idx);

// 2. Card title + summary on cards
const oldCard = "          '<div class=\"doc-name\">' + escHtml(doc.name) + '</div>' +";
const oldCardFound = c.includes(oldCard);
if (!oldCardFound) {
  console.error('oldCard not found');
  process.exit(1);
}
const newCardLines = [
  "          '<div class=\"doc-name\">' + escHtml((function() { var dm = getDocMeta(doc); return dm.title || doc.name; })()) + '</div>' +",
  "          (function() { var dm2 = getDocMeta(doc); if (!dm2.summary || !doc.ai_extracted) return ''; var s = dm2.summary; if (s.length > 80) s = s.slice(0,79) + '\\u2026'; return '<span class=\"doc-summary\" style=\"font-size:0.72rem;color:var(--text-muted);display:block;margin-top:0.15rem\">' + escHtml(s) + '</span>'; })() +"
];
c = c.replace(oldCard, newCardLines.join(' +\n          '));

// 3. Detail modal title
const oldDetail = "document.getElementById('detailName').textContent = doc.name;";
const newDetail = "var dm2 = getDocMeta(doc); document.getElementById('detailName').textContent = dm2.title || doc.name;";
const oldDetailFound = c.includes(oldDetail);
if (!oldDetailFound) {
  console.error('oldDetail not found');
  process.exit(1);
}
c = c.replace(oldDetail, newDetail);

// 4. openDetail metadata parsing for double-encoded JSON strings
const oldMetaCheck = "    var meta = doc.metadata_json;\n    var hasMeta = meta && typeof meta === 'object' && Object.keys(meta).length > 0;";
const newMetaCheckLines = [
  '    var rawMeta = doc.metadata_json;',
  '    var meta = rawMeta;',
  '    var hasMeta = false;',
  "    if (rawMeta) {",
  "      if (typeof rawMeta === 'string') {",
  '        try {',
  "          var inner3 = rawMeta.replace(/^\u0060\u0060\u0060json\\n?/, '').replace(/\\n?\u0060\u0060\u0060$/, '').trim();",
  '          meta = JSON.parse(inner3);',
  "          hasMeta = meta && typeof meta === 'object' && Object.keys(meta).length > 0;",
  '        } catch (e) { hasMeta = false; }',
  '      } else {',
  '        meta = rawMeta;',
  "        hasMeta = typeof meta === 'object' && Object.keys(meta).length > 0;",
  '      }',
  '    }'
];
const newMetaCheck = newMetaCheckLines.join('\n');
const oldMetaCheckFound = c.includes(oldMetaCheck);
if (!oldMetaCheckFound) {
  console.error('oldMetaCheck not found');
  process.exit(1);
}
c = c.replace(oldMetaCheck, newMetaCheck);

fs.writeFileSync('public/vault.html', c);
console.log('Done');