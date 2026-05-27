const fs = require('fs');
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
console.log('Lockfile version:', lock.lockfileVersion);
console.log('dependencies.prisma:', lock.dependencies && lock.dependencies.prisma);
console.log('dependencies.@prisma/client:', lock.dependencies && lock.dependencies['@prisma/client']);
const pkgs = lock.packages || {};
const keys = Object.keys(pkgs).filter(k => k.includes('@prisma/client'));
console.log('Prisma client packages:', keys);
keys.forEach(k => console.log(k + ': ' + JSON.stringify(pkgs[k].version)));