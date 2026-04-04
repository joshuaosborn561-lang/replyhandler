const BASE_URL = 'https://api.heyreach.io/api/public';

async function sendMessage(apiKey, listId, linkedinAccountId, linkedinUrl, message) {
  const url = `${BASE_URL}/inbox/send-message`;
  console.log('[HeyReach] Sending message', { listId, linkedinUrl, messageLength: message.length });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify({
      listId,
      linkedinAccountId,
      linkedinUrl,
      message,
    }),
  });

  const responseBody = await res.text();
  console.log('[HeyReach] Response', { status: res.status, body: responseBody });

  if (!res.ok) {
    throw new Error(`HeyReach sendMessage failed (${res.status}): ${responseBody}`);
  }

  try {
    return JSON.parse(responseBody);
  } catch {
    return { raw: responseBody };
  }
}

module.exports = { sendMessage };
