/**
 * tasks-page.js — Modular task UI component for /app/tasks
 * Owns: task list state, rendering, form submission, inline editing, step management.
 * Does NOT own: shared nav, auth token storage, subscription UI.
 *
 * Replaces inline JS in app.html. Uses Prisma-backed /api/tasks routes.
 */

(function() {
  'use strict';

  // ── API helper ─────────────────────────────────────────────────────────────────
  function flApi(method, path, body) {
    var authToken = localStorage.getItem('fl_token') || '';
    var opts = {
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + authToken
      }
    };
    if (body) opts.body = JSON.stringify(body);
    return fetch('/api' + path, opts)
      .then(function(r) {
        if (r.status === 401) {
          localStorage.removeItem('fl_token');
          localStorage.removeItem('fl_user');
          window.location.href = '/login';
          throw new Error('Session expired');
        }
        return r.json().catch(function() { return { success: false, message: 'Parse error' }; });
      })
      .then(function(data) {
        if (!data.success) throw new Error(data.message || 'API error');
        return data;
      });
  }

  // ── Escape HTML ────────────────────────────────────────────────────────────────
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ── Format duration ────────────────────────────────────────────────────────────
  function formatDuration(minutes) {
    if (!minutes) return '';
    if (minutes < 60) return minutes + ' min';
    if (minutes % 60 === 0) return (minutes / 60) + ' hr';
    return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
  }

  // ── State ───────────────────────────────────────────────────────────────────────
  var state = {
    tasks: [],
    values: [],
    summary: { total: 0, today_total: 0, completed: 0, completed_this_week: 0 },
    filter: 'all',       // 'all' | 'active' | 'completed'
    sort: 'default',      // 'default' | 'due_date'
    breakdownMode: false,
    completedExpanded: false,
    expandedTasks: {},    // taskId → true for expanded (detail view)
    reentryBriefs: {},   // taskId → brief object (cached)
    notesExpanded: {},
    editingDueDateTaskId: null,
    editingDurationTaskId: null,
    editingTitleTaskId: null,
    formOpen: false,
    steps: []
  };

  // ── Init ────────────────────────────────────────────────────────────────────────
  function init() {
    bindNavAndSubscription();
    bindFilterTabs();
    bindSortButton();
    bindNewTaskButton();
    bindAddTaskForm();
    bindBreakdownToggle();
    bindDueDateToggle();
    bindDurationToggle();
    bindDelegatedActions();
    fetchValues().then(fetchAllTasks);
    fetchSubscription();
  }

  // ── Data fetching ──────────────────────────────────────────────────────────────
  function fetchAllTasks() {
    var url = '/tasks' + (state.sort === 'due_date' ? '?sort=due_date' : '');
    flApi('GET', url).then(function(data) {
      state.tasks = data.tasks || [];
      render();
    }).catch(function() {
      state.tasks = [];
      render();
    });
    flApi('GET', '/tasks/summary').then(function(data) {
      var s = data.summary || {};
      state.summary = {
        total: parseInt(s.total) || 0,
        today_total: parseInt(s.today_total) || 0,
        completed: parseInt(s.completed_today) || 0,
        completed_this_week: parseInt(s.completed_this_week) || 0
      };
      renderSummary();
    }).catch(function() {});
  }

  function fetchValues() {
    return flApi('GET', '/values').then(function(data) {
      state.values = data.values || [];
    }).catch(function() { state.values = []; });
  }

  function fetchSubscription() {
    var authToken = localStorage.getItem('fl_token') || '';
    fetch('/api/subscription/status', {
      headers: { 'Authorization': 'Bearer ' + authToken }
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.success) {
        renderTaskCountPill(data.limits);
      }
    }).catch(function() {});
  }

  // ── Render: summary ─────────────────────────────────────────────────────────────
  function renderSummary() {
    var el = document.getElementById('fl-task-summary');
    if (!el) return;
    var done = state.summary.completed || 0;
    var today = state.summary.today_total || 0;
    var week = state.summary.completed_this_week || 0;
    var text;
    if (today === 0 && done === 0) {
      text = 'Nothing due today ✓';
    } else if (done >= today && today > 0) {
      text = 'All done for today! 🎉';
    } else {
      text = done + ' of ' + today + ' done today';
    }
    if (week > 0) text += ' · ' + week + ' this week';
    el.textContent = text;
  }

  function renderTaskCountPill(limits) {
    var el = document.getElementById('fl-free-task-count');
    if (!el || !limits) return;
    var remaining = limits.tasks_remaining;
    if (limits.is_pro) {
      el.style.display = 'none';
    } else {
      el.textContent = remaining + ' left';
      el.style.display = 'inline-block';
    }
  }

  // ── Render: full UI ────────────────────────────────────────────────────────────
  function render() {
    renderSummary();
    renderTaskList();
  }

  function renderTaskList() {
    var container = document.getElementById('fl-task-list');
    if (!container) return;

    var filtered = state.tasks;
    if (state.filter === 'active') filtered = state.tasks.filter(function(t) { return !t.is_completed; });
    else if (state.filter === 'completed') filtered = state.tasks.filter(function(t) { return t.is_completed; });

    if (filtered.length === 0) {
      var msg = state.filter === 'completed'
        ? 'Nothing completed yet.'
        : state.filter === 'active'
        ? 'Clear list. Enjoy it.'
        : 'Nothing here yet. Add something.';
      var icon = state.filter === 'completed' ? '⭐' : '🧠';
      container.innerHTML =
        '<div class="empty-state" style="padding:2rem 1rem;text-align:center;">' +
        '<div class="empty-icon">' + icon + '</div><p>' + msg + '</p></div>';
      return;
    }

    var activeTasks, completedTasks;
    if (state.filter === 'all') {
      activeTasks = filtered.filter(function(t) { return !t.is_completed; });
      completedTasks = filtered.filter(function(t) { return t.is_completed; });
    } else {
      activeTasks = filtered;
      completedTasks = [];
    }

    var html = '';

    if (state.filter === 'all' && activeTasks.length === 0 && completedTasks.length > 0) {
      html += '<div class="empty-state" style="padding:1.5rem 1rem;text-align:center;">' +
        '<div class="empty-icon">🎉</div><p>All caught up. Nice work.</p></div>';
    }

    activeTasks.forEach(function(task) { html += renderTaskCard(task, false); });

    if (state.filter === 'all' && completedTasks.length > 0) {
      var isOpen = state.completedExpanded;
      html += '<div class="completed-section-header" data-action="toggle-completed-section">';
      html += '<svg class="completed-section-chevron' + (isOpen ? ' open' : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"></polyline></svg>';
      html += '<span class="completed-section-label">Completed</span>';
      html += '<span class="completed-section-count">' + completedTasks.length + '</span>';
      html += '</div>';
      html += '<div class="completed-section-tasks' + (isOpen ? ' visible' : '') + '">';
      completedTasks.forEach(function(task) { html += renderTaskCard(task, true); });
      html += '</div>';
    }

    container.innerHTML = html;
    updateSkeletonVisibility(false);
  }

  function renderTaskCard(task, isCompleted) {
    var taskVal = task.value_id ? state.values.find(function(v) { return v.id === task.value_id; }) : null;
    var duration = formatDuration(task.duration_minutes);
    var isExpanded = !!state.expandedTasks[String(task.id)];
    var notesOpen = !!state.notesExpanded[String(task.id)];
    var editingDue = state.editingDueDateTaskId === String(task.id);
    var editingDur = state.editingDurationTaskId === String(task.id);
    var editingTitle = state.editingTitleTaskId === String(task.id);

    var timeHint = buildTimeHint(task);
    var hasRecurrence = task.recurrence_type && task.recurrence_type !== 'none';

    var html = '';
    html += '<div class="task-card' + (isCompleted ? ' task-card-completed' : '') + (isExpanded ? ' is-expanded' : '') + '" data-task-id="' + task.id + '" data-detail-open="' + (isExpanded ? '1' : '0') + '">';

    // ── Main row: expand/collapse tap target ────────────────────────────────
    html += '<div class="task-card-main" data-action="expand-task" data-id="' + task.id + '">';
    // Checkbox
    html += '<div class="task-checkbox' + (task.is_completed ? ' checked' : '') + '" data-action="toggle-task" data-id="' + task.id + '">';
    if (task.is_completed) {
      html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    }
    html += '</div>';

    // Title (or inline edit) with recurring icon
    var titleClass = task.is_completed ? 'task-card-title struck' : 'task-card-title';
    var recurIcon = hasRecurrence ? '<span class="task-recurring-icon" title="Recurring">&#x1f504;</span>' : '';
    if (editingTitle) {
      html += '<input type="text" class="task-title-edit" id="title-edit-' + task.id + '" value="' + escapeHtml(task.title) + '" data-action="title-edit-input" data-id="' + task.id + '">';
    } else {
      html += '<span class="' + titleClass + '">' + escapeHtml(task.title) + '</span>' + recurIcon;
    }

    // Meta row: value tag + duration + time hint
    // Built here, emitted OUTSIDE .task-card-main below so it sits below the
    // title row at full card width and never overflows on long value names.
    var meta = '';
    if (taskVal) {
      meta += '<span class="task-card-meta-tag" style="color:' + escapeHtml(taskVal.color || '#c9a84c') + ';">' +
        (taskVal.icon || '') + ' ' + escapeHtml(taskVal.value_name) + '</span>';
    }
    if (duration) {
      if (meta) meta += '<span class="meta-sep">·</span>';
      if (editingDur) {
        meta += '<span class="task-duration-edit-inline">';
        meta += '<input type="number" id="dur-input-' + task.id + '" value="' + task.duration_minutes + '" min="1" max="480" style="width:50px;padding:2px 4px;border:1.5px solid var(--border);border-radius:4px;font-size:0.78rem;text-align:center;" data-action="inline-duration-input" data-id="' + task.id + '">';
        meta += '<button class="btn-sm" data-action="save-duration" data-id="' + task.id + '" title="Save">✓</button>';
        meta += '<button class="btn-sm" data-action="cancel-duration" data-id="' + task.id + '" title="Cancel">✕</button>';
        meta += '</span>';
      } else {
        meta += '<span class="task-card-meta-tag clickable" data-action="edit-duration" data-id="' + task.id + '" title="Click to set duration">' + duration + '</span>';
      }
    }
    if (timeHint && timeHint.label) {
      if (meta) meta += '<span class="meta-sep">·</span>';
      meta += '<span class="task-card-meta-tag ' + timeHint.cls + '">' + escapeHtml(timeHint.label) + '</span>';
    }
    // (meta emitted below, outside .task-card-main)

    // Edit due date inline
    if (editingDue) {
      var existingDate = task.due_date ? String(task.due_date).split('T')[0] : '';
      var existingTime = task.due_time ? String(task.due_time).slice(0, 5) : '';
      html += '<div class="task-inline-edit-row" style="margin:0.5rem 0 0 0;">';
      html += '<input type="date" id="due-edit-date-' + task.id + '" value="' + existingDate + '" style="border:1.5px solid var(--border);border-radius:6px;padding:4px 6px;font-size:0.8rem;margin-right:4px;">';
      html += '<input type="time" id="due-edit-time-' + task.id + '" value="' + existingTime + '" style="border:1.5px solid var(--border);border-radius:6px;padding:4px 6px;font-size:0.8rem;margin-right:4px;">';
      html += '<button class="btn-sm" data-action="save-due-date" data-id="' + task.id + '">✓</button>';
      html += '<button class="btn-sm" data-action="cancel-due-date" data-id="' + task.id + '">✕</button>';
      html += '</div>';
    }

    // ── Expanded detail view ───────────────────────────────────────────────
    if (isExpanded) {
      html += '<div class="task-expanded-content">';

      // Re-entry brief (shown when task hasn't been worked on in 5+ days)
      var brief = state.reentryBriefs && state.reentryBriefs[String(task.id)];
      if (brief) {
        html += '<div class="task-reentry-brief">';
        html += '<div class="reentry-brief-header">&#8617; Welcome back to this task</div>';
        if (brief.lastWorkedOn) {
          var daysAgo = brief.daysSince === 1 ? '1 day ago' : brief.daysSince + ' days ago';
          html += '<div class="reentry-brief-row">Last focus session: <strong>' + daysAgo + '</strong></div>';
        } else {
          html += '<div class="reentry-brief-row">No focus sessions yet</div>';
        }
        if (brief.lastNote) {
          html += '<div class="reentry-brief-row">Last note: <em>' + escapeHtml(brief.lastNote) + '</em></div>';
        }
        if (brief.nextSubstep) {
          html += '<div class="reentry-brief-row">Next micro-step: <strong>' + escapeHtml(brief.nextSubstep) + '</strong></div>';
        }
        html += '</div>';
      }

      // Detail header with close button
      html += '<div class="task-detail-header">';
      html += '<span class="task-detail-section-label">Task Detail</span>';
      html += '<button class="task-detail-close-btn" data-action="expand-task" data-id="' + task.id + '" title="Close">&times;</button>';
      html += '</div>';

      // Inline title edit toggle
      html += '<div style="margin-bottom:0.5rem;">';
      if (editingTitle) {
        html += '<input type="text" class="task-title-edit" id="title-edit-' + task.id + '" value="' + escapeHtml(task.title) + '" data-action="title-edit-input" data-id="' + task.id + '">';
        html += '<div style="display:flex;gap:0.4rem;margin-top:0.3rem;">';
        html += '<button class="btn-sm" data-action="save-title" data-id="' + task.id + '">Save</button>';
        html += '<button class="btn-sm" data-action="cancel-title" data-id="' + task.id + '">Cancel</button>';
        html += '</div>';
      } else {
        html += '<button class="task-action-btn" data-action="edit-title" data-id="' + task.id + '" style="font-size:0.78rem;">&#9998; Edit title</button>';
      }
      html += '</div>';

      // Due date
      var dueDateVal = task.due_date ? String(task.due_date).split('T')[0] : '';
      var dueTimeVal = task.due_time ? String(task.due_time).slice(0, 5) : '';
      html += '<div class="task-detail-section">';
      html += '<div class="task-detail-section-label">Due date</div>';
      html += '<div style="display:flex;gap:0.4rem;align-items:center;">';
      html += '<input type="date" id="detail-due-date-' + task.id + '" value="' + dueDateVal + '" style="border:1.5px solid var(--border);border-radius:6px;padding:4px 6px;font-size:0.8rem;" data-action="detail-due-date" data-id="' + task.id + '">';
      html += '<input type="time" id="detail-due-time-' + task.id + '" value="' + dueTimeVal + '" style="border:1.5px solid var(--border);border-radius:6px;padding:4px 6px;font-size:0.8rem;" data-action="detail-due-time" data-id="' + task.id + '">';
      html += '</div></div>';

      // Value tag selector
      html += '<div class="task-detail-section">';
      html += '<div class="task-detail-section-label">Value</div>';
      html += '<div class="value-pills">';
      if (state.values.length === 0) {
        html += '<span style="font-size:0.75rem;color:var(--text-muted, #6b6b6b);">No values yet</span>';
      } else {
        state.values.forEach(function(v) {
          var sel = task.value_id === v.id ? ' selected' : '';
          html += '<span class="value-pill' + sel + '" style="background:' + (sel ? (v.color || '#c9a84c') + '22' : 'transparent') + ';border-color:' + (v.color || '#c9a84c') + ';color:' + (v.color || '#c9a84c') + ';" data-action="set-value" data-id="' + task.id + '" data-value-id="' + v.id + '">' + (v.icon || '') + ' ' + escapeHtml(v.value_name) + '</span>';
        });
        // None option
      }
      html += '<span class="value-pill' + (task.value_id ? '' : ' selected') + '" style="border-color:var(--border,#e8e5e0);color:var(--text-muted,#6b6b6b);" data-action="set-value" data-id="' + task.id + '" data-value-id="">None</span>';
      html += '</div></div>';

      // Recurring setting
      var recType = task.recurrence_type || 'none';
      var recDay = task.recurrence_day != null ? String(task.recurrence_day) : '';
      html += '<div class="task-detail-section">';
      html += '<div class="task-detail-section-label">Repeat</div>';
      html += '<div class="recurrence-picker">';
      var recOptions = [
        { val: 'none', label: 'Off' },
        { val: 'daily', label: 'Daily' },
        { val: 'weekdays', label: 'Weekdays' },
        { val: 'weekly', label: 'Weekly' },
        { val: 'monthly', label: 'Monthly' }
      ];
      recOptions.forEach(function(opt) {
        html += '<button class="recurrence-option' + (recType === opt.val ? ' active' : '') + '" data-action="set-recurrence" data-id="' + task.id + '" data-rec-val="' + opt.val + '">' + opt.label + '</button>';
      });
      html += '</div>';

      // Day selector (for weekly/monthly)
      var showDayRow = recType === 'weekly' || recType === 'monthly';
      var dayOptions = showDayRow && recType === 'weekly'
        ? [{ v: '0', l: 'Sun' }, { v: '1', l: 'Mon' }, { v: '2', l: 'Tue' }, { v: '3', l: 'Wed' }, { v: '4', l: 'Thu' }, { v: '5', l: 'Fri' }, { v: '6', l: 'Sat' }]
        : showDayRow
        ? Array.from({ length: 31 }, function(_, i) { return { v: String(i + 1), l: String(i + 1) }; })
        : [];

      html += '<div class="recurrence-day-row' + (showDayRow ? ' visible' : '') + '" id="rec-day-row-' + task.id + '">';
      if (dayOptions.length > 0) {
        var dayLabel = recType === 'weekly' ? 'Day: ' : 'Date: ';
        html += '<span style="font-size:0.78rem;color:var(--text-muted,#6b6b6b);">' + dayLabel + '</span>';
        dayOptions.forEach(function(opt) {
          html += '<button class="recurrence-option' + (recDay === opt.v ? ' active' : '') + '" style="padding:0.2rem 0.5rem;font-size:0.75rem;" data-action="set-recurrence-day" data-id="' + task.id + '" data-rec-val="' + opt.v + '">' + opt.l + '</button>';
        });
      }
      html += '</div></div>';

      // Notes
      html += '<div class="task-detail-section">';
      html += '<div class="task-detail-section-label">Notes</div>';
      if (notesOpen) {
        html += '<textarea id="task-notes-' + task.id + '" class="task-notes-textarea" data-id="' + task.id + '" rows="3" style="width:100%;border:1.5px solid var(--border);border-radius:6px;padding:6px;font-size:0.82rem;font-family:inherit;resize:vertical;">' + escapeHtml(task.notes || '') + '</textarea>';
        html += '<div style="display:flex;gap:0.4rem;margin-top:0.3rem;">';
        html += '<button class="btn-sm" data-action="save-task-notes" data-id="' + task.id + '">Save</button>';
        html += '<button class="btn-sm" data-action="toggle-task-notes" data-id="' + task.id + '">Close</button>';
        html += '</div>';
      } else {
        var notePreview = task.notes ? escapeHtml(task.notes).substring(0, 60) + (task.notes.length > 60 ? '…' : '') : '';
        html += '<button class="task-action-btn" data-action="toggle-task-notes" data-id="' + task.id + '" style="font-size:0.78rem;">' + (notePreview ? '&#128221; ' + notePreview : '&#128221; Add notes') + '</button>';
      }
      html += '</div>';

      // Steps
      if (task.steps && task.steps.length > 0) {
        html += '<div class="task-detail-section">';
        html += '<div class="task-detail-section-label">Steps</div>';
        html += '<div class="task-steps-list">';
        task.steps.forEach(function(step) {
          html += '<div class="task-step-row">';
          html += '<div class="task-step-checkbox' + (step.is_completed ? ' checked' : '') + '" data-action="toggle-step" data-task-id="' + task.id + '" data-step-id="' + step.id + '">';
          if (step.is_completed) {
            html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>';
          }
          html += '</div>';
          var stepClass = step.is_completed ? 'task-step-title struck' : 'task-step-title';
          html += '<span class="' + stepClass + '">' + escapeHtml(step.title) + '</span>';
          html += '<button class="task-step-delete" data-action="delete-step" data-task-id="' + task.id + '" data-step-id="' + step.id + '" title="Delete step">&times;</button>';
          html += '</div>';
        });
        html += '</div>';
        html += '</div>';
      }

      // Add step
      html += '<div class="task-detail-section">';
      html += '<div class="task-add-step-row">';
      html += '<input type="text" id="new-step-' + task.id + '" placeholder="Add a step…" class="task-step-input" data-action="add-step-input" data-task-id="' + task.id + '">';
      html += '<button class="btn-sm" data-action="add-step" data-task-id="' + task.id + '">+</button>';
      html += '</div>';
      html += '</div>';

      // Delete
      html += '<div style="margin-top:0.5rem;padding-top:0.5rem;border-top:1px solid var(--border,#e8e5e0);">';
      html += '<button class="task-action-btn task-action-delete" data-action="delete-task" data-id="' + task.id + '" style="font-size:0.78rem;">Delete task</button>';
      html += '</div>';

      html += '</div>'; // .task-expanded-content
    }

    html += '</div>'; // .task-card-main

    // Meta row sits outside the flex row so it gets full card width
    if (meta) html += '<div class="task-card-meta">' + meta + '</div>';

    // Action row (hidden in expanded view, shown collapsed)
    if (!isExpanded) {
      html += '<div class="task-card-actions">';
      if (!editingDue) {
        var dueLabel = task.due_date
          ? (String(task.due_date).split('T')[0] + (task.due_time ? ' ' + String(task.due_time).slice(0, 5) : ''))
          : 'Set due date';
        html += '<button class="task-action-btn" data-action="edit-due-date" data-id="' + task.id + '" title="Set due date">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>' +
          ' ' + escapeHtml(dueLabel) + '</button>';
      }
      html += '<button class="task-action-btn task-action-delete" data-action="delete-task" data-id="' + task.id + '" title="Delete task">Delete</button>';
      html += '</div>';
    }

    html += '</div>'; // .task-card
    return html;
  }

  function buildTimeHint(task) {
    if (!task.due_date) return { label: '', cls: '' };
    var now = new Date();
    var today = now.toISOString().split('T')[0];
    var tomorrow = new Date(now.getTime() + 86400000).toISOString().split('T')[0];
    var dateStr = String(task.due_date).split('T')[0];
    // due_time is already normalized to "HH:MM" by backend normTask()
    var timeStr = task.due_time ? ' · ' + String(task.due_time).slice(0, 5) : '';
    var dueMs = new Date(dateStr + 'T00:00:00').getTime();
    var todayMs = new Date(today + 'T00:00:00').getTime();
    var hoursUntilDue = (dueMs - now.getTime()) / (1000 * 60 * 60);

    var label, cls;
    if (dueMs < todayMs) {
      var daysLate = Math.max(1, Math.round((todayMs - dueMs) / 86400000));
      label = (daysLate === 1 ? 'Overdue by 1 day' : 'Overdue by ' + daysLate + ' days') + timeStr;
      cls = 'due-overdue';
    } else if (dateStr === today) {
      label = 'Due today' + timeStr;
      cls = hoursUntilDue > 0 && hoursUntilDue <= 3 ? 'due-urgent' : 'due-soon';
    } else if (dateStr === tomorrow) {
      label = 'Due tomorrow' + timeStr;
      cls = 'due-soon';
    } else if (hoursUntilDue > 0 && hoursUntilDue <= 72) {
      var days = Math.ceil(hoursUntilDue / 24);
      label = 'In ' + days + ' day' + (days === 1 ? '' : 's') + timeStr;
      cls = 'due-soon';
    } else {
      var days2 = Math.max(1, Math.ceil(hoursUntilDue / 24));
      label = 'In ' + days2 + ' days' + timeStr;
      cls = 'due-ok';
    }
    return { label: label, cls: cls };
  }

  function updateSkeletonVisibility(visible) {
    var skeleton = document.getElementById('fl-task-skeleton');
    var list = document.getElementById('fl-task-list');
    if (skeleton) skeleton.style.display = visible ? 'flex' : 'none';
    if (list) list.style.display = visible ? 'none' : 'flex';
  }

  // ── Bind: filter tabs ──────────────────────────────────────────────────────────
  function bindFilterTabs() {
    var tabs = document.querySelectorAll('.fl-filter-tab');
    tabs.forEach(function(tab) {
      tab.addEventListener('click', function() {
        tabs.forEach(function(t) { t.classList.remove('active'); });
        tab.classList.add('active');
        state.filter = tab.getAttribute('data-filter') || 'all';
        renderTaskList();
      });
    });
  }

  // ── Bind: sort button ─────────────────────────────────────────────────────────
  function bindSortButton() {
    var btn = document.getElementById('fl-sort-due-date-btn');
    if (btn) {
      btn.addEventListener('click', function() {
        state.sort = state.sort === 'due_date' ? 'default' : 'due_date';
        btn.classList.toggle('active', state.sort === 'due_date');
        fetchAllTasks();
      });
    }
  }

  // ── Bind: new task button ───────────────────────────────────────────────────────
  function bindNewTaskButton() {
    var btn = document.getElementById('fl-new-task-btn');
    if (btn) {
      btn.addEventListener('click', function() {
        state.formOpen = !state.formOpen;
        renderTaskForm();
      });
    }
  }

  function renderTaskForm() {
    var card = document.getElementById('fl-task-form-card');
    var newBtn = document.getElementById('fl-new-task-btn');
    if (!card || !newBtn) return;
    card.style.display = state.formOpen ? 'block' : 'none';
    newBtn.innerHTML = state.formOpen
      ? '✕ Close'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> New task';
    if (state.formOpen) {
      var input = document.getElementById('fl-task-input');
      if (input) input.focus();
    }
  }

  // ── Bind: add task form ────────────────────────────────────────────────────────
  function bindAddTaskForm() {
    var input = document.getElementById('fl-task-input');
    var btn = document.getElementById('fl-add-task-btn');
    if (input) {
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); submitTask(); }
        updateCharCounter();
      });
      input.addEventListener('input', updateCharCounter);
    }
    if (btn) btn.addEventListener('click', submitTask);
  }

  function updateCharCounter() {
    var input = document.getElementById('fl-task-input');
    var counter = document.getElementById('fl-task-char-counter');
    if (!input || !counter) return;
    var len = input.value.length;
    counter.textContent = len + '/150';
    counter.style.display = len > 0 ? 'block' : 'none';
  }

  function submitTask() {
    var input = document.getElementById('fl-task-input');
    if (!input) return;
    var title = input.value.trim();
    if (!title) { input.focus(); return; }
    if (title.length > 150) { alert('Task title must be 150 characters or fewer.'); return; }

    var dueDateEl = document.getElementById('fl-task-due-date');
    var dueTimeEl = document.getElementById('fl-task-due-time');
    var durationEl = document.getElementById('fl-task-duration');

    var payload = { title: title };
    if (dueDateEl && dueDateEl.value) payload.due_date = dueDateEl.value;
    if (dueTimeEl && dueTimeEl.value) payload.due_time = dueTimeEl.value;
    if (durationEl && durationEl.value) payload.duration_minutes = parseInt(durationEl.value);

    // Collect steps if breakdown is open
    if (state.breakdownMode && state.steps.length > 0) {
      payload.steps = state.steps.filter(function(s) { return s.trim(); });
    }

    var submitBtn = document.getElementById('fl-add-task-btn');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Adding…'; }

    flApi('POST', '/tasks', payload).then(function(data) {
      if (data.task) {
        state.tasks.unshift(data.task);
      }
      resetForm();
      renderTaskList();
      fetchAllTasks();
    }).catch(function(err) {
      alert(err.message || 'Could not create task.');
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Add'; }
    });
  }

  function resetForm() {
    var input = document.getElementById('fl-task-input');
    var dueDate = document.getElementById('fl-task-due-date');
    var dueTime = document.getElementById('fl-task-due-time');
    var duration = document.getElementById('fl-task-duration');
    var submitBtn = document.getElementById('fl-add-task-btn');
    var counter = document.getElementById('fl-task-char-counter');
    if (input) input.value = '';
    if (dueDate) dueDate.value = '';
    if (dueTime) dueTime.value = '';
    if (duration) duration.value = '';
    if (counter) counter.style.display = 'none';
    state.steps = [];
    state.breakdownMode = false;
    renderBreakdownToggle();
    renderStepsInput();
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Add'; }
    var formCard = document.getElementById('fl-task-form-card');
    var newBtn = document.getElementById('fl-new-task-btn');
    if (formCard) formCard.style.display = 'none';
    if (newBtn) newBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> New task';
    state.formOpen = false;
  }

  // ── Bind: breakdown toggle ──────────────────────────────────────────────────────
  function bindBreakdownToggle() {
    var toggle = document.getElementById('fl-breakdown-toggle');
    if (toggle) {
      toggle.addEventListener('click', function() {
        state.breakdownMode = !state.breakdownMode;
        renderBreakdownToggle();
        renderStepsInput();
      });
    }
    var addStepBtn = document.getElementById('fl-add-step-btn');
    if (addStepBtn) {
      addStepBtn.addEventListener('click', function() {
        state.steps.push('');
        renderStepsInput();
        var inputs = document.querySelectorAll('.fl-step-field');
        if (inputs.length > 0) inputs[inputs.length - 1].focus();
      });
    }
  }

  function renderBreakdownToggle() {
    var track = document.getElementById('fl-toggle-track');
    if (track) track.classList.toggle('active', state.breakdownMode);
  }

  function renderStepsInput() {
    var area = document.getElementById('fl-steps-input-area');
    if (!area) return;
    area.style.display = state.breakdownMode ? 'block' : 'none';
    if (!state.breakdownMode) return;

    var container = document.getElementById('fl-step-inputs');
    if (!container) return;

    var html = '';
    state.steps.forEach(function(step, i) {
      html += '<div class="fl-step-input-row">';
      html += '<input type="text" value="' + escapeHtml(step) + '" placeholder="Step ' + (i + 1) + '…" class="fl-step-field" data-step-index="' + i + '" maxlength="150">';
      html += '<button class="fl-btn-remove-step" data-action="remove-step" data-index="' + i + '" title="Remove">&times;</button>';
      html += '</div>';
    });
    // Always show at least one empty input
    html += '<div class="fl-step-input-row">';
    html += '<input type="text" placeholder="Step ' + (state.steps.length + 1) + '…" class="fl-step-field" data-step-index="' + state.steps.length + '" maxlength="150">';
    html += '</div>';
    container.innerHTML = html;

    // Bind step inputs
    container.querySelectorAll('.fl-step-field').forEach(function(field) {
      field.addEventListener('input', function() {
        var idx = parseInt(field.getAttribute('data-step-index'));
        state.steps[idx] = field.value;
      });
      field.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (!field.value.trim()) return;
          state.steps[field.value.trim()] = field.value;
          state.steps.push('');
          renderStepsInput();
          var inputs = document.querySelectorAll('.fl-step-field');
          if (inputs.length > 0) inputs[inputs.length - 1].focus();
        }
      });
    });
  }

  // ── Bind: due date toggle ──────────────────────────────────────────────────────
  function bindDueDateToggle() {
    var btn = document.getElementById('fl-due-date-toggle-btn');
    var area = document.getElementById('fl-due-date-inputs-area');
    if (btn && area) {
      btn.addEventListener('click', function() {
        area.style.display = area.style.display === 'none' ? 'block' : 'none';
      });
    }
    var clearBtn = document.getElementById('fl-clear-due-date-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', function() {
        var dateEl = document.getElementById('fl-task-due-date');
        var timeEl = document.getElementById('fl-task-due-time');
        if (dateEl) dateEl.value = '';
        if (timeEl) timeEl.value = '';
      });
    }
  }

  // ── Bind: duration toggle ──────────────────────────────────────────────────────
  function bindDurationToggle() {
    var btn = document.getElementById('fl-duration-toggle-btn');
    var area = document.getElementById('fl-duration-input-area');
    if (btn && area) {
      btn.addEventListener('click', function() {
        area.style.display = area.style.display === 'none' ? 'block' : 'none';
      });
    }
  }

  // ── Bind: delegated actions ────────────────────────────────────────────────────
  function bindDelegatedActions() {
    document.addEventListener('click', function(e) {
      var target = e.target;
      var actionEl = target.closest('[data-action]');
      if (!actionEl) return;

      var action = actionEl.getAttribute('data-action');

      // Toggle task completion
      if (action === 'toggle-task') {
        var id = actionEl.getAttribute('data-id');
        flApi('PATCH', '/tasks/' + id + '/toggle').then(function() {
          var idx = state.tasks.findIndex(function(t) { return String(t.id) === String(id); });
          if (idx >= 0) {
            state.tasks[idx].is_completed = !state.tasks[idx].is_completed;
          }
          renderTaskList();
          fetchAllTasks();
        }).catch(function(err) { alert(err.message); });
        return;
      }

      // Delete task
      if (action === 'delete-task') {
        var id = actionEl.getAttribute('data-id');
        if (!confirm('Delete this task?')) return;
        flApi('DELETE', '/tasks/' + id).then(function() {
          state.tasks = state.tasks.filter(function(t) { return String(t.id) !== String(id); });
          renderTaskList();
          fetchAllTasks();
        }).catch(function(err) { alert(err.message); });
        return;
      }

      // Expand/collapse task
      if (action === 'expand-task') {
        var id = actionEl.getAttribute('data-id');
        var task = state.tasks.find(function(t) { return String(t.id) === String(id); });
        state.expandedTasks[String(id)] = !state.expandedTasks[String(id)];
        var isNowExpanded = !!state.expandedTasks[String(id)];

        var stepsPromise = (task && !task.steps)
          ? flApi('GET', '/tasks/' + id).then(function(data) {
              if (data.task) {
                var idx = state.tasks.findIndex(function(t) { return String(t.id) === String(id); });
                if (idx >= 0) state.tasks[idx] = data.task;
              }
            }).catch(function() {})
          : Promise.resolve();

        var briefPromise = (isNowExpanded && !state.reentryBriefs[String(id)])
          ? flApi('GET', '/tasks/' + id + '/reentry-brief')
              .then(function(data) { if (data.brief) state.reentryBriefs[String(id)] = data.brief; })
              .catch(function() {})
          : Promise.resolve();

        Promise.all([stepsPromise, briefPromise]).then(function() { renderTaskList(); });
        return;
      }

      // Toggle completed section
      if (action === 'toggle-completed-section') {
        state.completedExpanded = !state.completedExpanded;
        renderTaskList();
        return;
      }

      // Toggle step
      if (action === 'toggle-step') {
        var taskId = actionEl.getAttribute('data-task-id');
        var stepId = actionEl.getAttribute('data-step-id');
        flApi('PATCH', '/tasks/' + taskId + '/steps/' + stepId + '/toggle').then(function() {
          var task = state.tasks.find(function(t) { return String(t.id) === String(taskId); });
          if (task && task.steps) {
            var step = task.steps.find(function(s) { return String(s.id) === String(stepId); });
            if (step) step.is_completed = !step.is_completed;
          }
          renderTaskList();
        }).catch(function(err) { alert(err.message); });
        return;
      }

      // Delete step
      if (action === 'delete-step') {
        var taskId = actionEl.getAttribute('data-task-id');
        var stepId = actionEl.getAttribute('data-step-id');
        flApi('DELETE', '/tasks/' + taskId + '/steps/' + stepId).then(function() {
          var task = state.tasks.find(function(t) { return String(t.id) === String(taskId); });
          if (task && task.steps) {
            task.steps = task.steps.filter(function(s) { return String(s.id) !== String(stepId); });
          }
          renderTaskList();
        }).catch(function(err) { alert(err.message); });
        return;
      }

      // Add step
      if (action === 'add-step') {
        var taskId = actionEl.getAttribute('data-task-id');
        var stepInput = document.getElementById('new-step-' + taskId);
        if (!stepInput || !stepInput.value.trim()) { stepInput && stepInput.focus(); return; }
        flApi('POST', '/tasks/' + taskId + '/steps', { title: stepInput.value.trim() }).then(function(data) {
          if (data.step) {
            var task = state.tasks.find(function(t) { return String(t.id) === String(taskId); });
            if (task) {
              if (!task.steps) task.steps = [];
              task.steps.push(data.step);
            }
          }
          stepInput.value = '';
          renderTaskList();
        }).catch(function(err) { alert(err.message); });
        return;
      }

      // Notes
      if (action === 'toggle-task-notes') {
        var id = actionEl.getAttribute('data-id');
        state.notesExpanded[String(id)] = !state.notesExpanded[String(id)];
        renderTaskList();
        if (state.notesExpanded[String(id)]) {
          setTimeout(function() {
            var ta = document.querySelector('#task-notes-' + id + ' .task-notes-textarea');
            if (ta) ta.focus();
          }, 0);
        }
        return;
      }
      if (action === 'save-task-notes') {
        var id = actionEl.getAttribute('data-id');
        var ta = document.querySelector('#task-notes-' + id + ' .task-notes-textarea');
        if (!ta) return;
        flApi('PATCH', '/tasks/' + id, { notes: ta.value }).then(function(data) {
          var idx = state.tasks.findIndex(function(t) { return String(t.id) === String(id); });
          if (idx >= 0 && data.task) state.tasks[idx].notes = data.task.notes;
          state.notesExpanded[String(id)] = false;
          renderTaskList();
        }).catch(function() {});
        return;
      }

      // Edit due date
      if (action === 'edit-due-date') {
        var id = actionEl.getAttribute('data-id');
        state.editingDueDateTaskId = String(id);
        renderTaskList();
        setTimeout(function() {
          var di = document.getElementById('due-edit-date-' + id);
          if (di) di.focus();
        }, 0);
        return;
      }
      if (action === 'save-due-date') {
        var id = actionEl.getAttribute('data-id');
        var dateEl = document.getElementById('due-edit-date-' + id);
        var timeEl = document.getElementById('due-edit-time-' + id);
        flApi('PATCH', '/tasks/' + id, {
          due_date: dateEl && dateEl.value ? dateEl.value : null,
          due_time: timeEl && timeEl.value ? timeEl.value : null
        }).then(function(data) {
          var idx = state.tasks.findIndex(function(t) { return String(t.id) === String(id); });
          if (idx >= 0 && data.task) state.tasks[idx] = data.task;
          state.editingDueDateTaskId = null;
          renderTaskList();
          fetchAllTasks();
        }).catch(function(err) { alert(err.message); state.editingDueDateTaskId = null; renderTaskList(); });
        return;
      }
      if (action === 'cancel-due-date') {
        state.editingDueDateTaskId = null;
        renderTaskList();
        return;
      }

      // Edit duration
      if (action === 'edit-duration') {
        var id = actionEl.getAttribute('data-id');
        state.editingDurationTaskId = String(id);
        renderTaskList();
        setTimeout(function() {
          var di = document.getElementById('dur-input-' + id);
          if (di) { di.focus(); di.select(); }
        }, 0);
        return;
      }
      if (action === 'save-duration') {
        var id = actionEl.getAttribute('data-id');
        var di = document.getElementById('dur-input-' + id);
        var mins = di ? parseInt(di.value) : null;
        if (mins !== null && (isNaN(mins) || mins < 1)) mins = null;
        flApi('PATCH', '/tasks/' + id + '/duration', { duration_minutes: mins }).then(function(data) {
          var idx = state.tasks.findIndex(function(t) { return String(t.id) === String(id); });
          if (idx >= 0 && data.task) {
            state.tasks[idx].duration_minutes = data.task.duration_minutes;
            state.tasks[idx].duration_source = data.task.duration_source;
          }
          state.editingDurationTaskId = null;
          renderTaskList();
        }).catch(function(err) { alert(err.message); state.editingDurationTaskId = null; renderTaskList(); });
        return;
      }
      if (action === 'cancel-duration') {
        state.editingDurationTaskId = null;
        renderTaskList();
        return;
      }

      // Remove step from breakdown input
      if (action === 'remove-step') {
        var idx = parseInt(actionEl.getAttribute('data-index'));
        state.steps.splice(idx, 1);
        renderStepsInput();
        return;
      }

      // Inline duration input in task card (keydown)
      if (action === 'inline-duration-input') {
        var input = actionEl;
        input.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') {
            var id = input.getAttribute('data-id');
            var mins = parseInt(input.value);
            if (isNaN(mins) || mins < 1) mins = null;
            flApi('PATCH', '/tasks/' + id + '/duration', { duration_minutes: mins }).then(function(data) {
              var tIdx = state.tasks.findIndex(function(t) { return String(t.id) === String(id); });
              if (tIdx >= 0 && data.task) {
                state.tasks[tIdx].duration_minutes = data.task.duration_minutes;
                state.tasks[tIdx].duration_source = data.task.duration_source;
              }
              state.editingDurationTaskId = null;
              renderTaskList();
            }).catch(function() { state.editingDurationTaskId = null; renderTaskList(); });
          }
          if (e.key === 'Escape') {
            state.editingDurationTaskId = null;
            renderTaskList();
          }
        });
      }

      // Edit title in detail view
      if (action === 'edit-title') {
        var id = actionEl.getAttribute('data-id');
        state.editingTitleTaskId = String(id);
        renderTaskList();
        setTimeout(function() {
          var el = document.getElementById('title-edit-' + id);
          if (el) { el.focus(); el.select(); }
        }, 0);
        return;
      }
      if (action === 'save-title') {
        var id = actionEl.getAttribute('data-id');
        var el = document.getElementById('title-edit-' + id);
        if (!el) return;
        var newTitle = el.value.trim();
        if (!newTitle) return;
        flApi('PATCH', '/tasks/' + id, { title: newTitle }).then(function(data) {
          var idx = state.tasks.findIndex(function(t) { return String(t.id) === String(id); });
          if (idx >= 0 && data.task) state.tasks[idx].title = data.task.title;
          state.editingTitleTaskId = null;
          renderTaskList();
        }).catch(function() { state.editingTitleTaskId = null; renderTaskList(); });
        return;
      }
      if (action === 'cancel-title') {
        state.editingTitleTaskId = null;
        renderTaskList();
        return;
      }

      // Detail view: due date/time change (auto-save on blur)
      if (action === 'detail-due-date' || action === 'detail-due-time') {
        var id = actionEl.getAttribute('data-id');
        var dateEl = document.getElementById('detail-due-date-' + id);
        var timeEl = document.getElementById('detail-due-time-' + id);
        var saveDueDate = function() {
          flApi('PATCH', '/tasks/' + id, {
            due_date: dateEl && dateEl.value ? dateEl.value : null,
            due_time: timeEl && timeEl.value ? timeEl.value : null
          }).then(function(data) {
            var idx = state.tasks.findIndex(function(t) { return String(t.id) === String(id); });
            if (idx >= 0 && data.task) state.tasks[idx] = data.task;
            renderTaskList();
          }).catch(function() {});
        };
        dateEl.addEventListener('change', saveDueDate);
        timeEl.addEventListener('change', saveDueDate);
        return;
      }

      // Set value tag from detail view
      if (action === 'set-value') {
        var id = actionEl.getAttribute('data-id');
        var valueIdStr = actionEl.getAttribute('data-value-id');
        var newValueId = valueIdStr === '' ? null : parseInt(valueIdStr);
        flApi('PATCH', '/tasks/' + id, { value_id: newValueId }).then(function(data) {
          var idx = state.tasks.findIndex(function(t) { return String(t.id) === String(id); });
          if (idx >= 0 && data.task) state.tasks[idx].value_id = data.task.value_id;
          renderTaskList();
        }).catch(function() {});
        return;
      }

      // Set recurrence type
      if (action === 'set-recurrence') {
        var id = actionEl.getAttribute('data-id');
        var recVal = actionEl.getAttribute('data-rec-val');
        var task = state.tasks.find(function(t) { return String(t.id) === String(id); });
        var recDay = task ? task.recurrence_day : null;
        flApi('PATCH', '/tasks/' + id, {
          recurrence_type: recVal,
          recurrence_day: (recVal === 'weekly' || recVal === 'monthly') ? recDay : null
        }).then(function(data) {
          var idx = state.tasks.findIndex(function(t) { return String(t.id) === String(id); });
          if (idx >= 0 && data.task) state.tasks[idx] = data.task;
          renderTaskList();
        }).catch(function() {});
        return;
      }

      // Set recurrence day
      if (action === 'set-recurrence-day') {
        var id = actionEl.getAttribute('data-id');
        var recDayVal = parseInt(actionEl.getAttribute('data-rec-val'));
        var task = state.tasks.find(function(t) { return String(t.id) === String(id); });
        if (!task) return;
        flApi('PATCH', '/tasks/' + id, {
          recurrence_type: task.recurrence_type || 'weekly',
          recurrence_day: recDayVal
        }).then(function(data) {
          var idx = state.tasks.findIndex(function(t) { return String(t.id) === String(id); });
          if (idx >= 0 && data.task) state.tasks[idx] = data.task;
          renderTaskList();
        }).catch(function() {});
        return;
      }
    });

    // ── Tap-outside to dismiss expanded detail view ─────────────────────────
    document.addEventListener('click', function(e) {
      var detailCard = e.target.closest('[data-detail-open="1"]');
      var detailContent = e.target.closest('.task-expanded-content');
      var detailActions = e.target.closest('[data-action]');
      // If click is outside any expanded card, collapse all
      if (!detailCard && !detailContent && !detailActions) {
        var hadExpanded = Object.keys(state.expandedTasks).length > 0;
        if (hadExpanded) {
          state.expandedTasks = {};
          renderTaskList();
        }
      }
    });
  }

  // ── Bind: nav + subscription ──────────────────────────────────────────────────
  function bindNavAndSubscription() {
    // Shared nav JS is loaded separately
    // Just bind the sign-out button
    var signOut = document.getElementById('fl-sign-out-btn');
    if (signOut) {
      signOut.addEventListener('click', function() {
        localStorage.removeItem('fl_token');
        localStorage.removeItem('fl_user');
        window.location.href = '/login';
      });
    }
  }

  // ── Expose for external init ──────────────────────────────────────────────────
  window.FLTasksPage = { init: init, refresh: fetchAllTasks };

  // Auto-init when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();