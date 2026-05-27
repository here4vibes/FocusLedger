// Script to simplify the completed task section in app.html
const fs = require('fs');
const content = fs.readFileSync('public/app.html', 'utf8');

// The new simplified completed task card
const newCompletedCard = `                completedTasks.forEach(function(task) {
                    html += '<a class="task-card" href="/app/task/' + task.id + '" data-task-id="' + task.id + '" style="text-decoration:none;color:inherit;">';
                    html += '<div class="task-card-row1">';
                    html += '<span class="task-card-title struck">' + escapeHtml(task.title) + '</span>';
                    html += '<span class="task-card-chevron">&#8250;</span>';
                    html += '</div>';
                    html += '</a>';
                });`;

// Find the completedTasks.forEach block
const lines = content.split('\n');
let startIdx = -1;
for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('completedTasks.forEach(function(task)')) {
        startIdx = i;
        break;
    }
}

if (startIdx === -1) {
    console.error('Could not find completedTasks.forEach');
    process.exit(1);
}

// Find the end of this block - it should end at the closing '</div>' for completed-section-tasks
let endIdx = -1;
for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].includes("html += '</div>'; // completed-section-tasks")) {
        endIdx = i;
        break;
    }
}

if (endIdx === -1) {
    console.error('Could not find end of completedTasks.forEach block');
    process.exit(1);
}

console.log('Found completed section from line', startIdx + 1, 'to', endIdx + 1);

// Verify the block content
const blockLines = lines.slice(startIdx, endIdx + 1);
const blockText = blockLines.join('\n');

if (blockText.includes('task-card-main') === false) {
    console.error('Block does not contain expected content - aborting');
    process.exit(1);
}

// Build new content
const before = lines.slice(0, startIdx).join('\n');
const after = lines.slice(endIdx + 1).join('\n');
const newContent = before + '\n' + newCompletedCard + '\n            ' + after;

fs.writeFileSync('public/app.html', newContent);
console.log('Completed section simplified');