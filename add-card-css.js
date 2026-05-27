// Add CSS for simplified task card layout
const fs = require('fs');
const content = fs.readFileSync('public/app.html', 'utf8');

// Find the line: "        .task-card:hover {"
// and add the new CSS after the closing "}"
const marker = '        .task-card:hover {\n            box-shadow: 0 4px 16px rgba(45, 42, 38, 0.06);\n        }';

const newCSS = `        .task-card:hover {
            box-shadow: 0 4px 16px rgba(45, 42, 38, 0.06);
        }
        /* Simplified task card layout */
        .task-card {
            display: flex;
            flex-direction: column;
            gap: 0.25rem;
        }
        .task-card-row1 {
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .task-card-title {
            font-size: 0.95rem;
            color: var(--navy);
            line-height: 1.3;
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .task-card-title.struck {
            text-decoration: line-through;
            color: #B0ADA8;
        }
        .task-card-chevron {
            font-size: 1.1rem;
            color: var(--text-muted);
            flex-shrink: 0;
            margin-left: 0.5rem;
        }
        .task-card-row2 {
            display: flex;
            align-items: center;
            gap: 0.4rem;
            flex-wrap: wrap;
        }
        .task-card-value {
            font-size: 0.78rem;
            font-weight: 500;
        }
        .task-card-time {
            font-size: 0.78rem;
            color: var(--text-muted);
        }`;

if (content.includes(marker)) {
    const newContent = content.replace(marker, newCSS);
    fs.writeFileSync('public/app.html', newContent);
    console.log('CSS added successfully');
} else {
    console.error('Could not find marker in file');
    // Try to find the task-card-hover section
    const idx = content.indexOf('.task-card:hover');
    if (idx !== -1) {
        console.log('Found .task-card:hover at index', idx);
    }
}