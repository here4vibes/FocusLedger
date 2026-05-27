const fs = require('fs');
let c = fs.readFileSync('prisma/schema.prisma', 'utf8');

// Remove all @relation(fields: [X], references: [Y]) on Int fields
// Replace with plain "User" type reference that Prisma can infer
// For fields named user_id: keep Int type, remove @relation, Prisma infers FK
c = c.replace(/user_id Int @relation(fields: \bv\b, references: \bid\b)/g, 'user_id Int');
c = c.replace(/task_id Int @relation(fields: \btask_id\b, references: \bid\b)/g, 'task_id Int');

// Also clean up non-ASCII box-drawing chars in comments
c = c.replace(/\u2500/g, '-');
c = c.replace(/[^\u0009\u000a\u000d\u0020-\u007e\u2014\u2013]/g, '?');

fs.writeFileSync('prisma/schema.prisma', c);
console.log('Done');

// Verify
const lines = c.split('\n');
const relLines = lines.filter(l => l.includes('@relation'));
console.log('Remaining @relation lines:', relLines.length);
if (relLines.length > 0) console.log('Sample:', relLines[0]);
const sample = lines.find(l => l.includes('user_id Int'));
console.log('Sample user_id line:', sample);
