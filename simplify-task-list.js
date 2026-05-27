// Script to simplify renderTasks in app.html
const fs = require('fs');
const content = fs.readFileSync('public/app.html', 'utf8');

// The simplified task card generation - much simpler than the original
const newCardCode = `            tasksToRender.forEach(function(task) {
                // Look up value for this task
                var taskVal = task.value_id ? (state.values || []).find(function(v) { return v.id === task.value_id; }) : null;
                // Format time estimate
                var timeStr = '';
                if (task.duration_minutes) {
                    timeStr = task.duration_minutes < 60
                        ? task.duration_minutes + ' min'
                        : (task.duration_minutes % 60 === 0
                            ? (task.duration_minutes / 60) + ' hr'
                            : Math.floor(task.duration_minutes / 60) + 'h ' + (task.duration_minutes % 60) + 'm');
                }
                html += '<a class="task-card" href="/app/task/' + task.id + '" data-task-id="' + task.id + '" style="text-decoration:none;color:inherit;">';
                // Row 1: Title + chevron
                html += '<div class="task-card-row1">';
                if (task.is_completed) {
                    html += '<span class="task-card-title struck">' + escapeHtml(task.title) + '</span>';
                } else {
                    html += '<span class="task-card-title">' + escapeHtml(task.title) + '</span>';
                }
                html += '<span class="task-card-chevron">&#8250;</span>';
                html += '</div>';
                // Row 2: Value + time
                var row2 = '';
                if (taskVal) {
                    row2 += '<span class="task-card-value" style="color:' + escapeHtml(taskVal.color || '#c9a84c') + ';">' + (taskVal.icon || '') + ' ' + escapeHtml(taskVal.value_name) + '</span>';
                }
                if (timeStr) {
                    if (row2) row2 += ' \u00b7 ';
                    row2 += '<span class="task-card-time">' + escapeHtml(timeStr) + '</span>';
                }
                if (row2) {
                    html += '<div class="task-card-row2">' + row2 + '</div>';
                }
                html += '</a>';
            });`;

// Find the start of the tasksToRender.forEach block
// Look for the pattern starting at line 8272
const lines = content.split('\n');

// Find line index where tasksToRender.forEach starts
let startIdx = -1;
for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('tasksToRender.forEach(function(task)')) {
        startIdx = i;
        break;
    }
}

if (startIdx === -1) {
    console.error('Could not find tasksToRender.forEach');
    process.exit(1);
}

// Now find where this block ends - it ends at the closing of the completed section tasks
// Look for the pattern: "});" that closes the tasksToRender.forEach
// The block starts at startIdx and should end before "            // Collapsible completed section"
let endIdx = -1;
for (let i = startIdx + 1; i < lines.length; i++) {
    // Look for the closing of the forEach + the completed section header comment
    if (lines[i].includes('// Collapsible completed section')) {
        endIdx = i - 1;
        break;
    }
}

if (endIdx === -1) {
    console.error('Could not find end of tasksToRender.forEach block');
    process.exit(1);
}

console.log('Found tasksToRender block from line', startIdx + 1, 'to', endIdx + 1);

// Check if the block contains the expected content (to verify we're replacing the right section)
const blockLines = lines.slice(startIdx, endIdx + 1);
const blockText = blockLines.join('\n');

if (!blockText.includes('var hasSteps = task.steps')) {
    console.error('Block does not contain expected content - aborting');
    process.exit(1);
}

// Now build the new content
const beforeBlock = lines.slice(0, startIdx).join('\n');
const afterBlock = lines.slice(endIdx + 1).join('\n');

// The new content: simplified tasksToRender.forEach + completed section (simplified)
const newContent = beforeBlock + '\n' + newCardCode + '\n\n' + afterBlock;

// Verify the replacement looks right
console.log('New content length:', newContent.length);
console.log('Original length:', content.length);

// Check for the completed section - we need to simplify it too
// Look for the completedTasks.forEach section
const completedSectionStart = newContent.indexOf('completedTasks.forEach(function(task) {');
if (completedSectionStart !== -1) {
    console.log('Found completed section at index', completedSectionStart);
}

// Write the new content
fs.writeFileSync('public/app.html', newContent);
console.log('File written successfully');