'use strict';

/**
 * Day-of meeting brief for the client who is taking the meeting.
 *
 * About CLIENT_DAYOF_BRIEF_LEAD_MINUTES (default 45) before meetings.confirmed_time
 * the cron builds one brief and stores it as `held`. It notifies REVIEW_NOTIFY
 * (a webhook URL or an email) with the rendered brief and release / enrich / block
 * links. It does not email the client.
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

const JOSH_DEFAULT = 'joshua@salesglidergrowth.com';
const FLAG = 'CLIENT_DAYOF_BRIEF_ENABLED';
const LEAD_FLAG = 'CLIENT_DAYOF_BRIEF_LEAD_MINUTES';
const DEFAULT_LEAD_MINUTES = 45;
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

function formatWhen(value, tz) {
  const d = asDate(value);
  if (!d) return '';
  const zone = tz || 'America/Chicago';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(d);
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

function threadMessages(row) {
  const platform = String(row.platform || 'smartlead').toLowerCase() === 'heyreach' ? 'heyreach' : 'smartlead';
  const extra = [];
  if (filled(row.sent_reply)) extra.push({ role: 'us', body: row.sent_reply, time: row.updated_at || '' });
  if (filled(row.inbound_message)) extra.push({ role: 'them', body: row.inbound_message, time: row.created_at || '' });
  return extractThreadMessages(platform, row.thread_context, { maxMessages: 8, extraMessages: extra, pinStart: true })
    .map((m) => ({ ...m, body: stripQuoted(m.body).slice(0, 1500) }))
    .filter((m) => filled(m.body));
}

function asksFrom(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role !== 'them') continue;
    const sentences = m.body.split(/(?<=[.?!])\s+/);
    for (const sentence of sentences) {
      const s = oneLine(sentence, 400);
      if (!s) continue;
      if (/\?/.test(s) || /\b(send|pricing|price|deck|one-pager|one pager|call me|schedule|times work|let me know)\b/i.test(s)) {
        if (!out.includes(s)) out.push(s);
      }
      if (out.length >= 4) return out;
    }
  }
  return out;
}

function icpPlain(raw) {
  const v = parseObj(raw);
  if (!v || !v.status) return '';
  const reason = oneLine(v.reason, 180);
  if (v.status === 'unknown' && /^no ICP$/i.test(reason)) return 'ICP fit: not on file';
  if (v.status === 'qualified') return `ICP fit: qualified${reason ? ` (${reason})` : ''}`;
  if (v.status === 'disqualified') return `ICP fit: not a fit${reason ? ` (${reason})` : ''}`;
  return reason ? `ICP fit: unknown (${reason})` : 'ICP fit: unknown';
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
  const messages = threadMessages(src);
  const us = messages.filter((m) => m.role === 'us').length;
  const them = messages.filter((m) => m.role === 'them').length;
  const summary = (us || them)
    ? `${us} email${us === 1 ? '' : 's'} from us, ${them} repl${them === 1 ? 'y' : 'ies'} from them.`
    : '';
  const quotes = messages.filter((m) => m.role === 'them').slice(-3).map((m) => ({
    when: formatWhen(m.time, tz),
    who: name || 'Prospect',
    text: oneLine(m.body, 500),
  })).filter((q) => q.text);
  const callNotes = callNotesFrom(src);
  const openItems = asksFrom(messages);
  const icpFit = icpPlain(src.icp_verdict);
  const noShowHistory = noShowLine(priorNoShows, src.lead_email, tz);
  const risks = [];
  const icp = parseObj(src.icp_verdict);
  if (icp && icp.status === 'disqualified') risks.push(icpFit || 'ICP fit: not a fit');
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
    history: { summary, quotes, callNotes, ask: '' },
    openItems,
    flags: { icpFit, risks, noShowHistory },
  };
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
    history: filled(history.summary) || filled(history.callNotes) || quotes.length > 0,
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
  take('flags', ['icpFit', 'noShowHistory']);
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

function sectionBullets(facts) {
  const p = facts.prospect || {};
  const c = facts.company || {};
  const h = facts.how || {};
  const hist = facts.history || {};
  const flags = facts.flags || {};
  const who = [];
  const person = [p.name, p.title].filter(filled).join(', ');
  if (person) who.push(person);
  if (filled(p.linkedinUrl)) who.push(`LinkedIn: ${p.linkedinUrl}`);
  const reach = [p.email, p.phone].filter(filled).join(' | ');
  if (reach) who.push(reach);
  if (filled(p.location)) who.push(p.location);

  const company = [];
  if (filled(c.name || p.company)) company.push(c.name || p.company);
  if (filled(c.website)) company.push(c.website);
  if (filled(c.whatTheyDo)) company.push(c.whatTheyDo);
  if (filled(c.size)) company.push(`Size: ${c.size}`);

  const how = [];
  if (filled(h.channel)) how.push(`Channel: ${h.channel}`);
  if (filled(h.campaign)) how.push(`Campaign: ${h.campaign}`);
  if (filled(h.source)) how.push(`Source: ${h.source}`);

  const past = [];
  if (filled(hist.summary)) past.push(hist.summary);
  for (const q of hist.quotes || []) {
    const text = oneLine(q && (q.text || q), 600);
    if (!text) continue;
    const whoSaid = [oneLine(q.when, 80), oneLine(q.who, 120)].filter(Boolean).join(', ');
    past.push(whoSaid ? `Quote (${whoSaid}): "${text}"` : `Quote: "${text}"`);
  }
  if (filled(hist.callNotes)) past.push(`Call notes: ${hist.callNotes}`);

  const open = bulletList(facts.openItems);
  if (filled(hist.ask) && !open.includes(oneLine(hist.ask, 600))) open.push(oneLine(hist.ask, 600));

  const flagLines = [];
  if (filled(flags.icpFit)) flagLines.push(flags.icpFit);
  for (const risk of flags.risks || []) if (filled(risk)) flagLines.push(risk);
  if (filled(flags.noShowHistory)) flagLines.push(flags.noShowHistory);

  return { who, company, how, past, open, flagLines };
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
    ['Company', sections.company],
    ['How they came in', sections.how],
    ['Past emails and calls', sections.past],
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
  text.push('Sent automatically by SalesGlider. Reply all with notes and operations sees it.');
  const textBody = text.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  const ul = (items) => `<ul style="margin:4px 0 0;padding-left:20px;">${items.map((item) => {
    const raw = String(item);
    const url = raw.match(/https?:\/\/[^\s<>"]+/);
    let html = escapeHtml(raw);
    if (url) html = html.replace(escapeHtml(url[0]), `<a href="${escapeHtml(url[0])}">${escapeHtml(url[0])}</a>`);
    return `<li>${html}</li>`;
  }).join('')}</ul>`;

  const html = [
    `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111;line-height:1.45">`,
    `<p style="margin:0 0 8px"><b>${escapeHtml(header)}</b></p>`,
    join ? `<p style="margin:0 0 12px">Join: <a href="${escapeHtml(join)}">${escapeHtml(join)}</a></p>` : '',
    ...blocks.map(([title, items]) => `<p style="margin:16px 0 4px"><b>${escapeHtml(title)}</b></p>${ul(items)}`),
    `<p style="margin:22px 0 0;color:#666;font-size:12px">Sent automatically by SalesGlider. Reply all with notes and operations sees it.</p>`,
    `</div>`,
  ].filter(Boolean).join('');

  return { subject, htmlBody: html, textBody };
}

const EXAMPLE_BRIEF_FACTS = {
  clientName: 'Example Industrial',
  timezone: 'America/Chicago',
  whenLabel: 'Thu, Oct 31, 9:30 AM CDT',
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
  },
  openItems: [
    'Wants pricing walked through on the call',
    'Asked what they should send ahead of Thursday',
  ],
  flags: {
    icpFit: 'ICP fit: qualified (commercial roofer, operations lead)',
    risks: ['First meeting. No prior thread beyond the booking reply.'],
    noShowHistory: 'No prior no-shows on file.',
  },
};

function exampleClientBrief() {
  return { facts: EXAMPLE_BRIEF_FACTS, ...buildClientDayofBrief(EXAMPLE_BRIEF_FACTS) };
}

function reviewTarget(env = process.env) {
  return String(env.REVIEW_NOTIFY || '').trim();
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
      subject: `Review hold: ${brief.subject || 'meeting brief'}`,
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
    async dueMeetings(now, minutes) {
      const { rows } = await q(
        `SELECT m.id, m.client_id, m.pending_reply_id, m.lead_name, m.lead_email, m.linkedin_url,
                m.confirmed_time, m.created_at, m.meeting_link, m.calendar_provider, m.status,
                c.name AS client_name, c.notify_emails, c.digest_timezone,
                pr.platform, pr.campaign_id, pr.campaign_name, pr.lead_title, pr.lead_company,
                pr.lead_phone, pr.lead_website, pr.lead_full_name, pr.lead_location,
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
                pr.platform, pr.campaign_name, pr.lead_title, pr.lead_company,
                pr.lead_phone, pr.lead_website, pr.lead_full_name, pr.lead_location,
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

async function holdOne(row, { store, env, now, fetchImpl, send }) {
  const start = usableMeetingStart(row);
  if (!start || !briefIsDue(start, now, leadMinutes(env))) return { held: false, reason: 'not_due' };
  let prior = null;
  if (row.lead_email) {
    try { prior = await store.priorNoShows(row.client_id, row.lead_email, start); }
    catch (err) {
      console.warn('[DayofBrief] no-show lookup skipped', { err: String(err && err.message || err).slice(0, 160) });
    }
  }
  const facts = assembleBriefFacts(row, { priorNoShows: prior });
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
      const out = await holdOne(row, { store, env, now, fetchImpl, send });
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

async function previewBrief({ meetingId, store, env = process.env } = {}) {
  if (!meetingId) return { status: 400, body: { ok: false, error: 'meeting_id_required' } };
  const dbStore = store || sqlStore(require('../db'));
  const row = await dbStore.loadMeeting(meetingId);
  if (!row) return { status: 404, body: { ok: false, error: 'meeting_not_found' } };
  let prior = null;
  if (row.lead_email) {
    try { prior = await dbStore.priorNoShows(row.client_id, row.lead_email, row.confirmed_time || new Date()); }
    catch { prior = null; }
  }
  const facts = assembleBriefFacts(row, { priorNoShows: prior });
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
  contextPresence,
  hasZeroContext,
  mergeFacts,
  buildClientDayofBrief,
  exampleClientBrief,
  notifyReviewer,
  reviewNotice,
  runClientDayofBriefs,
  previewBrief,
  listPendingBriefs,
  releaseBrief,
  blockBrief,
  sendReleased,
  sqlStore,
};
