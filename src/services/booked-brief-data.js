'use strict';

/**
 * Everything the "Meeting booked" brief needs beyond the booking itself: the lead's Smartlead record
 * and email thread, a short company profile (public web), the meeting time (the client's connected
 * calendar when the booking carries none), and an LLM pass that writes the company summary,
 * talking points and watch-outs from ONLY those facts. Every step is best effort with its own
 * timeout: a failed step leaves its section out, it never blocks the email.
 *
 * Spend: one Serper search plus one Claude call per booking (cents). No enrichment waterfall here;
 * LinkedIn uses the existing capped lookup in booked-meeting-email.js.
 */

const smartlead = require('./smartlead');
const { plainFromHtmlish } = require('./client-notify-email');

const TZ = 'America/Chicago';
const CONSUMER = /(^|\.)(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|aol|proton|protonmail|comcast|att|sbcglobal|verizon|bellsouth|cox|charter|gmx|zoho|mail)\.(com|net|me|co\.uk)$/i;

function str(v, max = 500) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, ' ').trim().slice(0, max);
}

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${label} timed out`)), ms); t.unref && t.unref(); }),
  ]).finally(() => clearTimeout(t));
}

async function safe(label, fn, fallback = null) {
  try { return await fn(); } catch (err) {
    console.warn(`[BookedBrief] ${label} skipped`, { err: String(err && err.message || err).slice(0, 200) });
    return fallback;
  }
}

function ctLabel(iso, { withDay = true } = {}) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const opts = { timeZone: TZ, hour: 'numeric', minute: '2-digit' };
  if (withDay) Object.assign(opts, { weekday: 'short', month: 'short', day: 'numeric' });
  return `${new Intl.DateTimeFormat('en-US', opts).format(d)} CT`;
}

function meetingLabel(startIso, endIso) {
  const start = startIso ? new Date(startIso) : null;
  if (!start || Number.isNaN(start.getTime())) return '';
  const day = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' }).format(start);
  const t = (d) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(d);
  const end = endIso ? new Date(endIso) : null;
  return end && !Number.isNaN(end.getTime())
    ? `${day} at ${t(start)} to ${t(end)} CT`
    : `${day} at ${t(start)} CT`;
}

function domainOf(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  const d = at >= 0 ? e.slice(at + 1) : '';
  return d && !CONSUMER.test(d) ? d : '';
}

/** Drop the quoted history and legal footers under a reply, keeping what the person actually wrote. */
function stripQuoted(text) {
  let t = String(text || '').replace(/\r\n/g, '\n');
  const cuts = [
    /\n\s*On .{5,200}wrote:\s*\n/i,
    /\n\s*-{2,}\s*Original Message\s*-{2,}/i,
    /\n\s*From:\s.+\n\s*(Sent|Date):\s/i,
    /\n\s*(The information transmitted|This (e-?mail|message) (and any|is intended)|CONFIDENTIALITY NOTICE)/i,
    /\n_{5,}\s*\n/,
  ];
  for (const re of cuts) {
    const m = t.match(re);
    if (m && m.index > 0) t = t.slice(0, m.index);
  }
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

function threadFrom(historyResponse, { clientName = '' } = {}) {
  const rows = smartlead.historyMessages(historyResponse)
    .map((m) => {
      const type = String(m.type || m.direction || '').toUpperCase();
      const time = m.time || m.sent_at || m.received_at || m.created_at || '';
      const body = stripQuoted(plainFromHtmlish(m.email_body || m.body || m.text || ''));
      return { type, time, body, from: str(m.from, 200), to: str(m.to, 200) };
    })
    .filter((m) => m.body && (m.type === 'SENT' || m.type === 'REPLY'))
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
  return rows.map((m) => ({
    when: ctLabel(m.time),
    iso: m.time,
    direction: m.type === 'REPLY' ? 'in' : 'out',
    from: m.type === 'REPLY' ? (m.from || 'Prospect') : (clientName ? `${clientName} (sent)` : 'Us (sent)'),
    mailbox: m.type === 'SENT' ? m.from : '',
    body: m.body,
  }));
}

function minutesBetween(a, b) {
  const x = new Date(a).getTime();
  const y = new Date(b).getTime();
  return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / 60000) : null;
}

function human(mins) {
  if (mins === null || mins < 0) return '';
  if (mins < 90) return `${mins} minutes`;
  if (mins < 60 * 36) return `${Math.round(mins / 60)} hours`;
  return `${Math.round(mins / 1440)} days`;
}

function timelineText(thread, bookedIso) {
  const first = thread.find((m) => m.direction === 'out');
  const reply = thread.find((m) => m.direction === 'in');
  const parts = [];
  if (first) parts.push(`first email ${ctLabel(first.iso)}`);
  if (first && reply) { const h = human(minutesBetween(first.iso, reply.iso)); if (h) parts.push(`first reply ${h} later`); }
  if (first && bookedIso) { const h = human(minutesBetween(first.iso, bookedIso)); if (h) parts.push(`booked ${h} after the first email`); }
  return parts.join('; ');
}

const PLATFORM_LABEL = {
  calendly: 'Calendly', tidycal: 'TidyCal', msbookings: 'Microsoft Bookings', savvycal: 'SavvyCal', hubspot: 'HubSpot Meetings', allo: 'Cold call',
};

/** Smartlead record and thread for the prospect. Tries each key until one knows the lead. */
async function loadSmartleadContext(m, keys, { sl = smartlead } = {}) {
  const email = str(m.prospect.email, 320);
  let found = null;
  let usedKey = null;
  if (email) {
    for (const key of keys) {
      const hit = await safe('smartlead lead lookup', () => withTimeout(sl.lookupLeadByEmail(key, email), 8000, 'lead lookup'));
      if (hit && hit.leadId) { found = hit; usedKey = key; break; }
    }
  }
  const leadId = str(m.smartleadLeadId, 40) || (found && found.leadId) || '';
  const campaignId = found
    ? sl.pickLeadCampaign(str(m.smartleadCampaignId, 40) || null, found.campaignIds)
    : str(m.smartleadCampaignId, 40);
  const key = usedKey || keys[0] || null;
  if (!key || !leadId || !campaignId) return { lead: found ? found.lead : null, history: null, campaignId: campaignId || null, leadId: leadId || null, campaignName: null };
  const [history, campaignName] = await Promise.all([
    safe('smartlead thread', () => withTimeout(sl.getThreadHistory(key, campaignId, leadId), 12000, 'thread')),
    safe('smartlead campaign', () => withTimeout(sl.resolveCampaignName(key, campaignId), 8000, 'campaign name')),
  ]);
  return { lead: found ? found.lead : null, history, campaignId, leadId, campaignName };
}

async function serperSearch(query, { fetchImpl = fetch, env = process.env } = {}) {
  const key = String(env.SERPER_API_KEY || env.SERPER_KEY || '').trim();
  if (!key || !query) return [];
  const res = await fetchImpl('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: 5 }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`serper ${res.status}`);
  const data = await res.json();
  return (data.organic || []).slice(0, 5).map((o) => ({ title: str(o.title, 160), snippet: str(o.snippet, 300), link: str(o.link, 300) }));
}

async function fetchSiteText(url, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(6000), redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SalesGliderBot/1.0)' } });
  if (!res.ok) throw new Error(`site ${res.status}`);
  const html = (await res.text()).slice(0, 200000);
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) || [])[1] || '';
  return `${str(title, 200)}. ${str(desc, 400)}. ${str(plainFromHtmlish(html).replace(/\s+/g, ' '), 2500)}`;
}

async function researchCompany({ company, website, domain, location }, deps = {}) {
  const site = website || (domain ? `https://${domain}` : '');
  const [results, siteText] = await Promise.all([
    safe('company search', () => (deps.search || serperSearch)(`${company || domain} ${location || ''}`.trim())),
    site ? safe('company site', () => (deps.siteText || fetchSiteText)(/^https?:/i.test(site) ? site : `https://${site}`)) : null,
  ]);
  return { site, results: results || [], siteText: siteText || '' };
}

