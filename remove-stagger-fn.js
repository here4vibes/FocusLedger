// Script to remove the staggerReveal function
const fs = require('fs');
const content = fs.readFileSync('public/app.html', 'utf8');
const lines = content.split('\n');

// Find the staggerReveal function block
let startIdx = -1;
for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('// ── Stagger-fade reveal')) {
        startIdx = i;
        break;
    }
}

if (startIdx === -1) {
    console.log('staggerReveal already removed');
    process.exit(0);
}

// Function ends at line 11143 (the closing }), with 2 empty lines after
// Remove lines startIdx to startIdx + 16 (comment + 14-line function + 2 empty)
let endIdx = startIdx + 17;  // exclusive end

console.log('Removing staggerReveal from line', startIdx+1, 'to', endIdx);
console.log('Start:', lines[startIdx].substring(0,80));
console.log('End:', lines[endIdx-1].substring(0,80));

const before = lines.slice(0, startIdx).join('\n');
const after = lines.slice(endIdx).join('\n');
const newContent = before + '\n' + after;

fs.writeFileSync('public/app.html', newContent);
console.log('Done. New length:', newContent.length);