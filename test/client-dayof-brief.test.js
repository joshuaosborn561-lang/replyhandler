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
  leadMinutes,
  usableMeetingStart,
  briefIsDue,
  clientBriefRecipients,
  assembleBriefFacts,
  hasZeroContext,
  buildClientDayofBrief,
  exampleClientBrief,
  runClientDayofBriefs,
  previewBrief,
  releaseBrief,
  blockBrief,
  listPendingBriefs,
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
  };
  return api;
}

function env(over = {}) {
  return {
    CLIENT_DAYOF_BRIEF_ENABLED: 'true',
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
    for (const section of ['Who', 'ICP fit', 'LinkedIn', 'Email thread', 'Call history', 'Source campaign', 'About Northwind Roofing Co.', 'Open items', 'Flags']) {
      assert.match(sample.textBody, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(sample.htmlBody, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.match(sample.subject, /^Brief: Jordan Hale @ 9:30am CT$/);
    assert.match(sample.htmlBody, /<h3>Jordan Hale, Northwind Roofing Co\. \|/);
    assert.match(sample.htmlBody, /font-family:Arial,sans-serif;font-size:14px/);
    assert.match(sample.textBody, /jordan\.hale@northwind-roofing\.example/);
    assert.match(sample.textBody, /\(214\) 555-0148/);
    assert.match(sample.textBody, /Rockwall, TX/);
    assert.match(sample.textBody, /jordan-hale-example/);
    assert.match(sample.textBody, /northwind-roofing\.example/);
    assert.match(sample.textBody, /Spring owners, north Texas/);
    assert.match(sample.textBody, /walk us through pricing/);
    assert.match(sample.htmlBody, /<b>Who<\/b>/);
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
    assert.match(facts.flags.icpFit, /qualified/);
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
    assert.match(brief.textBody, /LinkedIn/);
    assert.equal(brief.textBody.includes('Email thread'), false);
    assert.match(brief.textBody, /Owners, LinkedIn/);
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
    const steps = ['thread', 'lead', 'profile', 'phone', 'heyreach', 'allo', 'site'];
    const preview = await previewBrief({ meetingId: 'meet-1', store: memoryStore({ meetings: [row] }), env: env(), deps });
    assert.equal(preview.body.dry_run, true);
    assert.equal(preview.body.sent, false);
    assert.equal(preview.body.queued, false);
    assert.equal(preview.body.zero_context, false);
    const text = preview.body.text_body;
    assert.match(text, /Email thread/);
    assert.match(text, /\bInfo\b/);
    assert.match(text, /ICP fit: not on file/);
    assert.match(text, /Thursday still works on LinkedIn/);
    assert.match(text, /Thursday walkthrough/);
    assert.match(text, /commercial roofing/);
    assert.match(text, /555-0199/);
    assert.match(text, /jordan-hale-example/);
    assert.match(text, /Spring owners/);
    assert.match(text, /Open items/);
    assert.match(text, /Source campaign/);
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
    assert.doesNotMatch(admin, /requireAdminApiKey/);
    assert.match(cron, /dayofBriefEnabled/);
    const envExample = fs.readFileSync(path.join(__dirname, '../docs/.env.example'), 'utf8');
    assert.match(envExample, /^REVIEW_NOTIFY=salesglider-briefs@mail\.grokbot\.com$/m);
  });
});
