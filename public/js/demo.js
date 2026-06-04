/*
 * FocusLedger — Interactive Demo
 * Morning greeting → mood check-in → task list.
 * Session-only localStorage, no backend calls.
 */
(function () {
    'use strict';

    // ── Constants ─────────────────────────────────────────────────────────────
    var STORAGE_KEY = 'fldemo';
    var MAX_TASKS = 20;

    // ── State (loaded from localStorage if available) ─────────────────────────
    var state = loadState();

    // ── localStorage helpers ───────────────────────────────────────────────────
    function loadState() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                var parsed = JSON.parse(raw);
                return {
                    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
                    interacted: !!parsed.interacted,
                    // Persist mood so returning visitors skip the morning screen
                    mood: parsed.mood || null
                };
            }
        } catch (e) { /* ignore */ }
        return { tasks: [], interacted: false, mood: null };
    }

    function saveState() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) { /* quota exceeded — ignore */ }
    }

    // ── Screen transitions ────────────────────────────────────────────────────
    function showDashboard() {
        var morning = document.getElementById('morningScreen');
        var dash = document.getElementById('dashboardScreen');
        if (!morning || !dash) return;

        // Hide morning, reveal tasks
        morning.classList.remove('visible');
        morning.classList.add('hidden');
        dash.classList.add('visible');
        dash.classList.remove('hidden');

        // Focus the task input once transition settles
        setTimeout(function () {
            var input = document.getElementById('demoTaskInput');
            if (input) input.focus();
        }, 460);
    }

    // ── Morning flow ──────────────────────────────────────────────────────────
    function initMorning() {
        // Stamp today's date into the greeting
        var dateEl = document.getElementById('morningDate');
        if (dateEl) {
            var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
            var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
            var now = new Date();
            dateEl.textContent = days[now.getDay()] + ', ' + months[now.getMonth()] + ' ' + now.getDate();
        }

        // Mood buttons — tap any one to transition to tasks
        var moodBtns = document.querySelectorAll('.mood-btn');
        moodBtns.forEach(function (btn) {
            btn.addEventListener('click', function () {
                // Visual feedback: mark selected
                moodBtns.forEach(function (b) { b.classList.remove('selected'); });
                btn.classList.add('selected');

                // Persist so returning visitors skip straight to tasks
                state.mood = btn.getAttribute('data-mood');
                saveState();

                // Short pause so the selection registers visually, then transition
                setTimeout(showDashboard, 320);
            });
        });
    }

    // ── Nudge CTA ──────────────────────────────────────────────────────────────
    function showNudge() {
        if (state.interacted) return;
        state.interacted = true;
        saveState();
        var nudge = document.getElementById('demoCta');
        if (nudge) nudge.classList.add('shown');
        updateCtaText();
    }

    function updateCtaText() {
        var nudgeText = document.querySelector('#demoCta .demo-cta-text');
        var nudgeStrong = document.querySelector('#demoCta .demo-cta-text strong');
        if (!nudgeText || !nudgeStrong) return;
        if (state.tasks.length > 0) {
            var label = state.tasks.length + ' task' + (state.tasks.length !== 1 ? 's' : '');
            nudgeStrong.textContent = label + ' added. ';
            nudgeText.innerHTML = '<strong>' + label + ' added. </strong>Sign up free and keep them. No credit card.';
        }
    }

    // ── Task Management ─────────────────────────────────────────────────────────
    function addTask(label) {
        if (!label || label.trim().length === 0) return;
        if (state.tasks.length >= MAX_TASKS) return;
        var task = { id: Date.now(), label: label.trim(), done: false };
        state.tasks.push(task);
        saveState();
        renderTasks();
        updateTaskCount();
        showNudge();
    }

    function toggleTask(id) {
        var task = state.tasks.find(function (t) { return t.id === id; });
        if (!task) return;
        task.done = !task.done;
        saveState();
        renderTasks();
        updateTaskCount();
        showNudge();
    }

    function removeTask(id) {
        state.tasks = state.tasks.filter(function (t) { return t.id !== id; });
        saveState();
        renderTasks();
        updateTaskCount();
    }

    function updateTaskCount() {
        var remaining = state.tasks.filter(function (t) { return !t.done; }).length;
        var el = document.getElementById('demoTaskCount');
        if (!el) return;
        if (state.tasks.length === 0) {
            el.textContent = 'No tasks yet';
        } else {
            el.textContent = remaining + ' remaining';
        }
    }

    function renderTasks() {
        var list = document.getElementById('demoTaskList');
        if (!list) return;

        if (state.tasks.length === 0) {
            list.innerHTML = '<div class="demo-empty-state">Type a task above and press Enter to add it.</div>';
            return;
        }

        list.innerHTML = state.tasks.map(function (task) {
            var checked = task.done ? ' checked' : '';
            var label = escHtml(task.label);
            return '<div class="demo-task-item' + checked + '" data-id="' + task.id + '">' +
                '<div class="demo-checkbox"><span class="demo-checkbox-check">&#10003;</span></div>' +
                '<div class="demo-task-body">' +
                '<div class="demo-task-label">' + label + '</div>' +
                '<div class="demo-task-due">Added just now</div>' +
                '</div>' +
                '<button class="demo-task-remove" aria-label="Remove task" data-remove="' + task.id + '">&times;</button>' +
                '</div>';
        }).join('');

        list.querySelectorAll('.demo-task-item').forEach(function (item) {
            item.addEventListener('click', function (e) {
                if (e.target.closest('[data-remove]') || e.target.closest('.demo-task-remove')) return;
                var id = parseInt(item.getAttribute('data-id'), 10);
                toggleTask(id);
            });
        });

        list.querySelectorAll('[data-remove]').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var id = parseInt(btn.getAttribute('data-remove'), 10);
                removeTask(id);
            });
        });
    }

    function initTaskInput() {
        var input = document.getElementById('demoTaskInput');
        if (!input) return;

        function submitTask() {
            if (input.disabled) return;
            input.disabled = true;
            try {
                var val = input.value.trim();
                if (val) {
                    addTask(val);
                    input.value = '';
                }
            } finally {
                input.disabled = false;
            }
        }

        // WHY form submit: Safari iOS virtual keyboard "Return"/"Go" always triggers
        // form submit, but may not reliably fire keydown with key==='Enter'.
        var form = input.closest('form');
        if (form) {
            form.addEventListener('submit', function (e) {
                e.preventDefault();
                submitTask();
            });
        }

        input.addEventListener('keydown', function (e) {
            // Accept Enter, Go, and keyCode 13 fallback for Safari compatibility
            if (e.key === 'Enter' || e.key === 'Go' || e.keyCode === 13) {
                e.preventDefault();
                submitTask();
            }
        });
    }

    // ── Utility ─────────────────────────────────────────────────────────────────
    function escHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/'/g, '&#39;')
            .replace(/\u2018/g, '&#8216;')
            .replace(/\u2019/g, '&#8217;')
            .replace(/\u201c/g, '&#8220;')
            .replace(/\u201d/g, '&#8221;');
    }

    // ── Init ─────────────────────────────────────────────────────────────────────
    function init() {
        var demo = document.getElementById('demoSection');
        if (!demo) return;  // not on landing page — bail

        initTaskInput();
        renderTasks();
        updateTaskCount();

        // Returning visitor who already picked a mood → skip straight to tasks
        if (state.mood) {
            var morning = document.getElementById('morningScreen');
            if (morning) {
                morning.classList.remove('visible');
                morning.classList.add('hidden');
            }
            var dash = document.getElementById('dashboardScreen');
            if (dash) dash.classList.add('visible');
        } else {
            // First visit — show morning screen, wire mood buttons
            initMorning();
        }

        // Restore nudge if already interacted
        if (state.interacted) {
            var nudge = document.getElementById('demoCta');
            if (nudge) {
                nudge.classList.add('shown');
                updateCtaText();
            }
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
