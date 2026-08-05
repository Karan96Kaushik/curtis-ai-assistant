/**
 * Detect deferred / scheduled action language so other domains (jira, etc.)
 * do not steal the turn and run immediately.
 */
function looksLikeDeferredSchedule(text) {
  const t = String(text || '');
  if (!t.trim()) return false;

  // Relative delay: "in 3 minutes", "in 1 hour"
  if (/\bin\s+\d+\s*(min|mins|minutes?|hrs?|hours?|days?|weeks?)\b/i.test(t)) return true;

  // Explicit schedule / remind / wake
  if (/\b(schedule|remind(\s+me)?|wake\s+up|run\s+this\s+at|trigger\s+at)\b/i.test(t)) return true;

  // Clock time with schedule flavour: "at 1:30", "at 13:30", "tomorrow at 9am"
  if (/\b(tomorrow|tonight|later)\b/i.test(t) && /\bat\b/i.test(t)) return true;
  if (/\bat\s+\d{1,2}([:.\s]\d{2})?\s*(am|pm|bst|gmt)?\b/i.test(t) &&
      /\b(send|message|remind|check|summary|wake|schedule|ping)\b/i.test(t)) {
    return true;
  }

  // "as a message in …" / "message me in …" / "send me … later"
  if (/\b(as a message|message me|dm me|ping me|send me)\b/i.test(t) &&
      /\b(in\s+\d+|later|tomorrow|tonight|at\s+\d)/i.test(t)) {
    return true;
  }

  // Recurring
  if (/\bevery\s+(day|morning|evening|hour|weekday|monday|week)\b/i.test(t)) return true;
  if (/\b(list|show|my)\s+schedules?\b/i.test(t)) return true;
  if (/\bcancel\s+(schedule|reminder|job)\b/i.test(t)) return true;

  return false;
}

module.exports = { looksLikeDeferredSchedule };
