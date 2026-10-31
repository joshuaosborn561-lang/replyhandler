'use strict';

/**
 * Day-of client briefs are held for review. The client email waits for an
 * explicit release, the flag defaults off, and a brief with no source, company,
 * history, or ask cannot be released or sent.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  dayofBriefEnabled,
  dayofBriefWriterEnabled,
  leadMinutes,
  usableMeetingStart,
  briefIsDue,
  clientBriefRecipients,
  assembleBriefFacts,
  gatherBriefFacts,
  hasZeroContext,
  buildClientDayofBrief,
  exampleClientBrief,
  runClientDayofBriefs,
  previewBrief,
  releaseBrief,
  blockBrief,
  listPendingBriefs,
  listUpcomingMeetings,
  sendClientBrief,
  JOSH_DEFAULT,
  REVIEW_SUBJECT_TAG,
  reviewEmailSubject,
} = require('../src/services/client-dayof-brief');

const START = new Date('2026-10-31T14:30:00.000Z'); // 9:30 AM CDT
const NOW = new Date(START.getTime() - 45 * 60 * 1000);
const VECTOR = 'agancman@vectorenergygroup.com';
const JOSH = JOSH_DEFAULT;

function meeting(over = {}) {
  return {
    id: 'meet-1',
    client_id: 'client-vector',
    pending_reply_id: 'reply-1',
    lead_name: 'Jordan Hale',
    lead_full_name: 'Jordan Hale',
    lead_email: 'jordan.hale@northwind-roofing.example',
    lead_title: 'VP of Operations',
    lead_company: 'Northwind Roofing Co.',
    lead_phone: '(214) 555-0148',
    linkedin_url: 'https://www.linkedin.com/in/jordan-hale-example',
    lead_website: 'https://northwind-roofing.example',
    campaign_name: 'Spring owners, north Texas',
    platform: 'smartlead',
    inbound_message: 'Thursday works. Can you walk us through pricing?',
    sent_reply: 'Here are two times that work on our side.',
    confirmed_time: START.toISOString(),
    created_at: '2026-10-28T15:00:00.000Z',
    meeting_link: 'https://us06web.zoom.us/j/00000000000',
    client_name: 'Vector',
    notify_emails: VECTOR,
    digest_timezone: 'America/Chicago',
    icp_verdict: { status: 'qualified', reason: 'commercial roofer' },
    ...over,
  };
}

function thinMeeting(over = {}) {
  return meeting({
    id: 'meet-thin',
    lead_name: 'Alex Example',
    lead_full_name: 'Alex Example',
    lead_email: 'alex.example@gmail.com',
    lead_title: '',
    lead_company: '',
    lead_phone: '',
    lead_website: '',
    linkedin_url: 'https://www.linkedin.com/in/alex-example',
    campaign_name: '',
    platform: '',
    pending_reply_id: null,
    inbound_message: '',
    sent_reply: '',
    thread_context: null,
    icp_verdict: null,
    meeting_link: '',
    calendar_provider: '',
    ...over,
  });
}

function memoryStore(seed = {}) {
  const briefs = [];
  let n = 1;
  const api = {
    briefs,
    meetings: seed.meetings || [],
    clients: seed.clients || {
      'client-vector': { id: 'client-vector', name: 'Vector', notify_emails: VECTOR },
    },
    noShows: seed.noShows === undefined ? [] : seed.noShows,
    async dueMeetings() {
      return api.meetings.filter((m) => !briefs.some((b) => b.meeting_id === m.id && b._hidden !== true));
    },
    async priorNoShows() { return api.noShows; },
    async insertHeld(row) {
      if (briefs.some((b) => b.meeting_id === row.meeting_id)) return null;
      const saved = {
        id: `brief-${n++}`, status: 'held', sent_at: null, reviewer_notified_at: null, send_error: null, ...row,
      };
      briefs.push(saved);
      return { ...saved };
    },
    async listUnnotified() {
      return briefs.filter((b) => b.status === 'held' && !b.reviewer_notified_at);
    },
    async markNotified(id, err) {
      const b = briefs.find((x) => x.id === id);
      if (!b) return;
      if (err == null) b.reviewer_notified_at = 'notified';
      else b.reviewer_notify_error = err;
    },
    async listUnsentReleased() {
      return briefs.filter((b) => b.status === 'released' && !b.sent_at && b.send_error !== 'meeting_passed' && b.send_error !== 'sending');
    },
    async giveUpPast() {},
    async claimSend(id) {
      const b = briefs.find((x) => x.id === id);
      if (!b || b.status !== 'released' || b.sent_at) return null;
      if (b.send_error === 'sending' || b.send_error === 'meeting_passed') return null;
      b.send_error = 'sending';
      return b;
    },
    async markSent(id) {
      const b = briefs.find((x) => x.id === id);
      b.sent_at = 'sent';
      b.send_error = null;
    },
    async markSendError(id, err) {
      const b = briefs.find((x) => x.id === id);
      if (b) b.send_error = err;
    },
    async getBrief(id) { return briefs.find((b) => b.id === id) || null; },
    async saveFacts(id, facts, rendered) {
      const b = briefs.find((x) => x.id === id);
      if (!b || b.status !== 'held') return null;
      b.facts = facts;
      b.subject = rendered.subject;
      b.html_body = rendered.htmlBody;
      b.text_body = rendered.textBody;
      return b;
    },
    async markReleased(id, facts, rendered, recipients) {
      const b = briefs.find((x) => x.id === id);
      if (!b || b.sent_at || !['held', 'released'].includes(b.status)) return null;
      b.status = 'released';
      b.facts = facts;
      b.subject = rendered.subject;
      b.html_body = rendered.htmlBody;
      b.text_body = rendered.textBody;
      b.to_emails = recipients.to.join(', ');
      b.cc_emails = recipients.cc.join(', ');
      b.send_error = null;
      return b;
    },
    async markBlocked(id) {
      const b = briefs.find((x) => x.id === id);
      if (!b || b.sent_at) return null;
      if (b.status === 'blocked') return b;
      b.status = 'blocked';
      return b;
    },
    async listPending() { return briefs.filter((b) => b.status === 'held'); },
    async loadMeeting(id) { return api.meetings.find((m) => m.id === id) || null; },
    async clientById(id) { return api.clients[id] || null; },
    async listUpcoming(fromIso, toIso) {
      const start = new Date(fromIso).getTime();
      const end = new Date(toIso).getTime();
      return api.meetings.filter((m) => {
        const status = m.status || 'booked';
        if (!['booked', 'confirmed'].includes(status)) return false;
        const t = new Date(m.confirmed_time).getTime();
        return t >= start && t < end;
      }).map((m) => {
        const client = api.clients[m.client_id] || {};
        const brief = briefs.find((b) => b.meeting_id === m.id);
        return {
          ...m,
          client_name: m.client_name || client.name,
          notify_emails: client.notify_emails || m.notify_emails,
          digest_timezone: m.digest_timezone || client.digest_timezone,
          icp_profile: Object.prototype.hasOwnProperty.call(client, 'icp_profile') ? client.icp_profile : (m.icp_profile ?? null),
          brief_sent_at: brief ? brief.sent_at : null,
        };
      });
    },
    async briefByMeeting(meetingId) {
      return briefs.find((b) => b.meeting_id === meetingId) || null;
    },
    async upsertEaReleased(row) {
      const existing = briefs.find((b) => b.meeting_id === row.meeting_id);
      if (existing) {
        if (existing.sent_at || existing.status === 'blocked') return null;
        Object.assign(existing, {
          status: 'released',
          subject: row.subject,
          html_body: row.html_body,
          text_body: row.text_body,
          facts: row.facts,
          to_emails: row.to_emails,
          cc_emails: row.cc_emails,
          meeting_starts_at: row.meeting_starts_at,
          send_error: null,
        });
        return existing;
      }
      const saved = {
        id: `brief-${n++}`,
        status: 'released',
        sent_at: null,
        send_error: null,
        reviewer_notified_at: null,
        ...row,
      };
      briefs.push(saved);
      return { ...saved };
    },
  };
  return api;
}

function env(over = {}) {
  return {
    CLIENT_DAYOF_BRIEF_ENABLED: 'true',
    CLIENT_DAYOF_BRIEF_WRITER_ENABLED: 'true',
    REVIEW_NOTIFY: 'https://review.example/hook',
    PUBLIC_BASE_URL: 'https://briefs.example',
    ...over,
  };
}

describe('day-of brief schedule and flag', () => {
  it('the flag defaults off and the lead time defaults to 2 hours', () => {
    assert.equal(dayofBriefEnabled({}), false);
    assert.equal(dayofBriefEnabled({ CLIENT_DAYOF_BRIEF_ENABLED: '' }), false);
    assert.equal(dayofBriefEnabled({ CLIENT_DAYOF_BRIEF_ENABLED: 'false' }), false);
    assert.equal(dayofBriefEnabled({ CLIENT_DAYOF_BRIEF_ENABLED: 'true' }), true);
    assert.equal(dayofBriefWriterEnabled({}), false);
    assert.equal(dayofBriefWriterEnabled({ CLIENT_DAYOF_BRIEF_WRITER_ENABLED: '' }), false);
    assert.equal(dayofBriefWriterEnabled({ CLIENT_DAYOF_BRIEF_WRITER_ENABLED: 'true' }), true);
    assert.equal(leadMinutes({}), 120);
    assert.equal(leadMinutes({ CLIENT_DAYOF_BRIEF_LEAD_MINUTES: '30' }), 30);
  });

  it('builds inside the 2 hour window and skips a timestamp that is just the insert', () => {
    assert.equal(briefIsDue(START, new Date(START.getTime() - 120 * 60 * 1000), 120), true);
    assert.equal(briefIsDue(START, new Date(START.getTime() - 121 * 60 * 1000), 120), false);
    assert.equal(briefIsDue(START, NOW, 120), true);
    assert.equal(briefIsDue(START, new Date(START.getTime() + 60 * 1000), 120), false);
    const stamped = meeting({ created_at: START.toISOString(), confirmed_time: new Date(START.getTime() + 30 * 1000).toISOString() });
    assert.equal(usableMeetingStart(stamped), null);
    assert.ok(usableMeetingStart(meeting()) instanceof Date);
  });
});

describe('day-of brief rendering', () => {
  it('uses the short bullet layout and leaves empty sections out', () => {
    const sample = exampleClientBrief();
    for (const section of ['Who', "Why you're meeting", 'Rapport hooks', 'Easy openers', 'Allo', 'Fireflies / Cube', 'Logistics']) {
      assert.match(sample.textBody, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(sample.htmlBody, new RegExp(`<h3>${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</h3>`));
    }
    assert.match(sample.subject, /^Brief: Jordan Hale and Example Industrial @ 9:30am CT$/);
    assert.match(sample.textBody, /^Brief: Jordan Hale and Example Industrial @ 9:30am CT/);
    assert.match(sample.htmlBody, /font-family:Arial,sans-serif;font-size:14px/);
    assert.match(sample.textBody, /jordan\.hale@northwind-roofing\.example/);
    assert.match(sample.textBody, /\(214\) 555-0148/);
    assert.match(sample.textBody, /Rockwall, TX/);
    assert.match(sample.textBody, /jordan-hale-example/);
    assert.match(sample.textBody, /northwind-roofing\.example/);
    assert.match(sample.textBody, /Spring owners, north Texas/);
    assert.equal(sample.textBody.includes('Source campaign'), false);
    assert.equal(sample.textBody.includes('LTV'), false);
    assert.match(sample.textBody, /walk us through pricing/);
    assert.match(sample.htmlBody, /<h3>Who<\/h3>/);
    assert.equal(sample.htmlBody.includes('<script>'), false);

    const thin = buildClientDayofBrief({
      prospect: { name: 'Alex Example', linkedinUrl: 'https://www.linkedin.com/in/alex-example' },
    });
    assert.equal(thin.textBody.includes('About'), false);
    assert.equal(thin.textBody.includes('Source campaign'), false);
    assert.equal(thin.textBody.includes('Email thread'), false);
    assert.match(thin.textBody, /LinkedIn: https:\/\/www\.linkedin\.com\/in\/alex-example/);
    assert.equal(hasZeroContext({ prospect: { name: 'Alex Example', linkedinUrl: 'https://www.linkedin.com/in/alex-example' } }), true);
    assert.equal(hasZeroContext({ prospect: { name: 'Alex Example' }, how: { campaign: 'Spring owners' } }), false);
  });

  it('escapes HTML in prospect fields', () => {
    const { htmlBody } = buildClientDayofBrief({
      prospect: { name: 'Jordan <script>' },
      how: { channel: 'Email' },
    });
    assert.match(htmlBody, /Jordan &lt;script&gt;/);
    assert.equal(htmlBody.includes('<script>'), false);
  });

  it('assembles stored facts without inventing a company description', () => {
    const facts = assembleBriefFacts(meeting(), { priorNoShows: [] });
    assert.match(facts.whenLabel, /9:30/);
    assert.equal(facts.prospect.linkedinUrl.includes('jordan-hale-example'), true);
    assert.equal(facts.company.whatTheyDo, '');
    assert.equal(facts.company.website, 'https://northwind-roofing.example');
    assert.match(facts.how.campaign, /Spring owners/);
    assert.equal(facts.how.channel, 'Email');
    assert.match(facts.history.summary, /email message/);
    assert.match(facts.history.emailLines.join(' '), /pricing/);
    assert.equal(facts.history.dmLines.length, 0);
    assert.match(facts.history.quotes[0].text, /pricing/);
    assert.match(facts.openItems.join(' '), /pricing/);
    assert.match(facts.flags.icpFit, /Fit — commercial roofer/);
    assert.match(facts.flags.decisionMaker, /Decision maker: Yes, senior leader \(VP of Operations\)/);
    assert.equal(facts.flags.noShowHistory, 'No prior no-shows on file.');
    assert.equal(hasZeroContext(facts), false);
    const noshow = assembleBriefFacts(meeting(), {
      priorNoShows: [{ meeting_start: '2026-10-02T15:00:00.000Z', reason: 'no_recording' }],
    });
    assert.match(noshow.flags.noShowHistory, /No-show on/);
    assert.equal(assembleBriefFacts(thinMeeting(), { priorNoShows: [] }).company.website, '');
    assert.equal(hasZeroContext(assembleBriefFacts(thinMeeting(), { priorNoShows: [] })), true);
  });

  it('puts a LinkedIn thread under LinkedIn and leaves the email section out', () => {
    const facts = assembleBriefFacts(meeting({
      platform: 'heyreach',
      campaign_name: 'Owners, LinkedIn',
      inbound_message: 'Thursday works. Can you walk us through pricing?',
      sent_reply: 'Two times are open.',
      thread_context: null,
    }), { priorNoShows: [] });
    assert.equal(facts.history.emailLines.length, 0);
    assert.match(facts.history.dmLines.join(' '), /pricing/);
    const brief = buildClientDayofBrief(facts);
    assert.match(brief.textBody, /Why you're meeting/);
    assert.match(brief.textBody, /LinkedIn: /);
    assert.equal(brief.textBody.includes('Email thread'), false);
    assert.match(facts.how.campaign, /Owners, LinkedIn/);
    assert.match(brief.textBody, /Owners, LinkedIn/);
    assert.equal(brief.textBody.includes('Source campaign'), false);
  });

  it('drops internal pricing, LTV, and unsubscribe notes', () => {
    const brief = buildClientDayofBrief({
      clientName: 'Example Industrial',
      whenLabel: 'Thu, Oct 31, 9:30am CT',
      prospect: { name: 'Jordan Hale', email: 'jordan@northwind-roofing.example' },
      how: { channel: 'Email', campaign: 'Spring owners' },
      openItems: ['Wants a pricing walkthrough on the call'],
      flags: {
        risks: [
          'Should clear the $36K LTV bar',
          'Smartlead shows him unsubscribed from the sequence',
          'Proof to lean on: another client closed four bids',
        ],
      },
    });
    assert.match(brief.textBody, /pricing walkthrough/);
    assert.match(brief.textBody, /Spring owners/);
    assert.equal(brief.textBody.includes('LTV'), false);
    assert.equal(brief.textBody.includes('unsubscribed'), false);
    assert.equal(brief.textBody.includes('Proof to lean on'), false);
    assert.equal(brief.textBody.includes('Smartlead'), false);
  });
});

describe('day-of brief recipients', () => {
  it('sends To the client notify list and CC Josh, including Vector', () => {
    const r = clientBriefRecipients({ notify_emails: VECTOR }, {});
    assert.deepEqual(r.to, [VECTOR]);
    assert.deepEqual(r.cc, [JOSH]);
    const dup = clientBriefRecipients({ notify_emails: `${VECTOR}, ${JOSH}` }, {});
    assert.deepEqual(dup.to, [VECTOR]);
    assert.deepEqual(dup.cc, [JOSH]);
    const empty = clientBriefRecipients({ notify_emails: '' }, {});
    assert.deepEqual(empty.to, []);
    assert.deepEqual(empty.cc, [JOSH]);
  });
});

describe('day-of brief hold, release, block', () => {
  it('does nothing when the flag is off', async () => {
    const store = memoryStore({ meetings: [meeting()] });
    const sent = [];
    const result = await runClientDayofBriefs({
      env: { CLIENT_DAYOF_BRIEF_ENABLED: 'false' },
      store,
      now: NOW,
      send: async (m) => sent.push(m),
    });
    assert.equal(result.enabled, false);
    assert.equal(store.briefs.length, 0);
    assert.equal(sent.length, 0);
  });

  it('holds a due meeting, notifies the reviewer, and does not email the client', async () => {
    const store = memoryStore({ meetings: [meeting()] });
    const sent = [];
    const hooks = [];
    const result = await runClientDayofBriefs({
      env: env(),
      store,
      now: NOW,
      send: async (m) => sent.push(m),
      fetchImpl: async (url, opts) => {
        hooks.push({ url, body: JSON.parse(opts.body) });
        return { ok: true, status: 200 };
      },
    });
    assert.equal(result.held, 1);
    assert.equal(result.sent, 0);
    assert.equal(sent.length, 0);
    assert.equal(store.briefs[0].status, 'held');
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].body.event, 'client_dayof_brief_held');
    assert.match(hooks[0].body.links.release, /\/admin\/client-briefs\/brief-1\/release$/);
    assert.match(hooks[0].body.links.enrich, /\/release$/);
    assert.match(hooks[0].body.links.block, /\/block$/);
    assert.match(hooks[0].body.text, /Jordan Hale/);
    assert.equal(hooks[0].body.zero_context, false);

    const again = await runClientDayofBriefs({
      env: env(),
      store,
      now: NOW,
      send: async (m) => sent.push(m),
      fetchImpl: async () => { hooks.push({ again: true }); return { ok: true, status: 200 }; },
    });
    assert.equal(again.held, 0);
    assert.equal(again.sent, 0);
    assert.equal(store.briefs.length, 1);
    assert.equal(hooks.length, 1);
    assert.equal(sent.length, 0);
  });

  it('retries the reviewer notice after a restart and still does not email the client', async () => {
    const store = memoryStore({ meetings: [] });
    store.briefs.push({
      id: 'brief-held',
      meeting_id: 'meet-1',
      client_id: 'client-vector',
      status: 'held',
      subject: 'Brief: Jordan Hale @ 9:30 AM CDT',
      text_body: 'Who\n- Jordan Hale',
      html_body: '<p>Jordan Hale</p>',
      facts: assembleBriefFacts(meeting()),
      sent_at: null,
      reviewer_notified_at: null,
      send_error: null,
    });
    const sent = [];
    let hooks = 0;
    await runClientDayofBriefs({
      env: env(),
      store,
      now: NOW,
      send: async (m) => sent.push(m),
      fetchImpl: async () => { hooks += 1; return { ok: true, status: 200 }; },
    });
    assert.equal(hooks, 1);
    assert.equal(store.briefs[0].reviewer_notified_at, 'notified');
    assert.equal(sent.length, 0);
    assert.equal(store.briefs.length, 1);
  });

  it('release emails notify_emails and CC Josh; a second pass does not send again', async () => {
    const store = memoryStore({ meetings: [meeting()] });
    const sent = [];
    await runClientDayofBriefs({
      env: env(), store, now: NOW, send: async (m) => sent.push(m),
      fetchImpl: async () => ({ ok: true, status: 200 }),
    });
    const out = await releaseBrief(store.briefs[0].id, {}, {
      store, env: env(), send: async (m) => sent.push(m),
    });
    assert.equal(out.status, 200);
    assert.equal(out.body.sent, true);
    assert.deepEqual(out.body.to, [VECTOR]);
    assert.deepEqual(out.body.cc, [JOSH]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to[0], VECTOR);
    assert.deepEqual(sent[0].cc, [JOSH]);
    assert.match(sent[0].subject, /^Brief: Jordan Hale/);
    assert.equal(store.briefs[0].status, 'released');
    assert.ok(store.briefs[0].sent_at);

    const again = await releaseBrief(store.briefs[0].id, {}, {
      store, env: env(), send: async (m) => sent.push(m),
    });
    assert.equal(again.body.already_sent, true);
    assert.equal(sent.length, 1);
  });

  it('does not email the client on release while the flag is off, then sends once the flag is on', async () => {
    const store = memoryStore({ meetings: [meeting()] });
    const sent = [];
    await runClientDayofBriefs({
      env: env(), store, now: NOW, send: async (m) => sent.push(m),
      fetchImpl: async () => ({ ok: true, status: 200 }),
    });
    const held = await releaseBrief(store.briefs[0].id, {}, {
      store,
      env: env({ CLIENT_DAYOF_BRIEF_ENABLED: 'false' }),
      send: async (m) => sent.push(m),
    });
    assert.equal(held.body.released, true);
    assert.equal(held.body.sent, false);
    assert.equal(held.body.reason, 'flag_off');
    assert.equal(sent.length, 0);
    assert.equal(store.briefs[0].sent_at, null);

    const tick = await runClientDayofBriefs({
      env: env(), store, now: NOW, send: async (m) => sent.push(m),
      fetchImpl: async () => ({ ok: true, status: 200 }),
    });
    assert.equal(tick.sent, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to[0], VECTOR);
  });

  it('refuses to release or send a zero-context brief, and missing LinkedIn alone does not', async () => {
    const store = memoryStore({ meetings: [thinMeeting()] });
    const sent = [];
    await runClientDayofBriefs({
      env: env(), store, now: NOW, send: async (m) => sent.push(m),
      fetchImpl: async () => ({ ok: true, status: 200 }),
    });
    assert.equal(store.briefs[0].status, 'held');
    assert.equal(hasZeroContext(store.briefs[0].facts), true);
    const refused = await releaseBrief(store.briefs[0].id, {}, {
      store, env: env(), send: async (m) => sent.push(m),
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'zero_context');
    assert.equal(store.briefs[0].status, 'held');
    assert.equal(sent.length, 0);

    store.briefs[0].status = 'released';
    store.briefs[0].send_error = null;
    const tick = await runClientDayofBriefs({
      env: env(), store, now: NOW, send: async (m) => sent.push(m),
      fetchImpl: async () => ({ ok: true, status: 200 }),
    });
    assert.equal(tick.blocked_by_context, 1);
    assert.equal(tick.sent, 0);
    assert.equal(sent.length, 0);
    store.briefs[0].status = 'held';

    const enriched = await releaseBrief(store.briefs[0].id, {
      company: { whatTheyDo: 'Example commercial roofing for property managers.', website: 'https://northwind-roofing.example' },
      openItems: ['Wants a pricing walkthrough on the call'],
    }, { store, env: env(), send: async (m) => sent.push(m) });
    assert.equal(enriched.body.sent, true);
    assert.match(sent[0].textBody, /Example commercial roofing/);
    assert.match(sent[0].textBody, /pricing walkthrough/);
    assert.equal(sent[0].textBody.includes('alex-example') || sent[0].htmlBody.includes('alex-example'), true);
  });

  it('block never sends, including a later release attempt', async () => {
    const store = memoryStore({ meetings: [meeting()] });
    const sent = [];
    await runClientDayofBriefs({
      env: env(), store, now: NOW, send: async (m) => sent.push(m),
      fetchImpl: async () => ({ ok: true, status: 200 }),
    });
    const blocked = await blockBrief(store.briefs[0].id, { store });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.status, 'blocked');
    assert.equal(store.briefs[0].status, 'blocked');
    const released = await releaseBrief(store.briefs[0].id, {}, {
      store, env: env(), send: async (m) => sent.push(m),
    });
    assert.equal(released.status, 409);
    assert.equal(released.body.error, 'blocked');
    const tick = await runClientDayofBriefs({
      env: env(), store, now: NOW, send: async (m) => sent.push(m),
      fetchImpl: async () => ({ ok: true, status: 200 }),
    });
    assert.equal(tick.sent, 0);
    assert.equal(sent.length, 0);
    const pending = await listPendingBriefs({ store, env: env() });
    assert.equal(pending.body.count, 0);
  });

  it('the live hold and the preview pull the same sections', async () => {
    const seen = [];
    const deps = {
      async getThreadHistory() {
        seen.push('thread');
        return {
          history: [
            { type: 'SENT', time: '2026-10-26T15:00:00.000Z', email_body: 'Open to a short call?' },
            { type: 'REPLY', time: '2026-10-26T16:00:00.000Z', email_body: 'Info' },
          ],
        };
      },
      async lookupLeadByEmail() {
        seen.push('lead');
        return { lead: { website: 'https://northwind-roofing.example', company_name: 'Northwind Roofing Co.' } };
      },
      async lookupPersonProfile() {
        seen.push('profile');
        return {
          linkedinUrl: 'https://www.linkedin.com/in/jordan-hale-example',
          location: 'Rockwall, TX',
          title: 'VP of Operations',
          fullName: 'Jordan Hale',
        };
      },
      async enrichProspect() {
        seen.push('phone');
        return { phone: '(214) 555-0199', linkedinUrl: null, sources: { phone: 'test' } };
      },
      async findConversation() {
        seen.push('heyreach');
        return { messages: [{ role: 'them', body: 'Thursday still works on LinkedIn.', createdAt: '2026-10-25T12:00:00.000Z' }] };
      },
      async searchCalls() {
        seen.push('allo');
        return [{ summary: 'They asked for a Thursday walkthrough.', start_date: '2026-10-28T15:00:00.000Z' }];
      },
      async fetchSiteText() {
        seen.push('site');
        return 'Northwind Roofing Co. We handle commercial roofing for property managers across north Texas.';
      },
      async searchTranscripts(keyword) {
        seen.push('fireflies');
        assert.match(String(keyword), /Northwind/);
        return [];
      },
    };
    const row = meeting({
      lead_phone: '',
      linkedin_url: '',
      reply_linkedin: '',
      lead_title: '',
      lead_location: '',
      lead_website: '',
      inbound_message: '',
      sent_reply: '',
      thread_context: null,
      icp_verdict: null,
      campaign_id: '99',
      lead_id: '88',
    });
    const steps = ['thread', 'lead', 'profile', 'phone', 'heyreach', 'allo', 'site', 'fireflies'];
    const preview = await previewBrief({ meetingId: 'meet-1', store: memoryStore({ meetings: [row] }), env: env(), deps });
    assert.equal(preview.body.dry_run, true);
    assert.equal(preview.body.sent, false);
    assert.equal(preview.body.queued, false);
    assert.equal(preview.body.zero_context, false);
    const text = preview.body.text_body;
    assert.match(text, /Why you're meeting/);
    assert.match(text, /\bInfo\b/);
    assert.match(text, /Thursday still works on LinkedIn/);
    assert.match(text, /Thursday walkthrough/);
    assert.match(text, /commercial roofing/);
    assert.match(text, /555-0199/);
    assert.match(text, /jordan-hale-example/);
    assert.match(text, /Easy openers/);
    assert.match(text, /No prior Fireflies transcripts mention/);
    assert.equal(text.includes('Source campaign'), false);
    assert.equal(text.includes('LTV'), false);
    for (const step of steps) assert.equal(seen.includes(step), true, step);
    seen.length = 0;
    const held = await runClientDayofBriefs({
      env: env(),
      store: memoryStore({ meetings: [row] }),
      now: NOW,
      deps,
      send: async () => { throw new Error('client mail'); },
      fetchImpl: async () => ({ ok: true, status: 200 }),
    });
    assert.equal(held.held, 1);
    assert.equal(held.sent, 0);
    for (const step of steps) assert.equal(seen.includes(step), true, `hold ${step}`);
  });

  it('preview renders a meeting and does not queue or send it', async () => {
    const store = memoryStore({ meetings: [meeting()] });
    const out = await previewBrief({ meetingId: 'meet-1', store, env: env() });
    assert.equal(out.body.dry_run, true);
    assert.equal(out.body.sent, false);
    assert.equal(out.body.queued, false);
    assert.match(out.body.subject, /Jordan Hale/);
    assert.deepEqual(out.body.to, [VECTOR]);
    assert.deepEqual(out.body.cc, [JOSH]);
    assert.equal(store.briefs.length, 0);
    const missing = await previewBrief({ meetingId: 'nope', store, env: env() });
    assert.equal(missing.status, 404);
  });

  it('a meeting 121 minutes out is not held', async () => {
    const store = memoryStore({ meetings: [meeting()] });
    const result = await runClientDayofBriefs({
      env: env(),
      store,
      now: new Date(START.getTime() - 121 * 60 * 1000),
      send: async () => { throw new Error('should not send'); },
      fetchImpl: async () => { throw new Error('should not notify'); },
    });
    assert.equal(result.held, 0);
    assert.equal(store.briefs.length, 0);
  });

  it('the reviewer email is not the client email', async () => {
    const store = memoryStore({ meetings: [meeting()] });
    const sent = [];
    await runClientDayofBriefs({
      env: env({ REVIEW_NOTIFY: 'ea-bot@example.com' }),
      store,
      now: NOW,
      send: async (m) => sent.push(m),
    });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, ['ea-bot@example.com']);
    assert.match(sent[0].subject, /^\[Client brief review\]/);
    assert.match(sent[0].textBody, /HELD FOR REVIEW/);
    assert.match(sent[0].textBody, /\/admin\/client-briefs\/brief-1\/release/);
    assert.match(sent[0].textBody, /\/admin\/client-briefs\/brief-1\/block/);
    assert.match(sent[0].htmlBody, /Enrich/);
    assert.equal(store.briefs[0].status, 'held');
  });

  it('the review email subject starts with the fixed client brief review tag', async () => {
    const store = memoryStore({ meetings: [meeting()] });
    const sent = [];
    await runClientDayofBriefs({
      env: env({ REVIEW_NOTIFY: 'ea-bot@example.com' }),
      store,
      now: NOW,
      send: async (m) => sent.push(m),
    });
    const subject = sent[0].subject;
    assert.equal(subject.startsWith(REVIEW_SUBJECT_TAG), true);
    assert.match(subject, /^\[Client brief review\] Jordan Hale, Northwind Roofing Co\. @ 9:30am CT$/);
    assert.match(sent[0].textBody, /Jordan Hale/);
    assert.match(sent[0].textBody, /Release:/);
    assert.match(sent[0].textBody, /Enrich:/);
    assert.match(sent[0].textBody, /Block:/);
    assert.equal(reviewEmailSubject(store.briefs[0]), subject);
  });
});

describe('day-of brief stays off the prospect send path', () => {
  it('reply-send does not build or send client briefs', () => {
    const send = fs.readFileSync(path.join(__dirname, '../src/services/reply-send.js'), 'utf8');
    const admin = fs.readFileSync(path.join(__dirname, '../src/routes/admin.js'), 'utf8');
    const cron = fs.readFileSync(path.join(__dirname, '../src/cron.js'), 'utf8');
    assert.doesNotMatch(send, /client-dayof-brief|REVIEW_NOTIFY|CLIENT_DAYOF_BRIEF/);
    assert.match(send, /stripClientSendAddresses/);
    assert.match(admin, /\/admin\/client-briefs\/pending/);
    assert.match(admin, /\/admin\/client-briefs\/:id\/release/);
    assert.match(admin, /\/admin\/client-briefs\/:id\/block/);
    assert.match(admin, /\/admin\/client-briefs\/preview/);
    assert.match(admin, /\/admin\/client-meetings\/upcoming/);
    assert.match(admin, /\/admin\/client-brief\/send/);
    assert.doesNotMatch(admin, /requireAdminApiKey/);
    assert.match(cron, /dayofBriefEnabled/);
    assert.match(cron, /dayofBriefWriterEnabled/);
    const envExample = fs.readFileSync(path.join(__dirname, '../docs/.env.example'), 'utf8');
    assert.match(envExample, /^REVIEW_NOTIFY=salesglider-briefs@mail\.grokbot\.com$/m);
    assert.match(envExample, /CLIENT_DAYOF_BRIEF_WRITER_ENABLED=false/);
  });
});

const WINDOW_FROM = '2026-10-31T00:00:00.000Z';
const WINDOW_TO = '2026-11-01T00:00:00.000Z';
const GOOD_SUBJECT = 'Brief: Jordan Hale and Vector @ 9:30am CT';
const GOOD_HTML = [
  '<div>',
  '<h3>Who</h3><ul><li>Jordan Hale, VP of Operations, Northwind Roofing Co.</li>',
  '<li>jordan.hale@northwind-roofing.example</li></ul>',
  '<h3>Why you\'re meeting</h3><ul><li>They asked: Can you walk us through pricing?</li></ul>',
  '</div>',
].join('');

describe('EA upcoming meetings and send', () => {
  function upcomingStore() {
    return memoryStore({
      meetings: [
        meeting({
          status: 'booked',
          calendar_provider: 'allo',
          campaign_id: 4242,
          lead_id: 'lead-88',
          thread_context: {
            history: [{
              type: 'REPLY',
              email_body: 'Thursday works. Can you walk us through pricing?',
              time: '2026-10-28T15:00:00.000Z',
            }],
          },
        }),
        meeting({
          id: 'meet-sg',
          client_id: 'client-sg',
          client_name: 'SalesGlider',
          status: 'confirmed',
          calendar_provider: 'google',
          meeting_link: 'https://tidycal.com/example/intro',
          lead_name: 'Casey Example',
          lead_full_name: 'Casey Example',
          lead_email: 'casey.example@harbor-logistics.example',
          lead_company: 'Harbor Logistics',
          inbound_message: 'Tuesday is fine.',
          sent_reply: '',
          pending_reply_id: 'reply-sg',
        }),
        meeting({
          id: 'meet-cal',
          status: 'booked',
          calendar_provider: 'calendly',
          meeting_link: 'https://calendly.com/example/intro',
          lead_name: 'Riley Example',
          lead_full_name: 'Riley Example',
          lead_email: 'riley.example@northwind-roofing.example',
        }),
        meeting({ id: 'meet-later', status: 'booked', confirmed_time: '2026-11-02T14:30:00.000Z' }),
        meeting({
          id: 'meet-stamp',
          status: 'booked',
          confirmed_time: '2026-10-31T15:00:00.000Z',
          created_at: '2026-10-31T15:00:30.000Z',
        }),
        meeting({ id: 'meet-edge', status: 'booked', confirmed_time: WINDOW_TO }),
        meeting({ id: 'meet-no', status: 'cancelled' }),
      ],
      clients: {
        'client-vector': {
          id: 'client-vector',
          name: 'Vector',
          notify_emails: `${VECTOR}, ops@vectorenergygroup.example`,
          digest_timezone: 'America/Chicago',
          icp_profile: {
            industries: ['commercial roofing'],
            titles: ['Owner', 'Director of Facilities'],
            company_size: ['20-200'],
          },
        },
        'client-sg': {
          id: 'client-sg',
          name: 'SalesGlider',
          notify_emails: 'ops@salesglidergrowth.example',
          digest_timezone: 'America/Chicago',
          icp_profile: null,
          icp_status: 'ready',
        },
      },
    });
  }

  it('lists upcoming meetings from the client record', async () => {
    const missing = await listUpcomingMeetings({ store: memoryStore(), from: '', to: WINDOW_TO });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'from_to_required');
    const wide = await listUpcomingMeetings({
      store: memoryStore(),
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-12-15T00:00:00.000Z',
    });
    assert.equal(wide.body.error, 'window_too_wide');

    const store = upcomingStore();
    const out = await listUpcomingMeetings({ store, from: WINDOW_FROM, to: WINDOW_TO });
    assert.equal(out.status, 200);
    const ids = out.body.meetings.map((m) => m.meeting_id);
    assert.deepEqual(ids, ['meet-1', 'meet-sg', 'meet-cal']);

    const row = out.body.meetings[0];
    assert.equal(row.client_id, 'client-vector');
    assert.equal(row.client_name, 'Vector');
    assert.deepEqual(row.notify_emails, [VECTOR, 'ops@vectorenergygroup.example']);
    assert.equal(row.prospect_name, 'Jordan Hale');
    assert.equal(row.prospect_email, 'jordan.hale@northwind-roofing.example');
    assert.equal(row.prospect_company, 'Northwind Roofing Co.');
    assert.equal(row.meeting_time, '2026-10-31T09:30:00-05:00');
    assert.equal(row.timezone, 'America/Chicago');
    assert.equal(row.meeting_link, 'https://us06web.zoom.us/j/00000000000');
    assert.equal(row.booking_source, 'allo');
    assert.equal(row.campaign_id, '4242');
    assert.equal(row.lead_id, 'lead-88');
    assert.equal(row.thread_id, 'reply-1');
    assert.equal(row.brief_sent, false);
    assert.ok(row.thread_messages.some((m) => /walk us through pricing/.test(m.body)));
    assert.deepEqual(row.icp.titles, ['Owner', 'Director of Facilities']);
    assert.deepEqual(row.decision_maker_titles, ['Owner', 'Director of Facilities']);
    assert.equal(row.decision_maker_titles.includes('Head of Growth'), false);

    const plain = out.body.meetings[1];
    assert.equal(plain.client_name, 'SalesGlider');
    assert.equal(plain.booking_source, 'tidycal');
    assert.equal(plain.icp, null);
    assert.equal(plain.decision_maker_titles, null);
    assert.equal(out.body.meetings[2].booking_source, 'calendly');

    store.briefs.push({
      id: 'brief-sent', meeting_id: 'meet-1', status: 'released', sent_at: 'sent', send_error: null,
    });
    const again = await listUpcomingMeetings({ store, from: WINDOW_FROM, to: WINDOW_TO });
    assert.equal(again.body.meetings[0].brief_sent, true);
  });

  it('sends EA html once and refuses an empty, zero-context, internal, or duplicate brief', async () => {
    const store = memoryStore({ meetings: [meeting({ status: 'booked' })] });
    const sent = [];
    const send = async (m) => sent.push(m);
    const off = await sendClientBrief(
      { meetingId: 'meet-1', subject: GOOD_SUBJECT, html: GOOD_HTML },
      { store, env: { CLIENT_DAYOF_BRIEF_ENABLED: 'false' }, send },
    );
    assert.equal(off.status, 409);
    assert.equal(off.body.error, 'flag_off');
    assert.equal(off.body.sent, false);
    assert.equal(store.briefs.length, 0);
    assert.equal(sent.length, 0);

    const empty = await sendClientBrief(
      { meetingId: 'meet-1', subject: GOOD_SUBJECT, html: '   ' },
      { store, env: env(), send },
    );
    assert.equal(empty.body.error, 'empty');
    assert.equal(store.briefs.length, 0);

    const thin = await sendClientBrief(
      { meetingId: 'meet-1', subject: GOOD_SUBJECT, html: '<p>Jordan Hale</p>' },
      { store, env: env(), send },
    );
    assert.equal(thin.status, 409);
    assert.equal(thin.body.error, 'zero_context');
    assert.equal(store.briefs.length, 0);

    for (const html of [
      '<p>Northwind Roofing Co. Should clear the LTV bar before the call.</p>',
      '<p>Northwind Roofing Co. He unsubscribed from the sequence.</p>',
      '<p>Northwind Roofing Co. Our pricing is $2,000 per month.</p>',
      '<p>Northwind Roofing Co. Smartlead shows the thread.</p>',
    ]) {
      const refused = await sendClientBrief(
        { meetingId: 'meet-1', subject: GOOD_SUBJECT, html },
        { store, env: env(), send },
      );
      assert.equal(refused.status, 400, html);
      assert.equal(refused.body.error, 'internal_content', html);
      assert.equal(sent.length, 0);
    }
    assert.equal(store.briefs.length, 0);

    const ok = await sendClientBrief(
      { meetingId: 'meet-1', subject: GOOD_SUBJECT, html: GOOD_HTML },
      { store, env: env(), send },
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.body.sent, true);
    assert.deepEqual(ok.body.to, [VECTOR]);
    assert.deepEqual(ok.body.cc, [JOSH]);
    assert.match(sent[0].htmlBody, /walk us through pricing/);
    assert.equal(sent[0].htmlBody.includes('LTV'), false);
    assert.equal(store.briefs[0].sent_at, 'sent');
    assert.equal(store.briefs[0].facts.writer, 'ea');

    const dup = await sendClientBrief(
      { meetingId: 'meet-1', subject: GOOD_SUBJECT, html: GOOD_HTML },
      { store, env: env(), send },
    );
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, 'already_sent');
    assert.equal(sent.length, 1);

    const missing = await sendClientBrief(
      { meetingId: 'missing', subject: GOOD_SUBJECT, html: GOOD_HTML },
      { store, env: env(), send },
    );
    assert.equal(missing.status, 404);
  });

  it('does not write a brief on the cron unless the writer flag is on', async () => {
    const store = memoryStore({ meetings: [meeting()] });
    const sent = [];
    const quiet = await runClientDayofBriefs({
      env: { CLIENT_DAYOF_BRIEF_ENABLED: 'true' },
      store,
      now: NOW,
      send: async (m) => sent.push(m),
    });
    assert.equal(quiet.enabled, true);
    assert.equal(quiet.writer, false);
    assert.equal(quiet.held, 0);
    assert.equal(store.briefs.length, 0);
    assert.equal(sent.length, 0);

    store.briefs.push({
      id: 'brief-ready',
      meeting_id: 'meet-1',
      client_id: 'client-vector',
      status: 'released',
      sent_at: null,
      send_error: null,
      subject: GOOD_SUBJECT,
      html_body: GOOD_HTML,
      text_body: 'Northwind Roofing Co. They asked for a walkthrough.',
      facts: {
        how: { source: 'Email' },
        company: { name: 'Northwind Roofing Co.' },
        openItems: ['walkthrough'],
      },
    });
    const tick = await runClientDayofBriefs({
      env: { CLIENT_DAYOF_BRIEF_ENABLED: 'true' },
      store,
      now: NOW,
      send: async (m) => sent.push(m),
    });
    assert.equal(tick.held, 0);
    assert.equal(tick.sent, 1);
    assert.equal(sent[0].to[0], VECTOR);
    assert.deepEqual(sent[0].cc, [JOSH]);
  });

  it('does not call the brief writer unless its flag is on', async () => {
    let calls = 0;
    const fetchImpl = async (url) => {
      if (/anthropic|openrouter/i.test(String(url))) calls += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ content: [{ type: 'text', text: 'not json' }] }),
      };
    };
    const row = meeting({ lead_location: 'Dallas, TX' });
    await gatherBriefFacts(row, {
      env: { ANTHROPIC_API_KEY: 'test-key', OPENROUTER_API_KEY: 'test-key' },
      fetchImpl,
    });
    assert.equal(calls, 0);
    await gatherBriefFacts(row, {
      env: {
        CLIENT_DAYOF_BRIEF_WRITER_ENABLED: 'true',
        ANTHROPIC_API_KEY: 'test-key',
      },
      fetchImpl,
    });
    assert.equal(calls, 1);
  });
});
