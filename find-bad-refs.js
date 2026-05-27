const fs = require('fs');
const schema = fs.readFileSync('prisma/schema.prisma', 'utf8');
const lines = schema.split('\n');
lines.forEach((line, i) => {
  if (line.includes('@relation')) {
    const clean = line.trim();
    // Check for references: [something( or references: [modelname(
    if (clean.includes('references: [') && clean.match(/references: \/.*?\//)) {
      console.log('BAD LINE ' + (i+1) + ': ' + clean);
    }
    // Also look for (id) type patterns in references
    const refMatch = clean.match(/references: (\/[^\/]*\/|[^\/\n]+)/);
    if (refMatch && refMatch[1].includes('(')) {
      console.log('SUSPECT LINE ' + (i+1) + ': ' + clean);
    }
  }
});
console.log('Total lines: ' + lines.length);