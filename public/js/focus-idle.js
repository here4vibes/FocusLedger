/**
 * focus-idle.js — pure time accounting for Focus Mode's idle detection.
 *
 * Owns: advancing the focus timer by wall-clock seconds, deciding when the
 *       user counts as away, and applying their "what was that time?" answer.
 * Does NOT own: DOM, events or the session API (public/app/focus.html).
 *
 * The idea of asking on return (track it / call it a break) instead of silently
 * dropping or keeping idle time comes from Super Productivity's idle dialog
 * (MIT, see THIRD_PARTY_NOTICES.md). No code is copied; this is written for
 * FocusLedger's plain-JS timer.
 *
 * Works in the browser (window.FocusIdle) and in Node for Jest (module.exports).
 */
(function (root) {
    'use strict';

    var DEFAULT_IDLE_MINUTES = 5;
    var POM_WORK_SECS = 25 * 60;
    var POM_BREAK_SECS = 5 * 60;

    function clone(state) {
        return {
            timerSecs: state.timerSecs,
            timerLeft: state.timerLeft,
            timesUp: !!state.timesUp,
            pomodoroMode: !!state.pomodoroMode,
            pomodoroPhase: state.pomodoroPhase || 'work',
            pomodoroCount: state.pomodoroCount || 0,
            focusedSecs: state.focusedSecs || 0,
        };
    }

    /**
     * Run the timer forward by `secs` seconds. Counts down, rolls Pomodoro
     * phases over, stops at "time's up" in plain mode. Only work time is added
     * to focusedSecs (a Pomodoro break isn't focus).
     * Returns { state, phaseChanged, becameTimesUp }; the input is not mutated.
     */
    function advance(state, secs) {
        var s = clone(state);
        var left = Math.max(0, Math.floor(secs || 0));
        var phaseChanged = false;
        var becameTimesUp = false;
        while (left > 0 && !s.timesUp) {
            var step = Math.min(left, s.timerLeft);
            s.timerLeft -= step;
            left -= step;
            if (!s.pomodoroMode || s.pomodoroPhase === 'work') s.focusedSecs += step;
            if (s.timerLeft <= 0) {
                if (s.pomodoroMode) {
                    if (s.pomodoroPhase === 'work') {
                        s.pomodoroCount += 1;
                        s.pomodoroPhase = 'break';
                        s.timerSecs = POM_BREAK_SECS;
                    } else {
                        s.pomodoroPhase = 'work';
                        s.timerSecs = POM_WORK_SECS;
                    }
                    s.timerLeft = s.timerSecs;
                    phaseChanged = true;
                } else {
                    s.timerLeft = 0;
                    s.timesUp = true;
                    becameTimesUp = true;
                }
            }
        }
        return { state: s, phaseChanged: phaseChanged, becameTimesUp: becameTimesUp };
    }

    /** True once there has been no sign of the user for `idleMs`. */
    function isAway(lastActivityAt, now, idleMs) {
        if (lastActivityAt == null || !(idleMs > 0)) return false;
        return now - lastActivityAt >= idleMs;
    }

    /** "12 min", "1 min", "1 hr 5 min". Rounds to the nearest minute, minimum 1. */
    function formatAway(ms) {
        var mins = Math.max(1, Math.round((ms || 0) / 60000));
        if (mins < 60) return mins + ' min';
        var h = Math.floor(mins / 60);
        var m = mins % 60;
        return h + ' hr' + (m ? ' ' + m + ' min' : '');
    }

    /**
     * Apply the user's answer about the time they were away.
     * `snapshot` is the timer state at their last activity; `awaySecs` is how
     * long they were gone. Returns { state, end, breakSecs }:
     *   focus → the away time runs through the timer as focus
     *   break → the timer resumes from the snapshot; the time is a break
     *   end   → stop here, keeping only the focus up to the snapshot
     */
    function resolveAway(choice, snapshot, awaySecs) {
        var secs = Math.max(0, Math.floor(awaySecs || 0));
        if (choice === 'focus') return { state: advance(snapshot, secs).state, end: false, breakSecs: 0 };
        if (choice === 'break') return { state: clone(snapshot), end: false, breakSecs: secs };
        if (choice === 'end') return { state: clone(snapshot), end: true, breakSecs: secs };
        throw new Error('[focus-idle] unknown choice: ' + choice);
    }

    var api = {
        DEFAULT_IDLE_MINUTES: DEFAULT_IDLE_MINUTES,
        POM_WORK_SECS: POM_WORK_SECS,
        POM_BREAK_SECS: POM_BREAK_SECS,
        advance: advance,
        isAway: isAway,
        formatAway: formatAway,
        resolveAway: resolveAway,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.FocusIdle = api;
})(typeof window !== 'undefined' ? window : this);
