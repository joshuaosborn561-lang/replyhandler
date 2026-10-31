'use strict';

/**
 * Day-of meeting brief for the client who is taking the meeting.
 *
 * About CLIENT_DAYOF_BRIEF_LEAD_MINUTES (default 120, two hours) before
 * meetings.confirmed_time the cron builds one brief and stores it as `held`.
 * It notifies REVIEW_NOTIFY (a webhook URL or an email) with the rendered brief
 * and release / enrich / block links. An email subject starts with
 * `[Client brief review]`, then the lead, company, and meeting time.
 * It does not email the client.
 *
 * The client email uses the same HTML shell as the briefs Josh gets from the
 * `send-brief` edge function (Client portal project scvrsmfzyvmmbnaolcrg):
 * Arial 14px, an h3 header, then bold section titles and bullets. That function
 * only mails prebuilt HTML to Josh through Resend. This path renders the brief
 * here and sends it with Gmail to the client's notify list. It does not call
 * send-brief, and it does not invent company or personal facts.
 *
 * The cron hold and the admin preview call the same gather. It reads the
 * stored reply, then fills gaps from the lookups already used on reply cards:
 * Smartlead thread and lead, person profile (LinkedIn, title, location), the
 * email waterfall (phone and LinkedIn), HeyReach when a LinkedIn URL is known,
 * Allo call history, and the company site. ICP is `resolveReplyIcp` (the same
 * Jev website check as a reply card) and the decision-maker line is the same
 * title check as the card. The email does not include a source-campaign
 * section. This job does not call Claude. A failed lookup leaves that fact out.
 *
 * POST /admin/client-briefs/:id/release is the only way a brief becomes
 * `released`. The client email goes out only then, and only when
 * CLIENT_DAYOF_BRIEF_ENABLED is on (default off). A blocked brief never sends.
 * A held brief never auto-sends. A brief with no source, no company info, no
 * past emails or calls, and no stated ask cannot be released or sent. A missing
 * LinkedIn URL is not that guard.
 *
 * To = clients.notify_emails. CC = Josh. This path is not a prospect reply and
 * does not CC anyone on a Smartlead or HeyReach send.
 */

const { notifyEmails, parseEmailList, formatEmailList } = require('./client-cc');
const { escapeHtml } = require('./client-notify-email');
const { fyiReplyTo } = require('../utils/fyi-notify');
const { extractThreadMessages } = require('../utils/thread-transcript');
const { stripQuoted } = require('./booked-brief-data');
const { cleanPhone } = require('../utils/lead-phone');

const JOSH_DEFAULT = 'joshua@salesglidergrowth.com';
const FLAG = 'CLIENT_DAYOF_BRIEF_ENABLED';
const LEAD_FLAG = 'CLIENT_DAYOF_BRIEF_LEAD_MINUTES';
const DEFAULT_LEAD_MINUTES = 120;
const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|aol|proton|protonmail)\./i;

function dayofBriefEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env[FLAG] || '').trim());
}

function leadMinutes(env = process.env) {
  const n = parseInt(env[LEAD_FLAG] || String(DEFAULT_LEAD_MINUTES), 10);
  return Number.isFinite(n) && n > 0 && n <= 24 * 60 ? n : DEFAULT_LEAD_MINUTES;
}

function joshEmail(env = process.env) {
  const v = String(env.BOOKED_MEETING_EMAIL_TO || '').trim().toLowerCase();
  return v.includes('@') ? v : JOSH_DEFAULT;
}

function str(v, max = 2000) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\r\n/g, '\n').trim().slice(0, max);
}

function oneLine(v, max = 400) {
  return str(v, max).replace(/\s+/g, ' ').trim();
}

function filled(v) {
  return oneLine(v, 8000).length > 0;
}

function parseObj(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

function asDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * confirmed_time is the meeting start when something scheduled it.
 * Rows inserted by the booking bridge stamp confirmed_time at insert
 * (the same instant as created_at). That is not a meeting time.
 */
function usableMeetingStart(meeting) {
  const start = asDate(meeting && meeting.confirmed_time);
  if (!start) return null;
  const created = asDate(meeting.created_at);
  if (created && Math.abs(start.getTime() - created.getTime()) < 2 * 60 * 1000) return null;
  return start;
}

/** True when `now` is inside the build window and the meeting has not started. */
function briefIsDue(start, now, minutes = DEFAULT_LEAD_MINUTES) {
  const s = asDate(start);
  const n = asDate(now);
  if (!s || !n) return false;
  const lead = Number(minutes) > 0 ? Number(minutes) : DEFAULT_LEAD_MINUTES;
  return n.getTime() >= s.getTime() - lead * 60 * 1000 && n.getTime() < s.getTime();
}

function appBase(env = process.env) {
  const explicit = String(env.PUBLIC_BASE_URL || env.APP_BASE_URL || '').trim().replace(/\/$/, '');
  if (explicit) return explicit;
  const domain = String(env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  return domain ? `https://${domain}` : '';
}

function briefLinks(id, env = process.env) {
  const base = appBase(env);
  const release = `${base}/admin/client-briefs/${id}/release`;
  return {
    release,
    enrich: release,
    block: `${base}/admin/client-briefs/${id}/block`,
    pending: `${base}/admin/client-briefs/pending`,
  };
}

function clientBriefRecipients(client, env = process.env) {
  const josh = joshEmail(env);
  const to = notifyEmails(client).filter((email) => email !== josh);
  const cc = [];
  if (josh && !to.includes(josh)) cc.push(josh);
  return { to, cc };
}

const TZ_SHORT = { CDT: 'CT', CST: 'CT', EDT: 'ET', EST: 'ET', PDT: 'PT', PST: 'PT', MDT: 'MT', MST: 'MT' };

function formatWhen(value, tz) {
  const d = asDate(value);
  if (!d) return '';
  const zone = tz || 'America/Chicago';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: 'h12',
      timeZoneName: 'short',
    }).formatToParts(d);
    const pick = (type) => (parts.find((p) => p.type === type) || {}).value || '';
    const hour = String(pick('hour')).replace(/^0/, '');
    const minute = pick('minute') || '00';
    const ap = pick('dayPeriod').replace(/\./g, '').toLowerCase();
    const zoneName = TZ_SHORT[pick('timeZoneName')] || (zone === 'America/Chicago' ? 'CT' : pick('timeZoneName'));
    const clock = `${hour}:${minute}${ap}${zoneName ? ` ${zoneName}` : ''}`;
    return `${pick('weekday')}, ${pick('month')} ${pick('day')}, ${clock}`.replace(/\s+/g, ' ').trim();
  } catch {
    return d.toISOString();
  }
}

function whereLabel(link) {
  const u = String(link || '');
  if (/zoom\.us/i.test(u)) return 'Zoom';
  if (/meet\.google|google\.com\/meet/i.test(u)) return 'Google Meet';
  if (/teams\.microsoft|teams\.live/i.test(u)) return 'Teams';
  return '';
}

function safeUrl(v) {
  const s = oneLine(v, 500);
  return /^https?:\/\//i.test(s) ? s : '';
}

function websiteFrom(row) {
  const raw = oneLine(row.lead_website, 300);
  if (raw) {
    if (/^https?:\/\//i.test(raw)) return raw;
    if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(raw) && !/\s/.test(raw)) return `https://${raw}`;
  }
  const domain = String(row.lead_email || '').toLowerCase().split('@')[1] || '';
  if (!domain || FREE_MAIL.test(domain) || !domain.includes('.')) return '';
  return `https://${domain}`;
}

function channelFor(row) {
  const platform = String(row.platform || '').toLowerCase();
  if (platform === 'heyreach') return 'LinkedIn';
  if (platform === 'smartlead') return 'Email';
  const provider = String(row.calendar_provider || '').toLowerCase();
  if (provider.includes('calendly')) return 'Calendly';
  if (provider.includes('tidycal')) return 'TidyCal';
  if (provider) return 'Booking page';
  return '';
}

function sourceFor(row, campaign, channel) {
  const bits = [];
  if (channel) bits.push(channel);
  if (campaign) bits.push(`campaign ${campaign}`);
  if (!bits.length && row.pending_reply_id) bits.push('Reply on an existing thread');
  return bits.join(', ');
}

function callNotesFrom(row) {
  const tc = parseObj(row.thread_context);
  if (!tc || Array.isArray(tc)) return '';
  const allo = tc.allo && typeof tc.allo === 'object' ? tc.allo : null;
  const raw = tc.call_summary || tc.callSummary || (allo && (allo.summary || allo.call_summary)) || '';
  return str(raw, 2000);
}

