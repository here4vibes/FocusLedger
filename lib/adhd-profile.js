'use strict';
/**
 * ADHD profile: a lightweight JSON model of how this user's brain works.
 * Updated after every check-in and onboarding conversation; injected into
 * every Claude system prompt so Buddy stops starting from zero each session.
 *
 * Schema (all fields optional — profile grows over time):
 * {
 *   peak_energy: 'morning' | 'afternoon' | 'evening',
 *   avoidance_triggers: string[],   // topics/task-types they avoid
 *   motivation_style: string,       // e.g. "short wins", "deadlines", "social accountability"
 *   impulsivity_window: string,     // e.g. "evenings", "when stressed"
 *   stuck_patterns: string[],       // e.g. ["starting tasks", "transitions"]
 *   struggle_area: string,          // primary life domain from onboarding
 *   updated_at: string              // ISO date
 * }
 */

const { chatMessages } = require('./polsia-ai');

async function getAdhdProfile(pool, userId) {
  const result = await pool.query('SELECT adhd_profile FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.adhd_profile || {};
}

async function updateAdhdProfile(pool, userId, conversationMessages) {
  const existing = await getAdhdProfile(pool, userId);

  const conversationText = conversationMessages
    .map((m) => `${m.role === 'user' ? 'User' : 'Buddy'}: ${m.content}`)
    .join('\n');

  const existingStr = Object.keys(existing).length
    ? `Current profile: ${JSON.stringify(existing)}`
    : 'No existing profile yet.';

  const prompt = `You are analyzing a conversation between a person with ADHD and their coaching companion to update their ADHD behavioral profile.

${existingStr}

Recent conversation:
${conversationText}

Based on what was shared, update the profile. Only include fields where you have genuine signal — don't guess. Merge with the existing profile (keep existing values unless the conversation reveals something new or contradictory).

Return ONLY valid JSON with these optional fields:
{
  "peak_energy": "morning" | "afternoon" | "evening",
  "avoidance_triggers": ["string"],
  "motivation_style": "string",
  "impulsivity_window": "string",
  "stuck_patterns": ["string"],
  "struggle_area": "string",
  "updated_at": "YYYY-MM-DD"
}

If the conversation doesn't reveal anything new, return the existing profile unchanged (with updated_at set to today).
Do not invent data. Return only JSON, no explanation.`;

  try {
    const raw = await chatMessages(
      [{ role: 'user', content: prompt }],
      { maxTokens: 300, model: 'claude-haiku-4-5-20251001' }
    );

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const updated = JSON.parse(jsonMatch[0]);
    updated.updated_at = new Date().toISOString().slice(0, 10);

    await pool.query(
      'UPDATE users SET adhd_profile = $1 WHERE id = $2',
      [JSON.stringify(updated), userId]
    );
  } catch {
    // Non-blocking — profile update failure must never break check-in flow
  }
}

function buildProfilePromptAddition(profile) {
  if (!profile || Object.keys(profile).length === 0) return '';

  const parts = [];
  if (profile.peak_energy) parts.push(`peak energy: ${profile.peak_energy}`);
  if (profile.struggle_area) parts.push(`primary struggle area: ${profile.struggle_area}`);
  if (profile.motivation_style) parts.push(`responds to: ${profile.motivation_style}`);
  if (profile.avoidance_triggers?.length) parts.push(`tends to avoid: ${profile.avoidance_triggers.join(', ')}`);
  if (profile.stuck_patterns?.length) parts.push(`common stuck points: ${profile.stuck_patterns.join(', ')}`);
  if (profile.impulsivity_window) parts.push(`impulsivity tends to spike: ${profile.impulsivity_window}`);

  if (!parts.length) return '';

  return `\n\nWhat you know about this person's brain: ${parts.join('; ')}. Use this to personalize your response — don't recite it back, just let it inform how you engage.`;
}

module.exports = { getAdhdProfile, updateAdhdProfile, buildProfilePromptAddition };
