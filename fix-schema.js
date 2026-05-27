// Fix non-ASCII characters in schema.prisma
const fs = require('fs');
let content = fs.readFileSync('prisma/schema.prisma', 'utf8');

// Replace em-dash and other non-ASCII with ASCII equivalents
content = content.replace(/\u2014/g, '--');  // em-dash
content = content.replace(/\u2013/g, '-');   // en-dash
content = content.replace(/\u2500/g, '-');   // box-drawing
content = content.replace(/\u2501/g, '-');
content = content.replace(/[^\u0009\u000a\u000d\u0020-\u007e]/g, function(c) {
  return c.charCodeAt(0).toString(16);
});

fs.writeFileSync('prisma/schema.prisma', content);
console.log('Done');