function threadMessages(row, platform) {
  const which = platform || (String(row.platform || 'smartlead').toLowerCase() === 'heyreach' ? 'heyreach' : 'smartlead');
  const extra = [];
  if (which !== 'heyreach' || String(row.platform || '').toLowerCase() === 'heyreach') {
    if (filled(row.sent_reply)) extra.push({ role: 'us', body: row.sent_reply, time: row.updated_at || '' });
    if (filled(row.inbound_message)) extra.push({ role: 'them', body: row.inbound_message, time: row.created_at || '' });
  }
  const context = which === 'heyreach' && String(row.platform || '').toLowerCase() !== 'heyreach'
    ? heyreachContext(row)
    : row.thread_context;
  return extractThreadMessages(which, context, { maxMessages: 8, extraMessages: extra, pinStart: true })
    .map((m) => ({ ...m, body: cutQuotedTail(m.body).slice(0, 1500) }))
    .filter((m) => filled(m.body));
}

function heyreachContext(row) {
  const tc = parseObj(row.thread_context);
  if (!tc || Array.isArray(tc)) return null;
  return tc.heyreach || null;
}

function messageLine(m, tz, prospectName) {
  const text = oneLine(m && m.body, 900);
  if (!text) return '';
  const who = m.role === 'us' ? 'Us' : (prospectName || 'Them');
  const when = formatWhen(m.time, tz);
  const head = [who, when].filter(Boolean).join(', ');
  return `${head}: ${text}`;
}

