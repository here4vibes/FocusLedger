const { parseAiJson } = require('../lib/ai-json');

test('plain JSON', () => expect(parseAiJson('{"minutes": 30}')).toEqual({ minutes: 30 }));
test('```json fenced (NODE-EXPRESS-D)', () => expect(parseAiJson('```json\n{"minutes": 45}\n```')).toEqual({ minutes: 45 }));
test('bare ``` fence', () => expect(parseAiJson('```\n[1,2]\n```')).toEqual([1, 2]));
test('sentence around it', () => expect(parseAiJson('Sure! {"minutes": 15} hope that helps')).toEqual({ minutes: 15 }));
test('throws when there is no JSON', () => expect(() => parseAiJson('about half an hour')).toThrow());
test('throws on non-text', () => expect(() => parseAiJson(undefined)).toThrow());
