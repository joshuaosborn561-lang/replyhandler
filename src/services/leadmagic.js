async function profileToEmail(linkedinUrl) {
  const res = await fetch('https://api.leadmagic.io/v1/people/profile-to-email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': process.env.LEADMAGIC_API_KEY,
    },
    body: JSON.stringify({ linkedin_url: linkedinUrl }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LeadMagic profileToEmail failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return data.email || null;
}

module.exports = { profileToEmail };