const SYSTEM = `You write a pre-meeting brief for the person who will take a sales meeting. You get facts about the prospect (CRM record, the email thread, call notes, public web results). Output ONLY JSON:

{"title": string|null, "title_note": string|null, "company": {"what_they_do": string|null, "size": string|null, "notes": string[]}, "hook": string|null, "talking_points": string[], "watch_outs": string[]}

Rules:
- Use only facts in the input. Never invent a fact, number, name or claim. If something is unknown use null or [].
- title: the person's job title as best supported (an email signature beats a CRM field). If the CRM title and the signature disagree, put the signature title in "title" and explain in "title_note" (one sentence). Otherwise title_note is null.
- company.what_they_do: one or two plain sentences from the web results/site text. company.size: employee count and/or revenue ONLY if a source gives it, and say it is an estimate and from where (for example "about 10 employees per ZoomInfo (estimate)"). notes: up to 4 short factual bullets (years in business, locations, who they serve, growth signals) taken from the sources.
- hook: what got them to engage, from the first outbound email and their reply (one short sentence), or null.
- talking_points: 5 to 7 numbered-style points for the meeting host, each one sentence or two. Ground each in the thread, their role, or the company. Start with what made them take the meeting. Include questions to ask. Do not claim anything about the host's own offer, results or pricing unless it is written in the email thread or call notes; refer to it as "our offer" or quote the thread.
- watch_outs: up to 4 short bullets for things to check: data conflicts (title, company name), an unsubscribe or stop status in the record, a missed call, anything uncertain or estimated. Empty array if none.
- Never include API keys, internal tooling names, or the words "Smartlead" or "Allo". Never name the outbound campaign, the sending mailbox or its domain. Write the host's company by the CLIENT name when it appears.
- Plain, professional sentences. No emoji.`;

