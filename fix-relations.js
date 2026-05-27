const fs = require('fs');
let content = fs.readFileSync('prisma/schema.prisma', 'utf8');

let changed = 0;
const lines = content.split('\n');
const newLines = [];
for (const line of lines) {
  if (line.includes('user_id Int @relation(fields: [user_id], references: [id])')) {
    newLines.push(line.replace('user_id Int @relation(fields: [user_id], references: [id])', 'user User @relation'));
    changed++;
  } else {
    newLines.push(line);
  }
}
content = newLines.join('\n');
console.log('Changed', changed, 'user_id @relation lines');
fs.writeFileSync('prisma/schema.prisma', content);
