const fs = require('fs');
let content = fs.readFileSync('prisma/schema.prisma', 'utf8');

// Replace @relation(fields: [user_id], references: [id]) with just "User" type
// Prisma will auto-create FK field as userId with map:"user_id"
let changed = 0;
const lines = content.split('\n');
const newLines = [];
for (const line of lines) {
  if (line.includes('user_id Int @relation(fields: [user_id], references: [id])')) {
    newLines.push(line.replace('user_id Int @relation(fields: [user_id], references: [id])', 'user User @relation(map: "user_id")'));
    changed++;
  } else {
    newLines.push(line);
  }
}
content = newLines.join('\n');
console.log('Changed', changed, 'lines');
fs.writeFileSync('prisma/schema.prisma', content);
