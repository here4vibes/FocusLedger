const fs = require('fs');
const content = fs.readFileSync('prisma/schema.prisma', 'utf8');
const lines = content.split('\n');
// Show exact bytes of line 768
const line768 = lines[767];
console.log('Line 768:', JSON.stringify(line768));
console.log('Line 768 length:', line768.length);

// Check for any other issues
// Are there duplicate @relation on same line?
lines.forEach((l, i) => {
  const rels = l.match(/@relation/g);
  if (rels && rels.length > 1) {
    console.log('DUPLICATE @relation on line', i+1, ':', l);
  }
});

// Check if any @relation lines have extra characters before @
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (l.includes('@relation')) {
    const atPos = l.indexOf('@relation');
    const before = l.substring(Math.max(0, atPos-5), atPos);
    if (before.trim() && !before.endsWith(' ')) {
      console.log('No space before @relation on line', i+1, ':', JSON.stringify(before));
    }
  }
}

console.log('Total @relation lines:', lines.filter(l => l.includes('@relation')).length);
console.log('Total lines in schema:', lines.length);