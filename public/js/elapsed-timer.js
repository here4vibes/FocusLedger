/**
 * ElapsedTimer — Visual Timer Overlay for ADHD Focus
 * Counts up from 00:00 when a task is opened for focus.
 * Persists per-task in localStorage (survives refresh).
 * Clears on task completion.
 */
(function() {
    'use strict';

    var STORAGE_PREFIX = 'fl_focus_timer_';

    // Maps taskId -> interval ID (for cleanup)
    var activeIntervals = {};

    function getStorageKey(taskId) {
        return STORAGE_PREFIX + String(taskId);
    }

    function saveState(taskId, state) {
        try {
            localStorage.setItem(getStorageKey(taskId), JSON.stringify(state));
        } catch (e) {
            // localStorage unavailable — in-memory only
        }
    }

    function loadState(taskId) {
        try {
            var raw = localStorage.getItem(getStorageKey(taskId));
            if (raw) return JSON.parse(raw);
        } catch (e) {}
        return null;
    }

    function clearState(taskId) {
        try {
            localStorage.removeItem(getStorageKey(taskId));
        } catch (e) {}
    }

    function getElapsed(state) {
        if (!state) return 0;
        if (state.isPaused) return state.accumulatedMs;
        return state.accumulatedMs + (Date.now() - state.startedAt);
    }

    function formatElapsed(ms) {
        var totalSeconds = Math.floor(ms / 1000);
        var hours = Math.floor(totalSeconds / 3600);
        var minutes = Math.floor((totalSeconds % 3600) / 60);
        var seconds = totalSeconds % 60;
        var hh = String(hours).padStart(2, '0');
        var mm = String(minutes).padStart(2, '0');
        var ss = String(seconds).padStart(2, '0');
        return hours > 0 ? hh + ':' + mm + ':' + ss : mm + ':' + ss;
    }

    /**
     * Tick — called every second. Updates the displayed time.
     */
    function tick(taskId, el) {
        var state = loadState(taskId);
        if (!state) return;
        var elapsed = getElapsed(state);
        el.querySelector('.timer-value').textContent = formatElapsed(elapsed);
        saveState(taskId, state);
    }

    /**
     * Start the timer for a task.
     * Shows the timer element and begins counting.
     */
    function start(taskId) {
        stop(taskId); // clear any existing interval for this task

        var state = loadState(taskId);

        // If already running (e.g., from page refresh), resume from where it was
        if (!state || state.isPaused) {
            state = {
                startedAt: Date.now(),
                accumulatedMs: state ? state.accumulatedMs : 0,
                isPaused: false
            };
            saveState(taskId, state);
        }

        // Build and inject the timer element
        var elapsed = getElapsed(state);
        var html = '<div class="elapsed-timer" id="elapsed-timer-' + taskId + '" data-task-id="' + taskId + '">';
        html += '<span class="timer-label">elapsed</span>';
        html += '<span class="timer-value">' + formatElapsed(elapsed) + '</span>';
        html += '<button class="timer-btn timer-pause-btn" data-timer-action="pause" title="Pause">&#10074;&#10074;</button>';
        html += '<button class="timer-btn timer-reset-btn" data-timer-action="reset" title="Reset timer">&#8635;</button>';
        html += '</div>';

        // Insert before the timer-slot span (which is the placeholder in the render output)
        var slot = document.getElementById('timer-slot-' + taskId);
        if (slot) {
            slot.insertAdjacentHTML('beforebegin', html);
        }

        // Begin the tick interval
        var el = document.getElementById('elapsed-timer-' + taskId);
        if (el) {
            activeIntervals[taskId] = setInterval(function() { tick(taskId, el); }, 1000);
            // Also save on each tick
            var saveInterval = setInterval(function() {
                var s = loadState(taskId);
                if (s) saveState(taskId, s);
            }, 5000);
            // Store save interval too (for cleanup tracking)
            activeIntervals[taskId + '_save'] = saveInterval;
        }
    }

    /**
     * Stop (pause) the timer for a task.
     * Keeps the timer element visible but frozen.
     */
    function pause(taskId) {
        var state = loadState(taskId);
        if (!state || state.isPaused) return;

        state.isPaused = true;
        state.accumulatedMs = getElapsed(state);
        saveState(taskId, state);

        var el = document.getElementById('elapsed-timer-' + taskId);
        if (el) {
            el.querySelector('.timer-value').textContent = formatElapsed(state.accumulatedMs) + ' ⏸';
        }

        stopInterval(taskId);
    }

    /**
     * Resume a paused timer.
     */
    function resume(taskId) {
        var state = loadState(taskId);
        if (!state || !state.isPaused) return;

        state.isPaused = false;
        state.startedAt = Date.now();
        saveState(taskId, state);

        var el = document.getElementById('elapsed-timer-' + taskId);
        if (el) {
            el.querySelector('.timer-value').textContent = formatElapsed(getElapsed(state));
            el.querySelector('.timer-pause-btn').innerHTML = '&#10074;&#10074;';
            el.querySelector('.timer-pause-btn').title = 'Pause';
        }

        // Restart the interval
        activeIntervals[taskId] = setInterval(function() { tick(taskId, el); }, 1000);
    }

    /**
     * Stop the timer for a task — hides element, clears interval.
     */
    function stop(taskId) {
        stopInterval(taskId);
        var el = document.getElementById('elapsed-timer-' + taskId);
        if (el) el.remove();
    }

    function stopInterval(taskId) {
        if (activeIntervals[taskId]) {
            clearInterval(activeIntervals[taskId]);
            delete activeIntervals[taskId];
        }
        if (activeIntervals[taskId + '_save']) {
            clearInterval(activeIntervals[taskId + '_save']);
            delete activeIntervals[taskId + '_save'];
        }
    }

    /**
     * Reset the timer for a task to 00:00.
     * Does NOT stop the timer — keeps it running from zero.
     */
    function reset(taskId) {
        var state = { startedAt: Date.now(), accumulatedMs: 0, isPaused: false };
        saveState(taskId, state);

        var el = document.getElementById('elapsed-timer-' + taskId);
        if (el) {
            el.querySelector('.timer-value').textContent = formatElapsed(0);
        }
    }

    /**
     * Clear the timer completely — stop and remove state.
     * Called when task is completed.
     */
    function clear(taskId) {
        stop(taskId);
        clearState(taskId);
    }

    /**
     * Check if a task has a saved (potentially running) timer.
     */
    function hasSaved(taskId) {
        return loadState(taskId) !== null;
    }

    // ── Event delegation for timer controls ────────────────────────────────────
    document.addEventListener('click', function(e) {
        var timerEl = e.target.closest('.elapsed-timer');
        if (!timerEl) return;

        var taskId = timerEl.getAttribute('data-task-id');
        var action = e.target.getAttribute('data-timer-action');
        if (!action) return;

        if (action === 'pause') {
            var state = loadState(taskId);
            if (state && state.isPaused) {
                resume(taskId);
            } else {
                pause(taskId);
            }
            return;
        }
        if (action === 'reset') {
            if (confirm('Reset timer to 00:00?')) {
                reset(taskId);
            }
            return;
        }
    });

    // ── Public API ─────────────────────────────────────────────────────────────
    window.ElapsedTimer = {
        start: start,
        stop: stop,
        pause: pause,
        resume: resume,
        reset: reset,
        clear: clear,
        hasSaved: hasSaved
    };

})();