function ownReplyText(body) {
  return stripQuoted(String(body || ''))
    .replace(/sent from my iphone/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function asksFrom(messages) {
  const out = [];
  const push = (s) => {
    const line = oneLine(s, 400);
    if (!line || out.includes(line)) return;
    out.push(line);
  };
  for (const m of messages) {
    if (m.role !== 'them') continue;
    const own = ownReplyText(m.body);
    if (!own) continue;
    if (own.length <= 90) {
      if (/^(info|information)\b/i.test(own) || /\b\d{1,2}:\d{2}\s*[ap]m\b/i.test(own)) push(own);
    }
    const sentences = own.split(/(?<=[.?!])\s+/);
    for (const sentence of sentences) {
      const s = oneLine(sentence, 400);
      if (!s) continue;
      if (/\?/.test(s) || /\b(send|pricing|price|deck|one-pager|one pager|call me|schedule|times work|let me know)\b/i.test(s)) {
        push(s);
      }
      if (out.length >= 4) return out;
    }
  }
  return out;
}

function phoneFromLabeledText(text) {
  const m = String(text || '').match(/\b(?:tel|phone|mobile|cell|direct)\s*[:.]?\s*(\(?\+?\d[\d\s().-]{6,}\d)/i);
  return m ? cleanPhone(m[1]) : '';
}

/** Quoted tails survive as one line after HTML is flattened. Cut them here. */
function cutQuotedTail(text) {
  let t = stripQuoted(text);
  const wrote = t.match(/\bOn\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b[\s\S]{0,220}?wrote:/i);
  if (wrote && wrote.index > 15) t = t.slice(0, wrote.index);
  t = t.replace(/\s*sent from my iphone\s*/ig, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

function phoneFromBlob(text) {
  const labeled = phoneFromLabeledText(text);
  if (labeled) return labeled;
  const m = String(text || '').match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/);
  return m ? cleanPhone(m[0]) : '';
}

function officeCity(text) {
  const m = String(text || '').match(/\bOffice\s*:?\s*\d[^.\n]{0,90}?,\s*([A-Za-z .'-]+,\s*[A-Z]{2})\b/);
  return m ? oneLine(m[1], 80) : '';
}

function streetLine(text) {
  const m = String(text || '').match(/\b(\d{2,6}\s+[A-Za-z0-9.' ]{2,40}?,\s*[A-Za-z .'-]+,\s*[A-Z]{2})(?:\s+\d{5})?\b/);
  return m ? oneLine(m[1], 120) : '';
}

/** A sentence that is actually on the page. Lorem and nav chrome are dropped. */
function companyBlurb(siteText) {
  const text = String(siteText || '').replace(/\s+/g, ' ').trim();
  const parts = text.split(/(?<=[.?!])\s+/);
  const good = parts.map((s) => s.trim()).filter((s) => (
    s.length >= 40 && s.length <= 400 && !/lorem ipsum|view more|keyboard_arrow|\|/i.test(s)
  ));
  const preferred = good.find((s) => /ports of|container|works with/i.test(s))
    || good.find((s) => /drayage|warehous|logistics|we (are|handle|provide|offer)/i.test(s));
  const cleaned = String(preferred || '').replace(/^(?:about us|company|services|home)\s+/i, '');
  return oneLine(cleaned, 500);
}

function exampleHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'example.com' || host.endsWith('.example') || host.endsWith('.example.com') || host.endsWith('.invalid');
  } catch {
    return true;
  }
}

/** Reply-card words: "Fit — …", "Not a fit — …", "ICP: not on file", "ICP: check failed". */
function icpPlain(raw) {
  const v = parseObj(raw);
  if (!v || !v.status) return '';
  return require('./slack').icpFitPlain(v);
}

function noShowLine(priorNoShows, email, tz) {
  if (!email) return '';
  if (priorNoShows == null) return '';
  if (!priorNoShows.length) return 'No prior no-shows on file.';
  return priorNoShows.slice(0, 5).map((n) => {
    const when = formatWhen(n.meeting_start, tz) || 'an earlier date';
    const why = oneLine(n.reason, 80);
    return `No-show on ${when}${why ? ` (${why})` : ''}.`;
  }).join(' ');
}

function assembleBriefFacts(row, { priorNoShows = null } = {}) {
  const src = row || {};
  const tz = src.digest_timezone || 'America/Chicago';
  const name = oneLine(src.lead_full_name, 200) || oneLine(src.lead_name, 200);
  const companyName = oneLine(src.lead_company, 200);
  const campaign = oneLine(src.campaign_name, 200);
  const channel = channelFor(src);
  const linkedinOnly = String(src.platform || '').toLowerCase() === 'heyreach';
  const emailMsgs = linkedinOnly ? [] : threadMessages(src, 'smartlead');
  const dmMsgs = threadMessages(src, 'heyreach');
  const emailLines = emailMsgs.map((m) => messageLine(m, tz, name)).filter(Boolean);
  const dmLines = dmMsgs.map((m) => messageLine(m, tz, name)).filter(Boolean);
  const summaryBits = [];
  if (emailLines.length) summaryBits.push(`${emailLines.length} email message${emailLines.length === 1 ? '' : 's'}`);
  if (dmLines.length) summaryBits.push(`${dmLines.length} LinkedIn message${dmLines.length === 1 ? '' : 's'}`);
  const summary = summaryBits.join(', ');
  const quotes = [...emailMsgs, ...dmMsgs].filter((m) => m.role === 'them').slice(-3).map((m) => ({
    when: formatWhen(m.time, tz),
    who: name || 'Prospect',
    text: oneLine(m.body, 500),
  })).filter((q) => q.text);
  const callNotes = callNotesFrom(src);
  const openItems = asksFrom([...emailMsgs, ...dmMsgs]);
  const icp = parseObj(src.icp_verdict);
  const icpFit = icpPlain(icp);
  const storedDm = icp && (icp.decision_maker || icp.decisionMaker);
  const { judgeDecisionMaker, decisionMakerText } = require('./decision-maker');
  const decisionMaker = decisionMakerText(
    storedDm && storedDm.status ? storedDm : judgeDecisionMaker(oneLine(src.lead_title, 200), []),
  ) || '';
  const noShowHistory = noShowLine(priorNoShows, src.lead_email, tz);
  const risks = [];
  if (icp && icp.status === 'disqualified') risks.push(icpFit || 'Not a fit — does not fit the ICP');
  if (Array.isArray(priorNoShows) && priorNoShows.length) risks.push('They have a no-show on a previous meeting.');
  const joinUrl = safeUrl(src.meeting_link);
  const where = whereLabel(joinUrl);
  return {
    clientName: oneLine(src.client_name || src.name, 200),
    timezone: tz,
    whenLabel: formatWhen(src.confirmed_time, tz),
    where,
    joinUrl,
    prospect: {
      name,
      title: oneLine(src.lead_title, 200),
      linkedinUrl: safeUrl(src.linkedin_url || src.reply_linkedin),
      email: oneLine(src.lead_email, 320),
      phone: oneLine(src.lead_phone, 60),
      company: companyName,
      location: oneLine(src.lead_location, 160),
    },
    company: {
      name: companyName,
      whatTheyDo: '',
      size: '',
      website: websiteFrom(src),
    },
    how: {
      campaign,
      channel,
      source: sourceFor(src, campaign, channel),
    },
    history: { summary, quotes, callNotes, ask: '', emailLines, dmLines },
    openItems,
    flags: { icpFit, decisionMaker, risks, noShowHistory },
  };
}

function smartleadKey(env) {
  return String(env.SMARTLEAD_API_KEY || env.SMARTLEAD_MASTER_API_KEY || '').trim();
}

function heyreachKey(env) {
  return String(env.HEYREACH_API_KEY || '').trim();
}

function waterfallConfigured(env) {
  return Boolean(String(env.EMAIL_WATERFALL_URL || '').trim());
}

function profileLookupConfigured(env) {
  if (String(env.SERPER_API_KEY || env.SERPER_KEY || '').trim()) return true;
  try { return require('./aiark').isConfigured() === true; } catch { return false; }
}

function alloConfigured(env) {
  if (String(env.ALLO_API_KEY || '').trim()) return true;
  try { return require('./allo').isConfigured() === true; } catch { return false; }
}

async function safeLookup(step, fn) {
  try {
    return await fn();
  } catch (err) {
    console.warn('[DayofBrief] lookup skipped', { step, err: String(err && err.message || err).slice(0, 160) });
    return null;
  }
}

function liveDeps() {
  return {
    async getThreadHistory({ apiKey, campaignId, leadId }) {
      return require('./smartlead').getThreadHistory(apiKey, campaignId, leadId);
    },
    async lookupLeadByEmail({ apiKey, email }) {
      return require('./smartlead').lookupLeadByEmail(apiKey, email);
    },
    async lookupPersonProfile(input, opts) {
      return require('./person-profile-lookup').lookupPersonProfile(input, opts);
    },
    async enrichProspect(input) {
      return require('./prospect-enrich').enrichProspect(input);
    },
    async findConversation({ apiKey, linkedinUrl, leadName }) {
      return require('./heyreach').findConversation(apiKey, { linkedinUrl, leadName, allowNameSearch: false });
    },
    async searchCalls(phone) {
      return require('./allo').searchCalls(phone);
    },
    async fetchSiteText(url, opts) {
      return require('./booked-brief-data').fetchSiteText(url, opts);
    },
    async resolveReplyIcp(input) {
      return require('./reply-icp').resolveReplyIcp(input);
    },
    async loadClientPersonas(database, clientId) {
      return require('./decision-maker').loadClientPersonas(database, clientId);
    },
    judgeDecisionMaker(title, personas) {
      return require('./decision-maker').judgeDecisionMaker(title, personas);
    },
  };
}

function attachHistory(src, historyResponse) {
  const messages = historyResponse && (historyResponse.history || historyResponse.messages);
  if (!Array.isArray(messages) || !messages.length) return false;
  const prev = parseObj(src.thread_context);
  const base = prev && !Array.isArray(prev) ? { ...prev } : {};
  base.history = messages;
  src.thread_context = base;
  return true;
}

function heyreachTurns(conv) {
  if (!conv || typeof conv !== 'object') return [];
  const raw = Array.isArray(conv.messages) ? conv.messages : [];
  const mapped = raw.map((m) => {
    const sender = String(m.sender || m.role || m.direction || '').toLowerCase();
    const role = /^(us|me|sender|user|outbound)$/.test(sender) || sender === 'us' ? 'us' : 'them';
    return {
      role,
      body: m.body || m.text || m.message || '',
      time: m.createdAt || m.created_at || m.time || m.sentAt || '',
    };
  }).filter((m) => filled(m.body));
  if (mapped.length) return mapped;
  const text = oneLine(conv.lastMessageText || conv.lastMessage || conv.last_message || '', 1500);
  if (!text) return [];
  return [{ role: 'them', body: text, time: conv.lastMessageAt || conv.last_message_at || '' }];
}

function attachHeyreach(src, turns) {
  if (!turns.length) return;
  const prev = parseObj(src.thread_context);
  const base = prev && !Array.isArray(prev) ? { ...prev } : {};
  if (Array.isArray(prev)) base.history = prev;
  base.heyreach = { messages: turns };
  src.thread_context = base;
}

function prospectTexts(src) {
  return threadMessages(src, 'smartlead')
    .filter((m) => m.role === 'them')
    .map((m) => ownReplyText(m.body))
    .filter(Boolean);
}

/**
 * Same gather for the cron hold and the dry-run preview.
 * Reads the stored reply, then fills gaps from the lookups this repo already
 * uses. ICP is resolveReplyIcp (Jev, same as a reply card). The decision-maker
 * line uses the client's target titles. A failed lookup omits that fact.
 * It does not call Claude. It does not invent a title, size, or profile.
 */
async function gatherBriefFacts(row, {
  priorNoShows = null, env = process.env, fetchImpl = fetch, deps = null, db = null,
} = {}) {
  const src = { ...(row || {}) };
  const d = { ...liveDeps(), ...(deps || {}) };
  const injected = deps || {};
  const slKey = smartleadKey(env);

  if (!hasEmailBody(src) && filled(src.campaign_id) && filled(src.lead_id) && (injected.getThreadHistory || slKey)) {
    const history = await safeLookup('email thread', () => d.getThreadHistory({
      apiKey: slKey, campaignId: src.campaign_id, leadId: src.lead_id,
    }));
    if (history) attachHistory(src, history);
  }

  const missingContact = !filled(src.lead_phone) || !filled(src.linkedin_url) || !filled(src.reply_linkedin)
    || !filled(src.lead_website) || !filled(src.lead_location);
  if (missingContact && filled(src.lead_email) && (injected.lookupLeadByEmail || slKey)) {
    const found = await safeLookup('smartlead lead', () => d.lookupLeadByEmail({
      apiKey: slKey, email: src.lead_email,
    }));
    const lead = found && found.lead ? found.lead : null;
    if (lead) {
      if (!filled(src.lead_phone)) src.lead_phone = cleanPhone(lead.phone_number) || phoneFromLabeledText(JSON.stringify(lead.custom_fields || {}));
      if (!filled(src.linkedin_url) && !filled(src.reply_linkedin)) src.linkedin_url = oneLine(lead.linkedin_profile, 300);
      if (!filled(src.lead_website)) src.lead_website = oneLine(lead.website || lead.company_url, 300);
      if (!filled(src.lead_location)) src.lead_location = oneLine(lead.location, 160);
      if (!filled(src.lead_company)) src.lead_company = oneLine(lead.company_name, 200);
      const custom = lead.custom_fields && typeof lead.custom_fields === 'object' ? lead.custom_fields : {};
      if (!filled(src.lead_title)) src.lead_title = oneLine(custom.job_title || custom.title, 200);
    }
  }

  const needProfile = !filled(src.linkedin_url) && !filled(src.reply_linkedin)
    || !filled(src.lead_location) || !filled(src.lead_title);
  if (needProfile && (injected.lookupPersonProfile || profileLookupConfigured(env))) {
    const profile = await safeLookup('person profile', () => d.lookupPersonProfile({
      email: src.lead_email,
      leadName: src.lead_full_name || src.lead_name,
      companyName: src.lead_company,
      linkedinUrl: src.linkedin_url || src.reply_linkedin,
      location: src.lead_location,
      title: src.lead_title,
    }, { fetchImpl, env }));
    if (profile) {
      if (!filled(src.linkedin_url) && !filled(src.reply_linkedin) && profile.linkedinUrl) src.linkedin_url = profile.linkedinUrl;
      if (!filled(src.lead_location) && profile.location) src.lead_location = oneLine(profile.location, 160);
      if (!filled(src.lead_title) && profile.title) src.lead_title = oneLine(profile.title, 200);
      if (!filled(src.lead_full_name) && profile.fullName) src.lead_full_name = oneLine(profile.fullName, 200);
    }
  }

  const needPhone = !filled(src.lead_phone);
  const needLinkedin = !filled(src.linkedin_url) && !filled(src.reply_linkedin);
  if ((needPhone || needLinkedin) && filled(src.lead_email) && (injected.enrichProspect || waterfallConfigured(env))) {
    const hit = await safeLookup('enrichment', () => d.enrichProspect({
      email: src.lead_email,
      leadName: src.lead_full_name || src.lead_name,
      companyName: src.lead_company,
      linkedinUrl: src.linkedin_url || src.reply_linkedin,
      phone: src.lead_phone,
      domain: String(src.lead_email || '').split('@')[1] || '',
      clientTag: oneLine(src.client_name, 40).toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'client',
      need: needPhone ? 'both' : 'email',
      approveCostUsd: 0.25,
    }));
    if (hit) {
      if (!filled(src.lead_phone) && hit.phone) src.lead_phone = cleanPhone(hit.phone) || oneLine(hit.phone, 60);
      if (needLinkedin && hit.linkedinUrl) src.linkedin_url = hit.linkedinUrl;
    }
  }

  const linkedinNow = src.linkedin_url || src.reply_linkedin;
  let linkedinLooked = false;
  if (!threadMessages(src, 'heyreach').length && filled(linkedinNow) && (injected.findConversation || heyreachKey(env))) {
    const conv = await safeLookup('linkedin', async () => {
      const found = await d.findConversation({
        apiKey: heyreachKey(env),
        linkedinUrl: linkedinNow,
        leadName: src.lead_full_name || src.lead_name,
      });
      linkedinLooked = true;
      return found;
    });
    const turns = heyreachTurns(conv);
    if (turns.length) attachHeyreach(src, turns);
    const profileUrl = conv && conv.correspondentProfile && conv.correspondentProfile.profileUrl;
    if (!filled(src.linkedin_url) && !filled(src.reply_linkedin) && profileUrl) src.linkedin_url = oneLine(profileUrl, 300);
  }

  const texts = prospectTexts(src);
  if (!filled(src.lead_phone)) {
    for (const text of texts) {
      const phone = phoneFromLabeledText(text);
      if (phone) { src.lead_phone = phone; break; }
    }
  }
  if (!filled(src.lead_location)) {
    for (const text of texts) {
      const city = officeCity(text);
      if (city) { src.lead_location = city; break; }
    }
  }

  let callsLooked = false;
  let callLines = [];
  if (filled(src.lead_phone) && !filled(callNotesFrom(src)) && (injected.searchCalls || alloConfigured(env))) {
    const calls = await safeLookup('calls', async () => {
      const found = await d.searchCalls(src.lead_phone);
      callsLooked = true;
      return found;
    });
    if (Array.isArray(calls)) {
      callLines = calls.slice(0, 4).map((call) => {
        const when = formatWhen(call.start_date || call.started_at || call.created_at, src.digest_timezone || 'America/Chicago');
        const summary = oneLine(call.summary || '', 500);
        return [when, summary].filter(Boolean).join(': ');
      }).filter(Boolean);
    }
  }

  const facts = assembleBriefFacts(src, { priorNoShows });
  await attachCardIcp(src, facts, { db, fetchImpl, deps: d, injected });
  if (callLines.length) {
    facts.history.callLines = callLines;
    facts.history.callNotes = facts.history.callNotes || callLines.join(' ');
  } else if (callsLooked && !filled(facts.history.callNotes)) {
    facts.history.callNotes = 'No calls on file.';
  }
  if (linkedinLooked && !(facts.history.dmLines || []).length) {
    facts.history.dmLines = ['No LinkedIn messages on file.'];
  }

  const site = facts.company && facts.company.website;
  let siteText = '';
  if (site && !filled(facts.company.whatTheyDo) && (injected.fetchSiteText || !exampleHost(site))) {
    siteText = await safeLookup('company site', () => d.fetchSiteText(site, { fetchImpl })) || '';
    const blurb = companyBlurb(siteText);
    if (blurb) facts.company.whatTheyDo = blurb;
    if (!filled(facts.prospect.phone)) {
      const sitePhone = phoneFromBlob(siteText);
      if (sitePhone) facts.prospect.phone = sitePhone;
    }
  }

  const fromEmail = streetLine(texts.join('\n'));
  const fromSite = streetLine(siteText);
  if (fromEmail && fromSite && fromEmail.toLowerCase() !== fromSite.toLowerCase()) {
    facts.flags.risks = facts.flags.risks || [];
    facts.flags.risks.push(`Email signature lists ${fromEmail}. The company site lists ${fromSite}.`);
  }
  return facts;
}

/**
 * ICP and decision maker, same as a reply card. Example hosts stay offline
 * unless the caller injects resolveReplyIcp (tests). A real site always
 * goes through resolveReplyIcp, which calls Jev on a cache miss.
 */
async function attachCardIcp(src, facts, { db, fetchImpl, deps, injected }) {
  const website = (facts.company && facts.company.website) || '';
  const callLive = Boolean(injected.resolveReplyIcp) || (website && !exampleHost(website));
  let verdict = parseObj(src.icp_verdict);
  if (callLive) {
    const resolved = await safeLookup('icp', () => (injected.resolveReplyIcp || deps.resolveReplyIcp)({
      website,
      clientName: src.client_name || src.name || facts.clientName,
      clientId: src.client_id,
      replyId: src.pending_reply_id,
      db: db || null,
      grade: true,
      fetchImpl,
    }));
    if (resolved && resolved.status) verdict = resolved;
    else if (!verdict || !verdict.status) verdict = { status: 'unknown', reason: 'check failed' };
  }
  facts.flags.icpFit = icpPlain(verdict) || require('./slack').icpFitPlain(verdict);
  const loaded = await safeLookup('decision maker', () => (
    (injected.loadClientPersonas || deps.loadClientPersonas)(db, src.client_id)
  ));
  const personas = Array.isArray(loaded) ? loaded : [];
  const title = (facts.prospect && facts.prospect.title) || '';
  const judge = injected.judgeDecisionMaker || deps.judgeDecisionMaker;
  const dm = judge(title, personas);
  const line = require('./decision-maker').decisionMakerText(dm);
  if (line) facts.flags.decisionMaker = line;
  facts.flags.risks = (facts.flags.risks || []).filter((r) => !/^(Fit —|Not a fit —|ICP:|ICP fit:)/.test(String(r)));
  if (verdict && verdict.status === 'disqualified' && facts.flags.icpFit) {
    facts.flags.risks.push(facts.flags.icpFit);
  }
}

function hasEmailBody(row) {
  if (filled(row.inbound_message) || filled(row.sent_reply)) return true;
  const tc = parseObj(row.thread_context);
  if (!tc) return false;
  if (Array.isArray(tc) && tc.length) return true;
  return (Array.isArray(tc.history) && tc.history.length > 0)
    || (Array.isArray(tc.messages) && tc.messages.length > 0);
}

function contextPresence(facts) {
  const src = typeof facts === 'string' ? (parseObj(facts) || {}) : (facts || {});
  facts = src;
  const how = facts.how || {};
  const company = facts.company || {};
  const prospect = facts.prospect || {};
  const history = facts.history || {};
  const quotes = Array.isArray(history.quotes) ? history.quotes.filter((q) => filled(q && (q.text || q))) : [];
  const open = Array.isArray(facts.openItems) ? facts.openItems.filter((item) => filled(item)) : [];
  return {
    source: filled(how.campaign) || filled(how.channel) || filled(how.source),
    company: filled(company.whatTheyDo) || filled(company.size) || filled(company.website) || filled(company.name) || filled(prospect.company),
    history: filled(history.summary) || filled(history.callNotes) || quotes.length > 0
      || (Array.isArray(history.emailLines) && history.emailLines.some((line) => filled(line)))
      || (Array.isArray(history.dmLines) && history.dmLines.some((line) => filled(line))),
    ask: open.length > 0 || filled(history.ask),
  };
}

/** True when source, company, history, and the ask are all missing. LinkedIn is not part of this. */
function hasZeroContext(facts) {
  const p = contextPresence(facts);
  return !p.source && !p.company && !p.history && !p.ask;
}

function asFacts(v) {
  if (!v) return {};
  if (typeof v === 'string') return parseObj(v) || {};
  return typeof v === 'object' ? v : {};
}

function mergeFacts(base, edits) {
  const src = asFacts(base);
  const patch = edits && typeof edits === 'object' && !Array.isArray(edits) ? edits : {};
  const out = JSON.parse(JSON.stringify(src));
  const take = (key, fields) => {
    if (!patch[key] || typeof patch[key] !== 'object' || Array.isArray(patch[key])) return;
    out[key] = out[key] && typeof out[key] === 'object' && !Array.isArray(out[key]) ? out[key] : {};
    for (const field of fields) {
      if (patch[key][field] !== undefined && patch[key][field] !== null && filled(patch[key][field])) {
        out[key][field] = str(patch[key][field], 4000);
      }
    }
  };
  take('prospect', ['name', 'title', 'linkedinUrl', 'email', 'phone', 'company', 'location']);
  take('company', ['name', 'whatTheyDo', 'size', 'website']);
  take('how', ['campaign', 'channel', 'source']);
  take('history', ['summary', 'callNotes', 'ask']);
  take('flags', ['icpFit', 'decisionMaker', 'noShowHistory']);
  if (Array.isArray(patch.openItems)) {
    out.openItems = patch.openItems.map((item) => oneLine(item, 600)).filter(Boolean).slice(0, 8);
  }
  if (patch.history && Array.isArray(patch.history.quotes)) {
    out.history = out.history && typeof out.history === 'object' ? out.history : {};
    out.history.quotes = patch.history.quotes.slice(0, 6).map((q) => {
      if (typeof q === 'string') return { when: '', who: '', text: oneLine(q, 600) };
      return {
        when: oneLine(q && q.when, 80),
        who: oneLine(q && q.who, 120),
        text: oneLine(q && q.text, 600),
      };
    }).filter((q) => q.text);
  }
  if (patch.flags && Array.isArray(patch.flags.risks)) {
    out.flags = out.flags && typeof out.flags === 'object' ? out.flags : {};
    out.flags.risks = patch.flags.risks.map((item) => oneLine(item, 400)).filter(Boolean).slice(0, 8);
  }
  if (filled(patch.clientName)) out.clientName = oneLine(patch.clientName, 200);
  if (filled(patch.whenLabel)) out.whenLabel = oneLine(patch.whenLabel, 200);
  if (patch.where !== undefined && filled(patch.where)) out.where = oneLine(patch.where, 200);
  if (patch.joinUrl !== undefined) out.joinUrl = safeUrl(patch.joinUrl);
  if (out.prospect && out.prospect.linkedinUrl) out.prospect.linkedinUrl = safeUrl(out.prospect.linkedinUrl);
  if (out.company && out.company.website && !/^https?:\/\//i.test(out.company.website)) {
    const site = oneLine(out.company.website, 300);
    out.company.website = /^[a-z0-9.-]+\.[a-z]{2,}/i.test(site) ? `https://${site}` : safeUrl(site);
  }
  return out;
}

function bulletList(items) {
  return (items || []).map((item) => oneLine(item, 800)).filter(Boolean);
}

function quoteLines(hist) {
  const lines = [];
  for (const q of hist.quotes || []) {
    const text = oneLine(q && (q.text || q), 600);
    if (!text) continue;
    const whoSaid = [oneLine(q.who, 120), oneLine(q.when, 80)].filter(Boolean).join(', ');
    lines.push(whoSaid ? `${whoSaid}: ${text}` : text);
  }
  return lines;
}

function sectionBullets(facts) {
  const p = facts.prospect || {};
  const c = facts.company || {};
  const hist = facts.history || {};
  const flags = facts.flags || {};
  const who = [];
  const person = [p.name, p.title, c.name || p.company].filter(filled).join(', ');
  if (person) who.push(person);
  const reach = [p.email, p.phone].filter(filled).join(' | ');
  if (reach) who.push(reach);
  const place = [p.location, filled(p.linkedinUrl) ? `LinkedIn: ${p.linkedinUrl}` : ''].filter(filled).join('. ');
  if (place) who.push(place);

  const icp = [];
  if (filled(flags.icpFit)) icp.push(flags.icpFit);
  if (filled(flags.decisionMaker)) icp.push(flags.decisionMaker);
  const linkedin = Array.isArray(hist.dmLines) ? bulletList(hist.dmLines) : [];
  const email = Array.isArray(hist.emailLines) ? bulletList(hist.emailLines) : quoteLines(hist);
  const calls = [];
  if (filled(hist.callNotes)) calls.push(oneLine(hist.callNotes, 2000));
  for (const line of bulletList(hist.callLines)) calls.push(line);

  const company = [];
  if (filled(c.website)) company.push(c.website);
  if (filled(c.whatTheyDo)) company.push(c.whatTheyDo);
  if (filled(c.size)) company.push(c.size);
  const companyTitle = filled(c.name || p.company) ? `About ${oneLine(c.name || p.company, 200)}` : 'Company';

  const open = bulletList(facts.openItems);
  if (filled(hist.ask) && !open.includes(oneLine(hist.ask, 600))) open.push(oneLine(hist.ask, 600));

  const flagLines = [];
  for (const risk of flags.risks || []) if (filled(risk)) flagLines.push(risk);
  if (filled(flags.noShowHistory)) flagLines.push(flags.noShowHistory);

  return { who, icp, linkedin, email, calls, company, companyTitle, open, flagLines };
}

function headerLine(facts) {
  const p = facts.prospect || {};
  const name = oneLine(p.name, 200) || 'Prospect';
  const company = oneLine((facts.company || {}).name || p.company, 200);
  const who = company ? `${name}, ${company}` : name;
  const when = oneLine(facts.whenLabel, 200);
  const where = oneLine(facts.where, 80);
  const tail = [when, where ? `(${where})` : ''].filter(Boolean).join(' ');
  return tail ? `${who} | ${tail}` : who;
}

/**
 * Josh's pre-meeting brief shape: a header line, then short titled bullet lists.
 * A section with nothing to say is left out.
 */
function buildClientDayofBrief(facts = {}) {
  const p = facts.prospect || {};
  const name = oneLine(p.name, 200) || 'Prospect';
  const whenShort = oneLine(facts.whenLabel, 80);
  const timeOnly = whenShort.match(/\d{1,2}:\d{2}\s*[AP]M(?:\s+[A-Z]{2,5})?/i);
  const subjectWhen = timeOnly ? timeOnly[0] : whenShort;
  const subject = subjectWhen ? `Brief: ${name} @ ${subjectWhen}` : `Brief: ${name}`;
  const header = headerLine(facts);
  const sections = sectionBullets(facts);
  const blocks = [
    ['Who', sections.who],
    ['ICP fit', sections.icp],
    ['LinkedIn', sections.linkedin],
    ['Email thread', sections.email],
    ['Call history', sections.calls],
    [sections.companyTitle, sections.company],
    ['Open items', sections.open],
    ['Flags', sections.flagLines],
  ].filter(([, items]) => items.length);

  const join = safeUrl(facts.joinUrl);
  const text = [header];
  if (join) text.push(`Join: ${join}`);
  text.push('');
  for (const [title, items] of blocks) {
    text.push(title);
    for (const item of items) text.push(`- ${item}`);
    text.push('');
  }
  const textBody = text.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  const ul = (items) => `<ul>${items.map((item) => {
    const raw = String(item);
    const url = raw.match(/https?:\/\/[^\s<>"]+/);
    let html = escapeHtml(raw);
    if (url) html = html.replace(escapeHtml(url[0]), `<a href="${escapeHtml(url[0])}">${escapeHtml(url[0])}</a>`);
    return `<li>${html}</li>`;
  }).join('')}</ul>`;

  const html = [
    `<div style='font-family:Arial,sans-serif;font-size:14px'>`,
    `<h3>${escapeHtml(header)}</h3>`,
    join ? `<p>Join: <a href="${escapeHtml(join)}">${escapeHtml(join)}</a></p>` : '',
    ...blocks.map(([title, items]) => `<p><b>${escapeHtml(title)}</b></p>${ul(items)}`),
    `</div>`,
  ].filter(Boolean).join('');

  return { subject, htmlBody: html, textBody };
}

const EXAMPLE_BRIEF_FACTS = {
  clientName: 'Example Industrial',
  timezone: 'America/Chicago',
  whenLabel: 'Thu, Oct 31, 9:30am CT',
  where: 'Zoom',
  joinUrl: 'https://us06web.zoom.us/j/00000000000',
  prospect: {
    name: 'Jordan Hale',
    title: 'VP of Operations',
    linkedinUrl: 'https://www.linkedin.com/in/jordan-hale-example',
    email: 'jordan.hale@northwind-roofing.example',
    phone: '(214) 555-0148',
    company: 'Northwind Roofing Co.',
    location: 'Rockwall, TX',
  },
  company: {
    name: 'Northwind Roofing Co.',
    whatTheyDo: 'Commercial and storm-restoration roofing for property managers and general contractors across north Texas. The sample says family-owned and in business since 2004. This figure is example copy, not a live lookup.',
    size: 'About 40 employees (example figure a reviewer would type; not from a live source).',
    website: 'https://northwind-roofing.example',
  },
  how: {
    campaign: 'Spring owners, north Texas',
    channel: 'Email',
    source: 'Cold email, then they booked the intro page',
  },
  history: {
    summary: 'Two emails from us, one reply from them. They answered the same day.',
    quotes: [{
      when: 'Oct 28, 2:14 PM',
      who: 'Jordan Hale',
      text: 'Thursday works. Can you walk us through pricing and what you need from us before the call?',
    }],
    callNotes: 'No call yet. This is the first conversation.',
    ask: '',
    emailLines: [
      'Us, Oct 26, 1:26pm CT: Two times are open on our side this week.',
      'Jordan Hale, Oct 28, 2:14pm CT: Thursday works. Can you walk us through pricing and what you need from us before the call?',
    ],
    dmLines: [
      'Jordan Hale, Oct 25: Saw the note and asked if Thursday still works.',
    ],
  },
  openItems: [
    'Wants pricing walked through on the call',
    'Asked what they should send ahead of Thursday',
  ],
  flags: {
    icpFit: 'Fit — commercial roofer, operations lead',
    decisionMaker: 'Decision maker: Yes, matches ICP buyer (Owner) (VP of Operations)',
    risks: ['First meeting. No prior thread beyond the booking reply.'],
    noShowHistory: 'No prior no-shows on file.',
  },
};

function exampleClientBrief() {
  return { facts: EXAMPLE_BRIEF_FACTS, ...buildClientDayofBrief(EXAMPLE_BRIEF_FACTS) };
}

const REVIEW_SUBJECT_TAG = '[Client brief review]';

function reviewTarget(env = process.env) {
  return String(env.REVIEW_NOTIFY || '').trim();
}

/** Email subjects start with the fixed tag, then lead, company, and meeting time. */
function reviewEmailSubject(brief = {}) {
  const facts = asFacts(brief.facts);
  const p = facts.prospect || {};
  const lead = oneLine(p.name, 200);
  const company = oneLine((facts.company || {}).name || p.company, 200);
  const whenShort = oneLine(facts.whenLabel, 120);
  const timeOnly = whenShort.match(/\d{1,2}:\d{2}\s*[AP]M(?:\s+[A-Z]{2,5})?/i);
  const when = timeOnly ? timeOnly[0].replace(/\s+/g, ' ') : whenShort;
  const who = [lead, company].filter(Boolean).join(', ');
  const detail = who && when ? `${who} @ ${when}` : (who || when);
  return detail ? `${REVIEW_SUBJECT_TAG} ${detail}` : REVIEW_SUBJECT_TAG;
}

function reviewNotice(brief, links) {
  const zero = hasZeroContext(brief.facts);
  const lines = [
    'HELD FOR REVIEW. This brief has not been sent to the client.',
    'Unreviewed briefs never send. Release sends it. Block drops it.',
    'Enrich by POSTing JSON fields (company, how, history, openItems, flags) to the release link. It releases only when the brief has context.',
    zero ? 'ZERO CONTEXT. Release will be refused until source, company, history, or an ask is added. Missing LinkedIn alone is fine.' : '',
    `Release: ${links.release}`,
    `Enrich: ${links.enrich}`,
    `Block: ${links.block}`,
    `Pending: ${links.pending}`,
    '',
    brief.text_body || brief.textBody || '',
  ].filter((line) => line !== '');
  const textBody = lines.join('\n');
  const htmlBody = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111;line-height:1.45">`
    + `<p><b>HELD FOR REVIEW.</b> This brief has not been sent to the client.</p>`
    + `<ul>`
    + `<li>Release: <a href="${escapeHtml(links.release)}">${escapeHtml(links.release)}</a></li>`
    + `<li>Enrich (POST fields to the release link): <a href="${escapeHtml(links.enrich)}">${escapeHtml(links.enrich)}</a></li>`
    + `<li>Block: <a href="${escapeHtml(links.block)}">${escapeHtml(links.block)}</a></li>`
    + `<li>Pending: <a href="${escapeHtml(links.pending)}">${escapeHtml(links.pending)}</a></li>`
    + `</ul>`
    + (zero ? `<p><b>Zero context.</b> Release will be refused until source, company, history, or an ask is added.</p>` : '')
    + `<hr>`
    + (brief.html_body || brief.htmlBody || `<pre>${escapeHtml(brief.text_body || '')}</pre>`)
    + `</div>`;
  return { textBody, htmlBody };
}

async function notifyReviewer(brief, { env = process.env, fetchImpl = fetch, send } = {}) {
  const target = reviewTarget(env);
  const links = briefLinks(brief.id, env);
  if (!target) return { ok: false, skipped: 'no_target' };
  const notice = reviewNotice(brief, links);
  const payload = {
    event: 'client_dayof_brief_held',
    id: brief.id,
    meeting_id: brief.meeting_id,
    client: (brief.facts && brief.facts.clientName) || brief.client_name || '',
    meeting_starts_at: brief.meeting_starts_at || null,
    subject: brief.subject,
    text: brief.text_body,
    html: brief.html_body,
    zero_context: hasZeroContext(brief.facts),
    links,
  };
  if (/^https?:\/\//i.test(target)) {
    const res = await fetchImpl(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`review webhook ${res.status}`);
    return { ok: true, via: 'webhook' };
  }
  if (target.includes('@')) {
    if (typeof send !== 'function') throw new Error('review email sender missing');
    await send({
      to: parseEmailList(target),
      cc: [],
      replyTo: fyiReplyTo(env),
      subject: reviewEmailSubject(brief),
      htmlBody: notice.htmlBody,
      textBody: notice.textBody,
    });
    return { ok: true, via: 'email' };
  }
  return { ok: false, skipped: 'bad_target' };
}

function sqlStore(db) {
  const q = (sql, params) => db.query(sql, params);
  return {
    db,
    async dueMeetings(now, minutes) {
      const { rows } = await q(
        `SELECT m.id, m.client_id, m.pending_reply_id, m.lead_name, m.lead_email, m.linkedin_url,
                m.confirmed_time, m.created_at, m.meeting_link, m.calendar_provider, m.status,
                c.name AS client_name, c.notify_emails, c.digest_timezone,
                pr.platform, pr.campaign_id, pr.campaign_name, pr.lead_title, pr.lead_company,
                pr.lead_id, pr.lead_phone, pr.lead_website, pr.lead_full_name, pr.lead_location,
                pr.linkedin_url AS reply_linkedin, pr.inbound_message, pr.sent_reply,
                pr.thread_context, pr.classification, pr.icp_verdict, pr.updated_at
           FROM meetings m
           JOIN clients c ON c.id = m.client_id
           LEFT JOIN pending_replies pr ON pr.id = m.pending_reply_id
          WHERE m.status IN ('booked', 'confirmed')
            AND c.active IS DISTINCT FROM false
            AND m.confirmed_time IS NOT NULL
            AND m.confirmed_time > $1::timestamptz
            AND m.confirmed_time <= $1::timestamptz + ($2::int * interval '1 minute')
            AND NOT EXISTS (SELECT 1 FROM client_dayof_briefs b WHERE b.meeting_id = m.id)`,
        [now, minutes],
      );
      return rows;
    },
    async priorNoShows(clientId, email, before) {
      if (!clientId || !email) return [];
      const { rows } = await q(
        `SELECT meeting_start, reason
           FROM ghosted_meeting_checks
          WHERE client_id = $1
            AND decision = 'ghosted'
            AND lower(lead_email) = lower($2)
            AND meeting_start < $3::timestamptz
          ORDER BY meeting_start DESC
          LIMIT 5`,
        [clientId, email, before],
      );
      return rows;
    },
    async insertHeld(row) {
      const { rows } = await q(
        `INSERT INTO client_dayof_briefs
           (meeting_id, client_id, status, subject, html_body, text_body, facts,
            to_emails, cc_emails, meeting_starts_at)
         VALUES ($1, $2, 'held', $3, $4, $5, $6::jsonb, $7, $8, $9)
         ON CONFLICT (meeting_id) DO NOTHING
         RETURNING *`,
        [
          row.meeting_id, row.client_id, row.subject, row.html_body, row.text_body,
          JSON.stringify(row.facts || {}), row.to_emails, row.cc_emails, row.meeting_starts_at,
        ],
      );
      return rows[0] || null;
    },
    async listUnnotified() {
      const { rows } = await q(
        `SELECT b.*, c.name AS client_name, c.notify_emails
           FROM client_dayof_briefs b
           JOIN clients c ON c.id = b.client_id
          WHERE b.status = 'held' AND b.reviewer_notified_at IS NULL
          ORDER BY b.held_at ASC
          LIMIT 50`,
      );
      return rows;
    },
    async markNotified(id, err) {
      await q(
        `UPDATE client_dayof_briefs
            SET reviewer_notified_at = CASE WHEN $2::text IS NULL THEN now() ELSE reviewer_notified_at END,
                reviewer_notify_error = $2,
                updated_at = now()
          WHERE id = $1 AND status = 'held'`,
        [id, err],
      );
    },
    async listUnsentReleased(now) {
      const { rows } = await q(
        `SELECT b.*, c.name AS client_name, c.notify_emails
           FROM client_dayof_briefs b
           JOIN clients c ON c.id = b.client_id
          WHERE b.status = 'released'
            AND b.sent_at IS NULL
            AND b.send_error IS DISTINCT FROM 'meeting_passed'
            AND (
              b.send_error IS DISTINCT FROM 'sending'
              OR b.updated_at < $1::timestamptz - interval '2 minutes'
            )
            AND (b.meeting_starts_at IS NULL OR b.meeting_starts_at > $1::timestamptz - interval '2 hours')`,
        [now],
      );
      return rows;
    },
    async giveUpPast(now) {
      await q(
        `UPDATE client_dayof_briefs
            SET send_error = 'meeting_passed', updated_at = now()
          WHERE status = 'released'
            AND sent_at IS NULL
            AND send_error IS DISTINCT FROM 'meeting_passed'
            AND meeting_starts_at IS NOT NULL
            AND meeting_starts_at <= $1::timestamptz - interval '2 hours'`,
        [now],
      );
    },
    async claimSend(id) {
      const { rows } = await q(
        `UPDATE client_dayof_briefs
            SET send_error = 'sending', updated_at = now()
          WHERE id = $1
            AND status = 'released'
            AND sent_at IS NULL
            AND send_error IS DISTINCT FROM 'meeting_passed'
            AND (send_error IS DISTINCT FROM 'sending' OR updated_at < now() - interval '2 minutes')
          RETURNING *`,
        [id],
      );
      return rows[0] || null;
    },
    async markSent(id) {
      await q(
        `UPDATE client_dayof_briefs
            SET sent_at = now(), send_error = NULL, updated_at = now()
          WHERE id = $1 AND status = 'released'`,
        [id],
      );
    },
    async markSendError(id, err) {
      await q(
        `UPDATE client_dayof_briefs
            SET send_error = $2, updated_at = now()
          WHERE id = $1 AND sent_at IS NULL`,
        [id, str(err, 300)],
      );
    },
    async getBrief(id) {
      const { rows } = await q(
        `SELECT b.*, c.name AS client_name, c.notify_emails, c.digest_timezone
           FROM client_dayof_briefs b
           JOIN clients c ON c.id = b.client_id
          WHERE b.id = $1`,
        [id],
      );
      return rows[0] || null;
    },
    async saveFacts(id, facts, rendered) {
      const { rows } = await q(
        `UPDATE client_dayof_briefs
            SET facts = $2::jsonb, subject = $3, html_body = $4, text_body = $5, updated_at = now()
          WHERE id = $1 AND status = 'held'
          RETURNING *`,
        [id, JSON.stringify(facts || {}), rendered.subject, rendered.htmlBody, rendered.textBody],
      );
      return rows[0] || null;
    },
    async markReleased(id, facts, rendered, recipients) {
      const { rows } = await q(
        `UPDATE client_dayof_briefs
            SET status = 'released',
                facts = $2::jsonb,
                subject = $3,
                html_body = $4,
                text_body = $5,
                to_emails = $6,
                cc_emails = $7,
                released_at = COALESCE(released_at, now()),
                send_error = NULL,
                updated_at = now()
          WHERE id = $1 AND status IN ('held', 'released') AND sent_at IS NULL
          RETURNING *`,
        [
          id, JSON.stringify(facts || {}), rendered.subject, rendered.htmlBody, rendered.textBody,
          formatEmailList(recipients.to), formatEmailList(recipients.cc),
        ],
      );
      return rows[0] || null;
    },
    async markBlocked(id) {
      const { rows } = await q(
        `UPDATE client_dayof_briefs
            SET status = 'blocked', blocked_at = now(), updated_at = now()
          WHERE id = $1 AND sent_at IS NULL AND status <> 'blocked'
          RETURNING *`,
        [id],
      );
      return rows[0] || null;
    },
    async listPending() {
      const { rows } = await q(
        `SELECT b.id, b.meeting_id, b.client_id, b.status, b.subject, b.text_body, b.html_body,
                b.facts, b.meeting_starts_at, b.held_at, b.reviewer_notified_at, c.name AS client_name
           FROM client_dayof_briefs b
           JOIN clients c ON c.id = b.client_id
          WHERE b.status = 'held'
          ORDER BY b.meeting_starts_at ASC NULLS LAST
          LIMIT 100`,
      );
      return rows;
    },
    async loadMeeting(meetingId) {
      const { rows } = await q(
        `SELECT m.id, m.client_id, m.pending_reply_id, m.lead_name, m.lead_email, m.linkedin_url,
                m.confirmed_time, m.created_at, m.meeting_link, m.calendar_provider, m.status,
                c.name AS client_name, c.notify_emails, c.digest_timezone,
                pr.platform, pr.campaign_id, pr.campaign_name, pr.lead_title, pr.lead_company,
                pr.lead_id, pr.lead_phone, pr.lead_website, pr.lead_full_name, pr.lead_location,
                pr.linkedin_url AS reply_linkedin, pr.inbound_message, pr.sent_reply,
                pr.thread_context, pr.icp_verdict, pr.updated_at
           FROM meetings m
           JOIN clients c ON c.id = m.client_id
           LEFT JOIN pending_replies pr ON pr.id = m.pending_reply_id
          WHERE m.id = $1`,
        [meetingId],
      );
      return rows[0] || null;
    },
    async clientById(clientId) {
      const { rows } = await q(
        `SELECT id, name, notify_emails, digest_timezone FROM clients WHERE id = $1`,
        [clientId],
      );
      return rows[0] || null;
    },
  };
}

function presentPending(row, env) {
  return {
    id: row.id,
    meeting_id: row.meeting_id,
    client_id: row.client_id,
    client: row.client_name,
    status: row.status,
    subject: row.subject,
    meeting_starts_at: row.meeting_starts_at,
    held_at: row.held_at,
    reviewer_notified_at: row.reviewer_notified_at,
    zero_context: hasZeroContext(row.facts),
    text_body: row.text_body,
    links: briefLinks(row.id, env),
  };
}

async function sendReleased(brief, { store, env, send }) {
  if (!brief || brief.status !== 'released' || brief.sent_at) return { sent: false, reason: 'not_released' };
  if (hasZeroContext(brief.facts)) return { sent: false, reason: 'zero_context' };
  const claimed = await store.claimSend(brief.id);
  if (!claimed) return { sent: false, reason: 'not_claimed' };
  const client = await store.clientById(brief.client_id);
  const recipients = clientBriefRecipients(client || { notify_emails: brief.to_emails }, env);
  if (!recipients.to.length) {
    await store.markSendError(brief.id, 'no_recipients');
    return { sent: false, reason: 'no_recipients' };
  }
  try {
    await send({
      to: recipients.to,
      cc: recipients.cc,
      replyTo: fyiReplyTo(env),
      subject: claimed.subject || brief.subject,
      htmlBody: claimed.html_body || brief.html_body,
      textBody: claimed.text_body || brief.text_body,
    });
    await store.markSent(brief.id);
    return { sent: true, to: recipients.to, cc: recipients.cc };
  } catch (err) {
    await store.markSendError(brief.id, err && err.message ? err.message : 'send_failed');
    return { sent: false, reason: 'send_failed' };
  }
}

async function holdOne(row, { store, env, now, fetchImpl, send, deps }) {
  const start = usableMeetingStart(row);
  if (!start || !briefIsDue(start, now, leadMinutes(env))) return { held: false, reason: 'not_due' };
  let prior = null;
  if (row.lead_email) {
    try { prior = await store.priorNoShows(row.client_id, row.lead_email, start); }
    catch (err) {
      console.warn('[DayofBrief] no-show lookup skipped', { err: String(err && err.message || err).slice(0, 160) });
    }
  }
  const facts = await gatherBriefFacts(row, { priorNoShows: prior, env, fetchImpl, deps, db: store.db });
  const rendered = buildClientDayofBrief(facts);
  const recipients = clientBriefRecipients(row, env);
  const inserted = await store.insertHeld({
    meeting_id: row.id,
    client_id: row.client_id,
    subject: rendered.subject,
    html_body: rendered.htmlBody,
    text_body: rendered.textBody,
    facts,
    to_emails: formatEmailList(recipients.to),
    cc_emails: formatEmailList(recipients.cc),
    meeting_starts_at: start,
  });
  if (!inserted) return { held: false, reason: 'duplicate' };
  const brief = { ...inserted, facts: inserted.facts || facts, client_name: row.client_name };
  try {
    const note = await notifyReviewer(brief, { env, fetchImpl, send });
    if (note.ok) await store.markNotified(brief.id, null);
    else await store.markNotified(brief.id, note.skipped || 'not_notified');
    return { held: true, notified: note.ok === true, id: brief.id };
  } catch (err) {
    await store.markNotified(brief.id, String(err && err.message || err).slice(0, 300));
    return { held: true, notified: false, id: brief.id };
  }
}

async function runClientDayofBriefs(opts = {}) {
  const env = opts.env || process.env;
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now || Date.now());
  const enabled = dayofBriefEnabled(env);
  const result = { enabled, held: 0, notified: 0, sent: 0, skipped: 0, blocked_by_context: 0 };
  if (!enabled) return result;
  const store = opts.store || sqlStore(opts.db || require('../db'));
  const send = opts.send || (async (message) => {
    const gmail = require('./gmail-send');
    return gmail.sendMail(message);
  });
  const fetchImpl = opts.fetchImpl || fetch;

  if (store.giveUpPast) await store.giveUpPast(now);

  const due = await store.dueMeetings(now, leadMinutes(env));
  for (const row of due) {
    try {
      const out = await holdOne(row, { store, env, now, fetchImpl, send, deps: opts.deps });
      if (out.held) result.held += 1;
      else result.skipped += 1;
      if (out.notified) result.notified += 1;
    } catch (err) {
      result.skipped += 1;
      console.error('[DayofBrief] hold failed', { meetingId: row && row.id, err: String(err && err.message || err).slice(0, 200) });
    }
  }

  const waiting = await store.listUnnotified();
  for (const brief of waiting) {
    try {
      const note = await notifyReviewer(brief, { env, fetchImpl, send });
      if (note.ok) {
        await store.markNotified(brief.id, null);
        result.notified += 1;
      } else {
        await store.markNotified(brief.id, note.skipped || 'not_notified');
      }
    } catch (err) {
      await store.markNotified(brief.id, String(err && err.message || err).slice(0, 300));
    }
  }

  const ready = await store.listUnsentReleased(now);
  for (const brief of ready) {
    if (brief.status !== 'released') continue;
    if (hasZeroContext(brief.facts)) {
      result.blocked_by_context += 1;
      continue;
    }
    const sent = await sendReleased(brief, { store, env, send });
    if (sent.sent) result.sent += 1;
  }
  return result;
}

async function previewBrief({ meetingId, store, env = process.env, fetchImpl = fetch, deps = null } = {}) {
  if (!meetingId) return { status: 400, body: { ok: false, error: 'meeting_id_required' } };
  const dbStore = store || sqlStore(require('../db'));
  const row = await dbStore.loadMeeting(meetingId);
  if (!row) return { status: 404, body: { ok: false, error: 'meeting_not_found' } };
  let prior = null;
  if (row.lead_email) {
    try { prior = await dbStore.priorNoShows(row.client_id, row.lead_email, row.confirmed_time || new Date()); }
    catch { prior = null; }
  }
  const facts = await gatherBriefFacts(row, { priorNoShows: prior, env, fetchImpl, deps, db: dbStore.db });
  const rendered = buildClientDayofBrief(facts);
  const recipients = clientBriefRecipients(row, env);
  return {
    status: 200,
    body: {
      ok: true,
      dry_run: true,
      sent: false,
      queued: false,
      enabled: dayofBriefEnabled(env),
      zero_context: hasZeroContext(facts),
      context: contextPresence(facts),
      subject: rendered.subject,
      text_body: rendered.textBody,
      html_body: rendered.htmlBody,
      to: recipients.to,
      cc: recipients.cc,
    },
  };
}

async function listPendingBriefs({ store, env = process.env } = {}) {
  const dbStore = store || sqlStore(require('../db'));
  const rows = await dbStore.listPending();
  const briefs = rows.map((row) => presentPending(row, env));
  return { status: 200, body: { count: briefs.length, briefs } };
}

async function releaseBrief(id, edits, { store, env = process.env, send } = {}) {
  if (!id) return { status: 400, body: { ok: false, error: 'id_required' } };
  const dbStore = store || sqlStore(require('../db'));
  const mail = send || (async (message) => require('./gmail-send').sendMail(message));
  const existing = await dbStore.getBrief(id);
  if (!existing) return { status: 404, body: { ok: false, error: 'not_found' } };
  if (existing.sent_at) return { status: 200, body: { ok: true, already_sent: true, sent: true } };
  if (existing.status === 'blocked') return { status: 409, body: { ok: false, error: 'blocked' } };
  const facts = mergeFacts(existing.facts, edits);
  const rendered = buildClientDayofBrief(facts);
  if (hasZeroContext(facts)) {
    await dbStore.saveFacts(id, facts, rendered);
    return { status: 409, body: { ok: false, error: 'zero_context', status: 'held', sent: false } };
  }
  const client = await dbStore.clientById(existing.client_id);
  const recipients = clientBriefRecipients(client || { notify_emails: existing.to_emails }, env);
  const released = await dbStore.markReleased(id, facts, rendered, recipients);
  if (!released) return { status: 409, body: { ok: false, error: 'not_releasable' } };
  if (!dayofBriefEnabled(env)) {
    return { status: 200, body: { ok: true, released: true, sent: false, reason: 'flag_off', to: recipients.to, cc: recipients.cc } };
  }
  const sent = await sendReleased(
    { ...released, status: 'released', facts, subject: rendered.subject, html_body: rendered.htmlBody, text_body: rendered.textBody, sent_at: null },
    { store: dbStore, env, send: mail },
  );
  return {
    status: 200,
    body: { ok: true, released: true, sent: sent.sent === true, reason: sent.reason, to: sent.to || recipients.to, cc: sent.cc || recipients.cc },
  };
}

async function blockBrief(id, { store } = {}) {
  if (!id) return { status: 400, body: { ok: false, error: 'id_required' } };
  const dbStore = store || sqlStore(require('../db'));
  const existing = await dbStore.getBrief(id);
  if (!existing) return { status: 404, body: { ok: false, error: 'not_found' } };
  if (existing.sent_at) return { status: 409, body: { ok: false, error: 'already_sent' } };
  if (existing.status === 'blocked') return { status: 200, body: { ok: true, status: 'blocked', sent: false } };
  const updated = await dbStore.markBlocked(id);
  if (!updated && existing.status !== 'blocked') return { status: 409, body: { ok: false, error: 'not_blocked' } };
  return { status: 200, body: { ok: true, status: 'blocked', sent: false } };
}

module.exports = {
  FLAG,
  JOSH_DEFAULT,
  EXAMPLE_BRIEF_FACTS,
  dayofBriefEnabled,
  leadMinutes,
  joshEmail,
  usableMeetingStart,
  briefIsDue,
  briefLinks,
  clientBriefRecipients,
  assembleBriefFacts,
  gatherBriefFacts,
  contextPresence,
  hasZeroContext,
  mergeFacts,
  buildClientDayofBrief,
  exampleClientBrief,
  REVIEW_SUBJECT_TAG,
  notifyReviewer,
  reviewNotice,
  reviewEmailSubject,
  runClientDayofBriefs,
  previewBrief,
  listPendingBriefs,
  releaseBrief,
  blockBrief,
  sendReleased,
  sqlStore,
};
