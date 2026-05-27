const fs = require('fs');
const content = fs.readFileSync('prisma/schema.prisma', 'utf8');
// Check the exact @ sign in @relation
const atIdx = content.indexOf('@relation');
if (atIdx >= 0) {
  const before = content.substring(Math.max(0, atIdx-3), atIdx);
  const after = content.substring(atIdx, atIdx+20);
  console.log('Context around @relation: before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after));
  console.log('First @ char code:', content.charCodeAt(atIdx));
}
// Check if there are duplicate @relation on same line
const lines = content.split('\n');
lines.forEach((l, i) => {
  const count = (l.match(/@relation/g) || []).length;
  if (count > 1) console.log('Line ' + (i+1) + ' has ' + count + ' @relation: ' + l.trim().substring(0, 80));
});
// Check for any weird characters
for (let i = 0; i < Math.min(2000, content.length); i++) {
  const c = content.charCodeAt(i);
  if (c > 126 && c !== 9 && c !== 10 && c !== 13) {
    const line = content.substring(0, i).split('\n').length;
    console.log('Non-ASCII at pos ' + i + ' line ' + line + ': char=' + c + ' char=' + JSON.stringify(content[i]));
  }
}
console.log('Done');