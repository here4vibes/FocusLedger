#!/usr/bin/env node
// Fix 1: Remove onDelete: Cascade from all @relation attributes
// Fix 2: Fix onDelete: SetNull in @relation
// Fix 3: Fix PascalCase back-relation names
const fs = require('fs');
let content = fs.readFileSync('./prisma/schema.prisma', 'utf8');
const original = content;

// Fix 1: Remove onDelete: Cascade from @relation (keep cascade at DB migration level)
let count1 = 0;
content = content.replace(/, onDelete: Cascade\/?/g, () => { count1++; return ''; });
console.log('Removed onDelete: Cascade:', count1);

// Fix 2: Remove onDelete: SetNull from @relation
let count2 = 0;
content = content.replace(/, onDelete: SetNull\/?/g, () => { count2++; return ''; });
console.log('Removed onDelete: SetNull:', count2);

// Fix 3: Fix PascalCase back-relation names
content = content.replace(/RoutineSuggestion\/\//g, 'routine_suggestions//');
content = content.replace(/RoutineSuggestion\/\//g, 'routine_suggestions//');
content = content.replace(/FocusSession\/\//g, 'focus_session//');
// Fix PascalCase references in back-relations (e.g. "RoutineSuggestion?" -> "routine_suggestions?")
content = content.replace(/\bRoutineSuggestion\b/g, 'routine_suggestions');
content = content.replace(/\bFocusSession\b/g, 'focus_session');

fs.writeFileSync('./prisma/schema.prisma', content);
console.log('Schema fixed and written');