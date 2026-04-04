async function createBooking(eventTypeId, { name, email, startTime, notes }) {
  const res = await fetch('https://api.cal.com/v2/bookings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'cal-api-version': '2024-08-13',
    },
    body: JSON.stringify({
      eventTypeId: Number(eventTypeId),
      attendee: { name, email, timeZone: 'America/New_York' },
      start: startTime,
      metadata: { notes: notes || '' },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Cal.com createBooking failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.data || data;
}

module.exports = { createBooking };
