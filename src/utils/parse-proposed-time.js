function parseProposedTime(proposedTime) {
  if (!proposedTime) return new Date().toISOString();
  if (/^\d{4}-\d{2}-\d{2}/.test(proposedTime)) return new Date(proposedTime).toISOString();

  const now = new Date();
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const lower = proposedTime.toLowerCase();
  let targetDate = new Date(now);

  for (let i = 0; i < days.length; i++) {
    if (lower.includes(days[i])) {
      let daysAhead = i - now.getDay();
      if (daysAhead <= 0) daysAhead += 7;
      targetDate = new Date(now);
      targetDate.setDate(now.getDate() + daysAhead);
      break;
    }
  }

  if (lower.includes('tomorrow')) {
    targetDate = new Date(now);
    targetDate.setDate(now.getDate() + 1);
  }

  const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2] || '0', 10);
    const ampm = timeMatch[3]?.toLowerCase();
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    targetDate.setHours(hours, minutes, 0, 0);
  }

  return targetDate.toISOString();
}

module.exports = { parseProposedTime };
