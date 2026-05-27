// Script to remove the stagger animation override
const fs = require('fs');
const content = fs.readFileSync('public/app.html', 'utf8');

// The stagger override block to remove
const staggerBlock = `    // Intercept renderTasks to add stagger-fade
    var _origRenderTasks = renderTasks;
    renderTasks = function() {
        var container = document.getElementById('taskList');
        var skeleton = document.getElementById('taskSkeletonList');
        if (skeleton) skeleton.style.display = 'none';

        // Render the tasks
        _origRenderTasks.apply(this, arguments);

        // Apply stagger-fade to new items
        if (container) {
            var prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (!prefersReduced) {
                // Set initial state for stagger items
                var cards = container.querySelectorAll('.task-card');
                cards.forEach(function(card) {
                    card.style.opacity = '0';
                    card.style.transform = 'translateY(8px)';
                    card.style.transition = 'opacity 200ms ease, transform 200ms ease';
                });
                staggerReveal(container, 500);
            }
        }
    };`;

if (content.includes(staggerBlock)) {
    const newContent = content.replace(staggerBlock, '');
    fs.writeFileSync('public/app.html', newContent);
    console.log('Stagger animation override removed');
} else {
    console.error('Could not find stagger block to remove');
    // Try to find it with different whitespace
    const idx = content.indexOf('// Intercept renderTasks to add stagger-fade');
    if (idx !== -1) {
        console.log('Found // Intercept comment at index', idx);
    } else {
        console.log('// Intercept comment not found');
    }
}