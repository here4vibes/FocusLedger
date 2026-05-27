const fs = require('fs');
let c = fs.readFileSync('prisma/schema.prisma', 'utf8');

const patterns = [
  ['user_id Int @relation(fields: [user_id], references: [id])', 'user_id Int'],
  ['user_id Int? @relation(fields: [user_id], references: [id])', 'user_id Int?'],
  ['user_id Int @unique @relation(fields: [user_id], references: [id])', 'user_id Int @unique'],
  ['task_id Int @relation(fields: [task_id], references: [id])', 'task_id Int'],
  ['task_id Int? @relation(fields: [task_id], references: [id])', 'task_id Int?'],
  ['routine_id Int @relation(fields: [routine_id], references: [id])', 'routine_id Int'],
  ['routine_id Int? @relation(fields: [routine_id], references: [id])', 'routine_id Int?'],
  ['routine_id Int @unique @relation(fields: [routine_id], references: [id])', 'routine_id Int @unique'],
  ['pattern_id Int @relation(fields: [pattern_id], references: [id])', 'pattern_id Int'],
  ['plaid_item_id Int @relation(fields: [plaid_item_id], references: [id])', 'plaid_item_id Int'],
  ['plaid_account_id Int @relation(fields: [plaid_account_id], references: [id])', 'plaid_account_id Int'],
  ['category_id Int @relation(fields: [category_id], references: [id])', 'category_id Int'],
  ['category_id Int? @relation(fields: [category_id], references: [id])', 'category_id Int?'],
  ['value_id Int @relation(fields: [value_id], references: [id])', 'value_id Int'],
  ['value_id Int? @relation(fields: [value_id], references: [id])', 'value_id Int?'],
  ['promo_code_id Int @relation(fields: [promo_code_id], references: [id])', 'promo_code_id Int'],
  ['recurring_task_id Int? @relation(fields: [recurring_task_id], references: [id])', 'recurring_task_id Int?'],
  ['session_id String @relation(fields: [session_id], references: [id])', 'session_id String'],
  ['claimed_user_id Int? @relation(fields: [claimed_user_id], references: [id])', 'claimed_user_id Int?'],
  ['inviter_id Int @relation(fields: [inviter_id], references: [id])', 'inviter_id Int'],
  ['invitee_id Int? @relation(fields: [invitee_id], references: [id])', 'invitee_id Int?'],
  ['sender_id Int @relation(fields: [sender_id], references: [id])', 'sender_id Int'],
  ['receiver_id Int @relation(fields: [receiver_id], references: [id])', 'receiver_id Int'],
  ['source_template_id Int? @relation(fields: [source_template_id], references: [id])', 'source_template_id Int?'],
];

let totalReplaced = 0;
for (const [old, newVal] of patterns) {
  const count = (c.split(old).length - 1);
  if (count > 0) { totalReplaced += count; }
  c = c.split(old).join(newVal);
}

// Clean non-ASCII box-drawing chars from comments
c = c.replace(/\u2500/g, '-');
c = c.replace(/\u2014/g, '--');
c = c.replace(/\u2013/g, '-');

fs.writeFileSync('prisma/schema.prisma', c);
const lines = c.split('\n');
const relLines = lines.filter(l => l.includes('@relation'));
console.log('Replaced', totalReplaced);
console.log('@relation remaining:', relLines.length);
if (relLines.length > 0) relLines.forEach(l => console.log('  ' + l.trim().substring(0, 80)));