async function defaultLlm({ system, user }) {
  const { anthropicModel } = require('./anthropic-model');
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: anthropicModel(), max_tokens: 1800, system, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(22000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic brief failed (${res.status})`);
  const data = JSON.parse(text);
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function parseJsonLoose(raw) {
  const t = String(raw || '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

function cleanList(v, max, cap = 500) {
  return (Array.isArray(v) ? v : []).map((x) => str(x, cap)).filter(Boolean).slice(0, max);
}

/** Validate the model's JSON into the shape the brief renders. Never trusts types. */
function normalizeSynthesis(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const co = parsed.company && typeof parsed.company === 'object' ? parsed.company : {};
  const out = {
    title: str(parsed.title, 160) || null,
    titleNote: str(parsed.title_note, 400) || null,
    whatTheyDo: str(co.what_they_do, 600) || null,
    size: str(co.size, 300) || null,
    notes: cleanList(co.notes, 4),
    hook: str(parsed.hook, 300) || null,
    // The brief numbers the list itself; the model sometimes numbers its points too ("1. 1. Open by ...").
    talkingPoints: cleanList(parsed.talking_points, 7).map((t) => t.replace(/^\s*\d{1,2}[.)]\s+/, '')).filter(Boolean),
    watchOuts: cleanList(parsed.watch_outs, 4),
  };
  const any = out.title || out.whatTheyDo || out.talkingPoints.length || out.notes.length || out.watchOuts.length;
  return any ? out : null;
}

async function synthesize(input, { llm = defaultLlm } = {}) {
  const user = [
    `CLIENT (the company hosting the meeting): ${input.clientName || '(unknown)'}`,
    input.callBrands && input.callBrands.length ? `CALL-LINE NAMES TO REPLACE WITH THE CLIENT NAME: ${input.callBrands.join(', ')}` : '',
    `MEETING: ${input.meetingText || '(time not available)'}`,
    `PROSPECT: ${JSON.stringify(input.prospect)}`,
    `CRM RECORD: ${JSON.stringify(input.crm)}`,
    // The campaign name stays out of the model's input on client sends, so it cannot leak into the brief.
    ...(input.withholdCampaign ? [] : [`CAMPAIGN: ${input.campaign || '(unknown)'}`]),
    '',
    'EMAIL THREAD (oldest first):',
    input.threadText || '(none)',
    '',
    'CALL NOTES:',
    input.callText || '(none)',
    '',
    'PUBLIC WEB RESULTS:',
    JSON.stringify(input.web.results),
    '',
    'COMPANY WEBSITE TEXT:',
    input.web.siteText || '(none)',
  ].filter((x) => x !== '').join('\n').slice(0, 24000);
  const raw = await withTimeout(llm({ system: SYSTEM, user }), 26000, 'brief llm');
  return normalizeSynthesis(parseJsonLoose(raw));
}

/** First upcoming event with this attendee on a client's connected Google calendar. */
async function findMeetingOnCalendar(clientIds, email, { db, google } = {}) {
  if (!clientIds.length || !email) return null;
  const { rows } = await db.query(
    `SELECT * FROM calendar_connections WHERE client_id = ANY($1::uuid[]) AND provider = 'google' ORDER BY updated_at DESC`,
    [clientIds],
  );
  for (const conn of rows) {
    const events = await google.findUpcomingEvents(conn, email, { days: 60 }).catch(() => []);
    const hit = events
      .filter((e) => (e.attendees || []).some((a) => String(a.email || '').toLowerCase() === email.toLowerCase()))
      .sort((a, b) => String((a.start || {}).dateTime || '').localeCompare(String((b.start || {}).dateTime || '')))[0];
    if (hit && hit.start && hit.start.dateTime) {
      const entry = ((hit.conferenceData || {}).entryPoints || []).find((p) => p.uri);
      return {
        start: hit.start.dateTime,
        end: (hit.end || {}).dateTime || null,
        where: str(hit.location, 200) || str(hit.hangoutLink, 300) || (entry ? str(entry.uri, 300) : ''),
      };
    }
  }
  return null;
}

/**
 * @param m parsed booking payload (see parseBookedMeetingPayload)
 * @param ctx { clients: [{id,name,smartlead_api_key}], linkedinUrl, highlights, swap(text) }
 * @returns the object buildBookedBrief renders
 */
async function gatherBrief(m, ctx, deps = {}) {
  const clientName = m.clientDisplay || m.client;
  const keys = [...new Set([
    ...(ctx.clients || []).map((c) => c.smartlead_api_key),
    deps.env ? deps.env.SMARTLEAD_API_KEY : process.env.SMARTLEAD_API_KEY,
    deps.env ? deps.env.SMARTLEAD_MASTER_API_KEY : process.env.SMARTLEAD_MASTER_API_KEY,
  ].filter(Boolean))];
  const swap = ctx.swap || ((x) => x);

  const sl = await loadSmartleadContext(m, keys, deps);
  const lead = sl.lead || {};
  const custom = lead.custom_fields && typeof lead.custom_fields === 'object' ? lead.custom_fields : {};
  const thread = sl.history ? threadFrom(sl.history, { clientName }) : [];
  const domain = domainOf(m.prospect.email);
  const company = str(m.prospect.company, 200) || str(lead.company_name, 200);
  const crmTitle = str(m.prospect.title, 160) || str(custom.job_title || custom.title, 160);
  const location = str(lead.location, 120);
  const website = str(lead.website || lead.company_url, 300);

  const [web, cal] = await Promise.all([
    company || domain ? researchCompany({ company, website, domain, location }, deps) : { site: '', results: [], siteText: '' },
    m.meetingAt ? null : safe('calendar lookup', () => withTimeout(
      findMeetingOnCalendar((ctx.clients || []).map((c) => c.id).filter(Boolean), m.prospect.email, { db: deps.db || require('../db'), google: deps.google || require('./google-calendar') }),
      9000, 'calendar'), null),
  ]);

  const startIso = m.meetingAt || (cal && cal.start) || '';
  const meetingText = startIso ? meetingLabel(startIso, cal && cal.end) : '';
  const threadText = thread.map((t) => `${t.when} ${t.direction === 'in' ? 'PROSPECT' : 'US'}: ${t.body}`).join('\n\n').slice(0, 9000);
  const callText = [m.summary, ctx.highlights ? JSON.stringify(ctx.highlights) : ''].filter(Boolean).join('\n').slice(0, 6000);

  const synth = await safe('brief synthesis', () => synthesize({
    clientName,
    callBrands: deps.callBrands || [],
    meetingText,
    prospect: { name: m.prospect.name, title: crmTitle, company, email: m.prospect.email, location },
    crm: { company_name: lead.company_name, job_title: custom.job_title, location: lead.location, unsubscribed: lead.is_unsubscribed === true, other_fields: Object.keys(custom).filter((k) => k !== 'job_title') },
    campaign: sl.campaignName || m.list,
    withholdCampaign: ctx.clientFacing === true,
    threadText,
    callText,
    web,
  }, deps));

  const out = (t) => (t ? swap(t) : t);
  const firstOut = thread.find((t) => t.direction === 'out');
  const channel = m.platform === 'allo' || m.alloCallId
    ? (thread.length ? 'Cold call, with an email thread' : 'Cold call')
    : [thread.length ? 'Cold email' : '', PLATFORM_LABEL[String(m.platform || '').toLowerCase()] ? `${PLATFORM_LABEL[String(m.platform).toLowerCase()]} booking page` : 'Booking page'].filter(Boolean).join(', then ');
  const watch = [...((synth && synth.watchOuts) || [])];
  if (lead.is_unsubscribed === true && !watch.some((w) => /unsubscrib/i.test(w))) {
    watch.push('The email record shows this person as unsubscribed. That is usually the automatic stop after a reply, but check it is not an opt-out.');
  }

  return {
    clientName,
    prospect: {
      name: m.prospect.name || [lead.first_name, lead.last_name].filter(Boolean).join(' '),
      company,
      title: (synth && synth.title) || crmTitle,
      email: m.prospect.email,
      phone: m.prospect.phone || str(lead.phone_number, 60),
      linkedinUrl: ctx.linkedinUrl || '',
      location,
    },
    titleNote: synth && synth.titleNote,
    when: {
      label: meetingText,
      fallback: m.platform === 'allo' || m.alloCallId ? 'Agreed on the call. See Next step in the call notes.' : 'See the calendar invite.',
      where: cal && cal.where,
      bookedLabel: m.bookedAt ? `${ctLabel(m.bookedAt)}${PLATFORM_LABEL[String(m.platform || '').toLowerCase()] ? ` on ${PLATFORM_LABEL[String(m.platform).toLowerCase()]}` : ''}` : '',
    },
    company: {
      website: web.site && /^https?:/i.test(web.site) ? web.site : (web.site ? `https://${web.site}` : ''),
      whatTheyDo: out(synth && synth.whatTheyDo),
      size: out(synth && synth.size),
      notes: ((synth && synth.notes) || []).map(out),
    },
    how: {
      client: clientName,
      channel,
      campaign: sl.campaignName || (m.platform === 'allo' || m.alloCallId ? '' : str(m.list, 200)),
      hook: out(synth && synth.hook),
      sender: firstOut && firstOut.mailbox ? firstOut.mailbox.replace(/^.*</, '').replace(/>.*$/, '') : '',
      timeline: timelineText(thread, m.bookedAt),
    },
    thread: thread.map((t) => ({ when: t.when, from: t.from, direction: t.direction, body: out(t.body) })),
    talkingPoints: ((synth && synth.talkingPoints) || []).map(out),
    watchOuts: watch.map(out),
    links: [
      ...(!ctx.clientFacing && sl.campaignId && sl.leadId ? [{ label: 'Email thread', url: `campaign ${sl.campaignId}, lead ${sl.leadId}` }] : []),
      ...(web.site ? [{ label: 'Company', url: /^https?:/i.test(web.site) ? web.site : `https://${web.site}` }] : []),
      ...(ctx.linkedinUrl ? [{ label: 'LinkedIn', url: ctx.linkedinUrl }] : []),
    ],
    meeting: { startIso, matched: Boolean(cal) },
    smartlead: { campaignId: sl.campaignId, leadId: sl.leadId, hadThread: thread.length > 0 },
  };
}

module.exports = {
  gatherBrief, loadSmartleadContext, threadFrom, stripQuoted, fetchSiteText, timelineText, meetingLabel, ctLabel,
  normalizeSynthesis, synthesize, researchCompany, findMeetingOnCalendar, domainOf, serperSearch, SYSTEM,
};
