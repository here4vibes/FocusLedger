'use strict';

const FocusIdle = require('../public/js/focus-idle');

const plain = (over = {}) => ({
  timerSecs: 25 * 60, timerLeft: 25 * 60, timesUp: false,
  pomodoroMode: false, pomodoroPhase: 'work', pomodoroCount: 0, focusedSecs: 0,
  ...over,
});

describe('advance', () => {
  test('counts down and adds focus time', () => {
    const { state } = FocusIdle.advance(plain(), 90);
    expect(state.timerLeft).toBe(25 * 60 - 90);
    expect(state.focusedSecs).toBe(90);
  });

  test('does not mutate its input', () => {
    const s = plain();
    FocusIdle.advance(s, 10);
    expect(s.timerLeft).toBe(25 * 60);
    expect(s.focusedSecs).toBe(0);
  });

  test('stops at time\'s up and counts no further', () => {
    const r = FocusIdle.advance(plain({ timerLeft: 30 }), 120);
    expect(r.becameTimesUp).toBe(true);
    expect(r.state.timesUp).toBe(true);
    expect(r.state.timerLeft).toBe(0);
    expect(r.state.focusedSecs).toBe(30);
    expect(FocusIdle.advance(r.state, 60).state.focusedSecs).toBe(30);
  });

  test('Pomodoro: rolls work into break and counts only work as focus', () => {
    const s = plain({ pomodoroMode: true, timerLeft: 60 });
    const r = FocusIdle.advance(s, 60 + 120);
    expect(r.phaseChanged).toBe(true);
    expect(r.state.pomodoroPhase).toBe('break');
    expect(r.state.pomodoroCount).toBe(1);
    expect(r.state.timerSecs).toBe(FocusIdle.POM_BREAK_SECS);
    expect(r.state.timerLeft).toBe(FocusIdle.POM_BREAK_SECS - 120);
    expect(r.state.focusedSecs).toBe(60);
  });

  test('Pomodoro: break rolls back into work', () => {
    const s = plain({ pomodoroMode: true, pomodoroPhase: 'break', timerSecs: 300, timerLeft: 10, pomodoroCount: 1 });
    const r = FocusIdle.advance(s, 70);
    expect(r.state.pomodoroPhase).toBe('work');
    expect(r.state.timerLeft).toBe(FocusIdle.POM_WORK_SECS - 60);
    expect(r.state.focusedSecs).toBe(60);
  });

  test('ignores zero, negative and fractional seconds sensibly', () => {
    expect(FocusIdle.advance(plain(), 0).state.focusedSecs).toBe(0);
    expect(FocusIdle.advance(plain(), -5).state.focusedSecs).toBe(0);
    expect(FocusIdle.advance(plain(), 2.9).state.focusedSecs).toBe(2);
  });
});

describe('isAway', () => {
  const FIVE = 5 * 60 * 1000;
  test('false before the threshold, true at and after it', () => {
    expect(FocusIdle.isAway(0, FIVE - 1, FIVE)).toBe(false);
    expect(FocusIdle.isAway(0, FIVE, FIVE)).toBe(true);
    expect(FocusIdle.isAway(0, FIVE * 3, FIVE)).toBe(true);
  });
  test('off when there is no activity time or no threshold', () => {
    expect(FocusIdle.isAway(null, FIVE * 2, FIVE)).toBe(false);
    expect(FocusIdle.isAway(0, FIVE * 2, 0)).toBe(false);
  });
  test('default threshold is 5 minutes', () => {
    expect(FocusIdle.DEFAULT_IDLE_MINUTES).toBe(5);
  });
});

describe('formatAway', () => {
  test.each([
    [0, '1 min'],
    [40 * 1000, '1 min'],
    [12 * 60 * 1000, '12 min'],
    [12 * 60 * 1000 + 29 * 1000, '12 min'],
    [60 * 60 * 1000, '1 hr'],
    [65 * 60 * 1000, '1 hr 5 min'],
  ])('%i ms → %s', (ms, label) => {
    expect(FocusIdle.formatAway(ms)).toBe(label);
  });
});

describe('resolveAway', () => {
  const snap = plain({ timerLeft: 24 * 60, focusedSecs: 60 });

  test('focus: the away time runs through the timer as focus', () => {
    const r = FocusIdle.resolveAway('focus', snap, 12 * 60);
    expect(r.end).toBe(false);
    expect(r.breakSecs).toBe(0);
    expect(r.state.focusedSecs).toBe(60 + 720);
    expect(r.state.timerLeft).toBe(12 * 60);
  });

  test('focus: away longer than the timer stops at time\'s up', () => {
    const r = FocusIdle.resolveAway('focus', snap, 60 * 60);
    expect(r.state.timesUp).toBe(true);
    expect(r.state.focusedSecs).toBe(25 * 60);
  });

  test('break: the timer resumes where the user left', () => {
    const r = FocusIdle.resolveAway('break', snap, 12 * 60);
    expect(r.end).toBe(false);
    expect(r.breakSecs).toBe(720);
    expect(r.state).toEqual(snap);
    expect(r.state).not.toBe(snap);
  });

  test('end: stop with only the focus before leaving', () => {
    const r = FocusIdle.resolveAway('end', snap, 12 * 60);
    expect(r.end).toBe(true);
    expect(r.state.focusedSecs).toBe(60);
  });

  test('unknown choice throws', () => {
    expect(() => FocusIdle.resolveAway('nap', snap, 1)).toThrow(/unknown choice/);
  });
});
