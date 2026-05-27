/**
 * Unit tests for lib/taskParsingService.js
 *
 * Tests cover:
 * - Single task extraction
 * - Multiple task extraction from brain-dump text
 * - Edge cases: empty input, gibberish, mixed task/non-task text
 * - Output schema consistency
 * - Completion detection with confidence scoring
 * - Delimiter-based fallback behavior
 */

jest.mock('../lib/polsia-ai');
const { chatMessages } = require('../lib/polsia-ai');
const {
  extractTasks,
  detectCompletions,
  tryDelimiterSplit,
  COMPLETION_MIN_CONFIDENCE
} = require('../lib/taskParsingService');

describe('taskParsingService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ──────────────────────────────────────────────────────────────────
  // extractTasks tests
  // ──────────────────────────────────────────────────────────────────

  describe('extractTasks', () => {
    it('should return empty array for empty input', async () => {
      const result = await extractTasks('');
      expect(result).toEqual([]);
    });

    it('should return empty array for whitespace-only input', async () => {
      const result = await extractTasks('   \n\n   ');
      expect(result).toEqual([]);
    });

    it('should extract a single task', async () => {
      chatMessages.mockResolvedValue(JSON.stringify({
        tasks: [
          { title: 'Call the dentist', value_name: null, priority: 'high' }
        ]
      }));

      const result = await extractTasks('I need to call the dentist');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        title: 'Call the dentist',
        value_name: null,
        value_id: null,
        priority: 'high'
      });
    });

    it('should extract multiple tasks from brain dump', async () => {
      chatMessages.mockResolvedValue(JSON.stringify({
        tasks: [
          { title: 'Pay electric bill', value_name: 'Financial responsibility', priority: 'high' },
          { title: 'Schedule doctor visit', value_name: 'Health', priority: 'medium' },
          { title: 'Review job offers', value_name: 'Career', priority: 'medium' }
        ]
      }));

      const userValues = [
        { id: 1, value_name: 'Health' },
        { id: 2, value_name: 'Financial responsibility' },
        { id: 3, value_name: 'Career' }
      ];

      const result = await extractTasks(
        'Pay the electric bill and schedule a doctor visit. Also need to review those job offers.',
        userValues
      );

      expect(result).toHaveLength(3);
      expect(result[0].title).toBe('Pay electric bill');
      expect(result[0].priority).toBe('high');
      expect(result[0].value_id).toBe(2);
      expect(result[1].title).toBe('Schedule doctor visit');
      expect(result[1].value_id).toBe(1);
      expect(result[2].title).toBe('Review job offers');
    });

    it('should filter out tasks with empty titles', async () => {
      chatMessages.mockResolvedValue(JSON.stringify({
        tasks: [
          { title: 'Valid task', value_name: null, priority: 'medium' },
          { title: '', value_name: null, priority: 'low' },
          { title: '   ', value_name: null, priority: 'medium' }
        ]
      }));

      const result = await extractTasks('Some brain dump text');
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Valid task');
    });

    it('should enforce 200-char title limit', async () => {
      const longTitle = 'a'.repeat(300);
      chatMessages.mockResolvedValue(JSON.stringify({
        tasks: [
          { title: longTitle, value_name: null, priority: 'medium' }
        ]
      }));

      const result = await extractTasks('Some text');
      expect(result[0].title.length).toBe(200);
    });

    it('should normalize priority values', async () => {
      chatMessages.mockResolvedValue(JSON.stringify({
        tasks: [
          { title: 'Task 1', value_name: null, priority: 'INVALID' },
          { title: 'Task 2', value_name: null, priority: 'high' }
        ]
      }));

      const result = await extractTasks('Some text');
      expect(result[0].priority).toBe('medium'); // default for invalid
      expect(result[1].priority).toBe('high');
    });

    it('should map value names to IDs case-insensitively', async () => {
      chatMessages.mockResolvedValue(JSON.stringify({
        tasks: [
          { title: 'Task 1', value_name: 'Health', priority: 'medium' }
        ]
      }));

      const userValues = [
        { id: 10, value_name: 'health' } // lowercase in DB
      ];

      const result = await extractTasks('Some text', userValues);
      expect(result[0].value_id).toBe(10);
    });

    it('should handle AI errors gracefully with delimiter fallback', async () => {
      chatMessages.mockRejectedValue(new Error('AI service down'));

      const text = 'Call dentist\nSchedule meeting\nPay bills';
      const result = await extractTasks(text);

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].title).toBe('Call dentist');
    });

    it('should return empty array when both AI and delimiter fallback fail', async () => {
      chatMessages.mockRejectedValue(new Error('AI service down'));

      const result = await extractTasks('Single line of text');
      expect(result).toEqual([]);
    });

    it('should handle malformed JSON from AI gracefully', async () => {
      chatMessages.mockResolvedValue('{ invalid json ]');

      const text = 'Task one\nTask two';
      const result = await extractTasks(text);

      // Should fall back to delimiter split
      expect(result.length).toBeGreaterThan(0);
    });

    it('should pass user values to AI prompt', async () => {
      chatMessages.mockResolvedValue(JSON.stringify({ tasks: [] }));

      const userValues = [
        { id: 1, value_name: 'Family' }
      ];

      await extractTasks('Some text', userValues);

      expect(chatMessages).toHaveBeenCalled();
      const call = chatMessages.mock.calls[0][0];
      const prompt = call[0].content;
      expect(prompt).toContain('Family');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // detectCompletions tests
  // ──────────────────────────────────────────────────────────────────

  describe('detectCompletions', () => {
    it('should return empty array for empty text', async () => {
      const result = await detectCompletions('', [{ id: 1, title: 'Task 1' }]);
      expect(result).toEqual([]);
    });

    it('should return empty array when no active tasks', async () => {
      const result = await detectCompletions('I did something', []);
      expect(result).toEqual([]);
    });

    it('should detect a completed task', async () => {
      chatMessages.mockResolvedValue(JSON.stringify({
        completions: [
          {
            task_id: 123,
            confidence: 0.95,
            matched_phrase: 'I finally called the dentist',
            match_type: 'complete',
            followup_task_title: null
          }
        ]
      }));

      const activeTasks = [
        { id: 123, title: 'Call the dentist' }
      ];

      const result = await detectCompletions('I finally called the dentist', activeTasks);
      expect(result).toHaveLength(1);
      expect(result[0].task_id).toBe(123);
      expect(result[0].confidence).toBe(0.95);
      expect(result[0].match_type).toBe('complete');
    });

    it('should filter out matches below confidence threshold', async () => {
      chatMessages.mockResolvedValue(JSON.stringify({
        completions: [
          {
            task_id: 123,
            confidence: 0.65, // Below 0.70 threshold
            matched_phrase: 'did something',
            match_type: 'complete',
            followup_task_title: null
          },
          {
            task_id: 124,
            confidence: 0.92,
            matched_phrase: 'I definitely finished the report',
            match_type: 'complete',
            followup_task_title: null
          }
        ]
      }));

      const activeTasks = [
        { id: 123, title: 'Task 1' },
        { id: 124, title: 'Finish the report' }
      ];

      const result = await detectCompletions('did something and finished the report', activeTasks);
      expect(result).toHaveLength(1);
      expect(result[0].task_id).toBe(124);
    });

    it('should validate task IDs exist in active tasks', async () => {
      chatMessages.mockResolvedValue(JSON.stringify({
        completions: [
          {
            task_id: 999, // Does not exist
            confidence: 0.95,
            matched_phrase: 'did something',
            match_type: 'complete',
            followup_task_title: null
          }
        ]
      }));

      const activeTasks = [
        { id: 123, title: 'Task 1' }
      ];

      const result = await detectCompletions('I did something', activeTasks);
      expect(result).toEqual([]);
    });

    it('should handle partial completions', async () => {
      chatMessages.mockResolvedValue(JSON.stringify({
        completions: [
          {
            task_id: 123,
            confidence: 0.88,
            matched_phrase: 'I started the project',
            match_type: 'partial',
            followup_task_title: null
          }
        ]
      }));

      const activeTasks = [
        { id: 123, title: 'Start the project' }
      ];

      const result = await detectCompletions('I started the project but need to finish', activeTasks);
      expect(result[0].match_type).toBe('partial');
    });

    it('should include followup_task_title when present', async () => {
      chatMessages.mockResolvedValue(JSON.stringify({
        completions: [
          {
            task_id: 123,
            confidence: 0.91,
            matched_phrase: 'I called but need to follow up',
            match_type: 'complete',
            followup_task_title: 'Follow up on call'
          }
        ]
      }));

      const activeTasks = [
        { id: 123, title: 'Call mom' }
      ];

      const result = await detectCompletions('I called but need to follow up', activeTasks);
      expect(result[0].followup_task_title).toBe('Follow up on call');
    });

    it('should handle AI errors gracefully', async () => {
      chatMessages.mockRejectedValue(new Error('AI service error'));

      const activeTasks = [
        { id: 123, title: 'Task 1' }
      ];

      const result = await detectCompletions('I did the task', activeTasks);
      expect(result).toEqual([]);
    });

    it('should handle malformed JSON from AI', async () => {
      chatMessages.mockResolvedValue('{ bad json ]');

      const activeTasks = [
        { id: 123, title: 'Task 1' }
      ];

      const result = await detectCompletions('I did the task', activeTasks);
      expect(result).toEqual([]);
    });

    it('should pass active tasks list to AI prompt', async () => {
      chatMessages.mockResolvedValue(JSON.stringify({ completions: [] }));

      const activeTasks = [
        { id: 123, title: 'Call the dentist' },
        { id: 124, title: 'Pay bills' }
      ];

      await detectCompletions('I did something', activeTasks);

      expect(chatMessages).toHaveBeenCalled();
      const call = chatMessages.mock.calls[0][0];
      const prompt = call[0].content;
      expect(prompt).toContain('id=123');
      expect(prompt).toContain('id=124');
      expect(prompt).toContain('Call the dentist');
      expect(prompt).toContain('Pay bills');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // tryDelimiterSplit tests
  // ──────────────────────────────────────────────────────────────────

  describe('tryDelimiterSplit', () => {
    it('should split text by newlines', () => {
      const text = 'Call dentist\nSchedule meeting\nPay bills';
      const result = tryDelimiterSplit(text);
      expect(result).toHaveLength(3);
      expect(result[0].title).toBe('Call dentist');
      expect(result[1].title).toBe('Schedule meeting');
      expect(result[2].title).toBe('Pay bills');
    });

    it('should return null for single line input', () => {
      const result = tryDelimiterSplit('Just one task here');
      expect(result).toBeNull();
    });

    it('should return null for input with fewer than 2 fragments', () => {
      const result = tryDelimiterSplit('Single fragment');
      expect(result).toBeNull();
    });

    it('should filter out short fragments', () => {
      const text = 'Call dentist\na\n\nSchedule meeting\nb c\nPay bills';
      const result = tryDelimiterSplit(text);
      // Only 'Call dentist', 'Schedule meeting', 'Pay bills' should remain (all > 3 chars)
      expect(result.length).toBe(3);
    });

    it('should trim whitespace from fragments', () => {
      const text = '  Call dentist  \n  Schedule meeting  ';
      const result = tryDelimiterSplit(text);
      expect(result[0].title).toBe('Call dentist');
      expect(result[1].title).toBe('Schedule meeting');
    });

    it('should enforce 120-char title limit', () => {
      const longLine = 'a'.repeat(150);
      const text = `Short\n${longLine}`;
      const result = tryDelimiterSplit(text);
      expect(result[1].title.length).toBe(120);
    });

    it('should set default values for extracted tasks', () => {
      const result = tryDelimiterSplit('Task 1\nTask 2');
      expect(result[0]).toEqual({
        title: 'Task 1',
        value_name: null,
        value_id: null,
        priority: 'medium'
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Constants tests
  // ──────────────────────────────────────────────────────────────────

  describe('constants', () => {
    it('should export COMPLETION_MIN_CONFIDENCE constant', () => {
      expect(COMPLETION_MIN_CONFIDENCE).toBe(0.70);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Integration scenarios
  // ──────────────────────────────────────────────────────────────────

  describe('integration scenarios', () => {
    it('should handle full conversation workflow: extract then detect', async () => {
      // First, user brain dumps
      chatMessages.mockResolvedValueOnce(JSON.stringify({
        tasks: [
          { title: 'Call the dentist', value_name: null, priority: 'high' },
          { title: 'Pay electric bill', value_name: null, priority: 'high' }
        ]
      }));

      const extracted = await extractTasks('I need to call the dentist and pay my electric bill');
      expect(extracted).toHaveLength(2);

      // Later, user says they did one
      chatMessages.mockResolvedValueOnce(JSON.stringify({
        completions: [
          {
            task_id: 100,
            confidence: 0.92,
            matched_phrase: 'already called the dentist',
            match_type: 'complete',
            followup_task_title: null
          }
        ]
      }));

      const activeTasks = [
        { id: 100, title: 'Call the dentist' },
        { id: 101, title: 'Pay electric bill' }
      ];

      const completions = await detectCompletions('I already called the dentist this morning', activeTasks);
      expect(completions).toHaveLength(1);
      expect(completions[0].task_id).toBe(100);
    });

    it('should handle ADHD-specific brain dump with emotions and context', async () => {
      chatMessages.mockResolvedValue(JSON.stringify({
        tasks: [
          { title: 'Schedule therapy appointment', value_name: 'Mental health', priority: 'high' },
          { title: 'Buy groceries', value_name: null, priority: 'medium' }
        ]
      }));

      const userValues = [
        { id: 1, value_name: 'Mental health' }
      ];

      const text = `I'm so overwhelmed and anxious today. I really need to schedule a therapy appointment.
Also need to buy groceries but that feels impossible right now. Everything is hard.`;

      const result = await extractTasks(text, userValues);

      // Should filter out emotional content and extract only actionable tasks
      expect(result).toHaveLength(2);
      expect(result[0].title).toBe('Schedule therapy appointment');
      expect(result[0].value_id).toBe(1);
      expect(result[1].title).toBe('Buy groceries');
    });
  });
});
