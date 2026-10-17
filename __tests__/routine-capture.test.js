jest.mock('../db/routineNudges', () => ({
  recordRoutineCompletion: jest.fn(),
  reopenStaleRoutineTasks: jest.fn(),
  getRoutinesFinishedByTasks: jest.fn(),
}));
jest.mock('../lib/timezone', () => ({
  fetchUserTimezone: jest.fn(async () => 'Not/AZone'),
  validateTimezone: jest.fn((tz) => (tz === 'Not/AZone' ? null : tz)),
  getUserLocalDate: jest.fn(() => '2026-10-17'),
}));
const db = require('../db/routineNudges');
const { onTasksCompleted, refreshRoutineTasks } = require('../lib/routine-capture');

beforeEach(() => jest.clearAllMocks());

test('records a completion for each routine the tick finished', async () => {
  db.getRoutinesFinishedByTasks.mockResolvedValue([{ id: 7, name: 'Morning Essentials' }]);
  db.recordRoutineCompletion.mockResolvedValue({ current_streak: 3, best_streak: 5 });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  const out = await onTasksCompleted({}, 2, '41');
  expect(db.getRoutinesFinishedByTasks).toHaveBeenCalledWith({}, 2, [41], 'America/New_York', '2026-10-17');
  expect(db.recordRoutineCompletion).toHaveBeenCalledWith({}, 2, 7, '2026-10-17');
  expect(out).toEqual([{ routine_id: 7, name: 'Morning Essentials', current_streak: 3, best_streak: 5 }]);
});

test('does nothing for non-routine ticks or bad ids', async () => {
  db.getRoutinesFinishedByTasks.mockResolvedValue([]);
  expect(await onTasksCompleted({}, 2, [9])).toEqual([]);
  expect(await onTasksCompleted({}, 2, ['x'])).toEqual([]);
  expect(db.recordRoutineCompletion).not.toHaveBeenCalled();
});

test('refresh reopens with the validated timezone and local date', async () => {
  db.reopenStaleRoutineTasks.mockResolvedValue(6);
  expect(await refreshRoutineTasks({}, 2)).toBe(6);
  expect(db.reopenStaleRoutineTasks).toHaveBeenCalledWith({}, 2, 'America/New_York', '2026-10-17');
});
