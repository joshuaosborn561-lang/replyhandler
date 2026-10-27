const test = require('node:test');
const assert = require('node:assert');
const time = require('../src/utils/followup-sequence-time');
const text = require('../src/utils/followup-sequence-text');
const copy = require('../src/services/followup-sequence-copy');
const { callNowDraft } = require('../src/utils/call-now-variant');

const TZ = 'America/Chicago';

// ─── time ────────────────────────────────────────────────────────────────────

test('call hours are the lead local Mon-Fri 9-5 by default', () => {
  assert.equal(time.inCallWindow(new Date('2026-10-27T15:00:00Z'), TZ), true, 'Tue 10am CT');
  assert.equal(time.inCallWindow(new Date('2026-10-27T13:30:00Z'), TZ), false, 'Tue 8:30am CT');
  assert.equal(time.inCallWindow(new Date('2026-10-27T22:00:00Z'), TZ), false, 'Tue 5pm CT');
  assert.equal(time.inCallWindow(new Date('2026-10-31T17:00:00Z'), TZ), false, 'Saturday');
  // Same instant, different lead zone: 10am CT is 8am PT, outside the window there.
  assert.equal(time.inCallWindow(new Date('2026-10-27T15:00:00Z'), 'America/Los_Angeles'), false);
});

test('next call window rolls over nights and weekends', () => {
  assert.equal(time.nextCallWindowStart(new Date('2026-10-27T23:00:00Z'), TZ).toISOString(), '2026-10-28T14:00:00.000Z');
  assert.equal(time.nextCallWindowStart(new Date('2026-10-30T23:00:00Z'), TZ).toISOString(), '2026-11-02T15:00:00.000Z', 'Fri night -> Mon 9am (CST after DST ends)');
  assert.equal(time.nextCallWindowStart(new Date('2026-10-27T10:00:00Z'), TZ).toISOString(), '2026-10-27T14:00:00.000Z', 'before 9am same day');
});

test('invalid lead time zone falls back to the client zone, then Central', () => {
  assert.equal(time.resolveTimeZone('Mars/Base', 'America/New_York'), 'America/New_York');
  assert.equal(time.resolveTimeZone(null, ''), 'America/Chicago');
});

test('plan counts business days, never weekends', () => {
  // Friday 3pm CT reply.
  const steps = time.planSequence({ enrolledAt: new Date('2026-10-30T20:00:00Z'), timeZone: TZ });
  const by = Object.fromEntries(steps.map((s) => [s.kind, s]));
  const day = (d) => time.zonedParts(d, TZ);
  assert.equal(day(by.call_day0.due).weekday, 'Fri');
  assert.equal(day(by.call_day1.due).weekday, 'Mon', 'Day 1 is the next business day');
  assert.equal(day(by.call_day3.due).weekday, 'Wed');
  assert.equal(day(by.email_breakup.due).weekday, 'Fri', 'Day 5');
  assert.equal(day(by.call_day6.due).weekday, 'Mon', 'Day 6');
  for (const s of steps.filter((x) => x.type === 'call' && x.due)) {
    assert.equal(time.inCallWindow(s.due, TZ), true, `${s.kind} lands inside call hours`);
  }
});

test('weekend reply starts on Monday', () => {
  const steps = time.planSequence({ enrolledAt: new Date('2026-10-31T15:00:00Z'), timeZone: TZ });
  const d0 = steps.find((s) => s.kind === 'call_day0').due;
  assert.equal(time.zonedParts(d0, TZ).weekday, 'Mon');
  assert.equal(time.zonedParts(d0, TZ).hour, 9);
});

test('Day 1 call is at a different time of day than Day 0, Day 3 differs from Day 1', () => {
  const am = time.planSequence({ enrolledAt: new Date('2026-10-27T15:00:00Z'), timeZone: TZ });
  assert.equal(time.zonedParts(am.find((s) => s.kind === 'call_day1').due, TZ).hour, 14, 'morning Day 0 -> afternoon Day 1');
  assert.equal(time.zonedParts(am.find((s) => s.kind === 'call_day3').due, TZ).hour, 10, 'afternoon Day 1 -> morning Day 3');
  const pm = time.planSequence({ enrolledAt: new Date('2026-10-27T19:00:00Z'), timeZone: TZ });
  assert.equal(time.zonedParts(pm.find((s) => s.kind === 'call_day1').due, TZ).hour, 10, 'afternoon Day 0 -> morning Day 1');
  assert.equal(time.zonedParts(pm.find((s) => s.kind === 'call_day3').due, TZ).hour, 14);
});

test('second Day 0 call is 3-4 hours after the first, same local day, or skipped', () => {
  const mid = time.planSequence({ enrolledAt: new Date('2026-10-27T15:00:00Z'), timeZone: TZ });
  const first = mid.find((s) => s.kind === 'call_day0').due;
  const late = mid.find((s) => s.kind === 'call_day0_late').due;
  const hrs = (late - first) / 3600000;
  assert.ok(hrs >= 3 && hrs <= 4, `gap ${hrs}h`);
  const evening = time.planSequence({ enrolledAt: new Date('2026-10-27T21:30:00Z'), timeZone: TZ });
  const e = evening.find((s) => s.kind === 'call_day0_late');
  assert.equal(e.due, null);
  assert.equal(e.skip, 'outside_call_hours');
});

test('plan covers every spec step exactly once, calls and emails typed', () => {
  const kinds = time.planSequence({ enrolledAt: new Date('2026-10-27T15:00:00Z'), timeZone: TZ }).map((s) => `${s.type}:${s.kind}`);
  assert.deepEqual(kinds, [
    'call:call_day0', 'call:call_day0_late', 'call:call_day1', 'email:email_day1',
    'call:call_day3', 'email:email_proof', 'email:email_thoughts', 'email:email_breakup', 'call:call_day6',
  ]);
});

// ─── text ────────────────────────────────────────────────────────────────────

const args = { firstName: 'Pat', callerName: 'Gabe', clientName: 'Acme Co', offerLine: 'cutting your IT costs' };

test('call script is the exact spec line', () => {
  assert.equal(
    text.callScript(args),
    'Hey Pat, this is Gabe with Acme Co. We emailed you about cutting your IT costs. Did you still want to take a peek at that in the next couple days?',
  );
});

test('missing offer never invents one', () => {
  const s = text.callScript({ ...args, offerLine: null });
  assert.ok(s.includes(text.OFFER_MISSING));
});

test('voicemails: Day 0, Day 3 and Day 6 leave one; the other calls leave none', () => {
  assert.ok(text.voicemailScript('call_day0', args));
  assert.equal(text.voicemailScript('call_day0_late', args), null);
  assert.equal(text.voicemailScript('call_day1', args), null);
  const d3 = text.voicemailScript('call_day3', args);
  assert.ok(/calling about cutting your IT costs/.test(d3));
  assert.ok(/one more email/.test(d3) && /if you're still interested/i.test(d3) && /scheduled/.test(d3));
  assert.ok(/sent you an email/.test(text.voicemailScript('call_day6', args)));
});

test('email bodies match the spec wording', () => {
  const slots = [{ label: 'Wed, Oct 28, 11:00 AM CDT' }, { label: 'Thu, Oct 29, 2:00 PM CDT' }];
  const vm = text.emailBody('email_vm', { firstName: 'Pat', slots, link: '' });
  assert.ok(vm.startsWith('Hey Pat, just tried you and left you a voicemail.'));
  assert.ok(vm.includes('Wed, Oct 28, 11:00 AM CDT') && vm.includes('Thu, Oct 29, 2:00 PM CDT'));
  const d1 = text.emailBody('email_day1', { firstName: 'Pat', slots, link: '' });
  assert.ok(/those times got taken/i.test(d1) && d1.includes('Thu, Oct 29, 2:00 PM CDT'));
  assert.equal(text.emailBody('email_thoughts', { firstName: 'Pat' }), 'Hey Pat, any thoughts?');
  assert.equal(
    text.emailBody('email_breakup', { firstName: 'Pat' }),
    "Hey Pat, don't want to keep emailing you. Did you still want to meet about this, or have priorities changed?",
  );
});

test('time emails are held (null) with no live times and no link; never made up', () => {
  assert.equal(text.emailBody('email_vm', { firstName: 'Pat', slots: [], link: '' }), null);
  assert.equal(text.emailBody('email_day1', { firstName: 'Pat', slots: [], link: '' }), null);
  assert.ok(text.emailBody('email_vm', { firstName: 'Pat', slots: [], link: '', askForTimes: true }));
  assert.ok(text.emailBody('email_vm', { firstName: 'Pat', slots: [], link: 'https://cal.example/x' }).includes('https://cal.example/x'));
});

test('proof email needs a proof point', () => {
  assert.equal(text.emailBody('email_proof', { firstName: 'Pat', proofPoint: '' }), null);
  assert.ok(text.emailBody('email_proof', { firstName: 'Pat', proofPoint: 'We cut costs 40%.' }).includes('We cut costs 40%.'));
});

// ─── offer + proof validation ────────────────────────────────────────────────

const COPY = 'Hi {{first_name}}, we help MSPs book more meetings. Last quarter we booked 212 meetings for 14 clients. No long contracts. We also guarantee results.';

test('proof must be a verbatim sentence with a real number', () => {
  const ok = copy.validateExtraction(COPY, { offer_line: 'booking more meetings for MSPs', proof_point: 'Last quarter we booked 212 meetings for 14 clients.' });
  assert.equal(ok.proofPoint, 'Last quarter we booked 212 meetings for 14 clients.');
  assert.equal(ok.offerLine, 'booking more meetings for MSPs');

  const paraphrase = copy.validateExtraction(COPY, { proof_point: 'We booked over 200 meetings for clients.' });
  assert.equal(paraphrase.proofPoint, null);
  assert.ok(paraphrase.reasons.includes('proof_not_verbatim'));

  const vague = copy.validateExtraction(COPY, { proof_point: 'We also guarantee results.' });
  assert.equal(vague.proofPoint, null);
  assert.ok(vague.reasons.includes('proof_no_number'));

  const merge = copy.validateExtraction('Hi {{first_name}}, {{company}} saw 40% growth.', { proof_point: '{{company}} saw 40% growth.' });
  assert.equal(merge.proofPoint, null);
});

test('offer line cannot carry a number the copy never states', () => {
  const r = copy.validateExtraction(COPY, { offer_line: 'booking 500 meetings a month for MSPs' });
  assert.equal(r.offerLine, null);
  assert.ok(r.reasons.includes('offer_number_not_in_copy'));
  const two = copy.validateExtraction(COPY, { offer_line: 'booking meetings. Then more.' });
  assert.equal(two.offerLine, null);
});

test('"We emailed you about" prefix and trailing period are stripped from the offer', () => {
  const r = copy.validateExtraction(COPY, { offer_line: 'We emailed you about booking more meetings for MSPs.' });
  assert.equal(r.offerLine, 'booking more meetings for MSPs');
});

test('extractFromCopy: model output is validated, garbage is rejected, no copy means nothing', async () => {
  const good = await copy.extractFromCopy(COPY, {
    llm: async () => '```json\n{"offer_line":"booking more meetings for MSPs","proof_point":"Last quarter we booked 212 meetings for 14 clients."}\n```',
  });
  assert.equal(good.proofPoint, 'Last quarter we booked 212 meetings for 14 clients.');
  const invented = await copy.extractFromCopy(COPY, {
    llm: async () => '{"offer_line":"booking meetings","proof_point":"We booked 300 meetings last month."}',
  });
  assert.equal(invented.proofPoint, null);
  assert.equal((await copy.extractFromCopy(COPY, { llm: async () => 'no idea' })).reasons[0], 'llm_unparseable');
  assert.equal((await copy.extractFromCopy('', { llm: async () => '{}' })).reasons[0], 'no_copy');
});

test('lead-thread fallback reads only the outbound mail before the first reply', () => {
  const tc = { history: [
    { type: 'SENT', email_body: '<p>We booked 212 meetings.</p>' },
    { type: 'REPLY', email_body: 'sure' },
    { type: 'SENT', email_body: 'Our reply with an invented 99% claim' },
  ] };
  const out = copy.copyFromThreadContext('smartlead', tc);
  assert.ok(out.includes('212 meetings'));
  assert.ok(!out.includes('99%'));
  const hr = copy.copyFromThreadContext('heyreach', { messages: [
    { role: 'us', message: 'Intro 40% lift' }, { role: 'them', message: 'ok' }, { role: 'us', message: 'later 77%' }] });
  assert.ok(hr.includes('40%') && !hr.includes('77%'));
});

// ─── call-now draft ties into the sequence flag ──────────────────────────────

const lead = { mobilePhone: '+15555550100', classification: 'INTERESTED', draft: 'long', status: 'pending', leadName: 'pat smith', createdAt: '2026-10-27T15:00:00Z' };

test('calling-you-now is the standing Day 0 reply only with the flag on and inside call hours', () => {
  const on = { FOLLOWUP_SEQUENCE_ENABLED: 'true' };
  assert.equal(callNowDraft({ ...lead, leadTimezone: TZ, now: new Date('2026-10-27T15:30:00Z') }, on), 'Hey Pat, calling you now.');
  assert.equal(callNowDraft({ ...lead, leadTimezone: TZ, now: new Date('2026-10-27T23:30:00Z') }, on), null, 'after hours: no promise to call');
  assert.equal(callNowDraft({ ...lead, mobilePhone: null, leadTimezone: TZ, now: new Date('2026-10-27T15:30:00Z') }, on), null, 'no phone');
  assert.equal(callNowDraft({ ...lead, leadTimezone: TZ, now: new Date('2026-10-27T15:30:00Z') }, {}), null, 'flag off: unchanged');
});

// ─── holidays ────────────────────────────────────────────────────────────────

test('major US holidays are not business days (observed dates)', () => {
  const h = (y, m, d) => time.isHoliday({ year: y, month: m, day: d });
  assert.equal(h(2026, 11, 26), true, 'Thanksgiving');
  assert.equal(h(2026, 11, 27), true, 'day after Thanksgiving');
  assert.equal(h(2026, 12, 25), true, 'Christmas');
  assert.equal(h(2026, 5, 25), true, 'Memorial Day');
  assert.equal(h(2026, 9, 7), true, 'Labor Day');
  assert.equal(h(2027, 1, 1), true, "New Year's Day");
  assert.equal(h(2026, 7, 3), true, 'July 4 is a Saturday in 2026: observed Friday');
  assert.equal(h(2026, 7, 4), false);
  assert.equal(h(2027, 12, 31), true, "New Year's 2028 is a Saturday: observed Dec 31");
  assert.equal(h(2026, 11, 25), false, 'day before Thanksgiving is a normal day');
  assert.equal(h(2026, 10, 27), false);
});

test('business-day counting skips holidays', () => {
  // Reply Mon Nov 23, 2026: Day 1 Tue, Day 2 Wed, Day 3 skips Thanksgiving + Friday + the weekend.
  const steps = time.planSequence({ enrolledAt: new Date('2026-11-23T17:00:00Z'), timeZone: TZ });
  const by = Object.fromEntries(steps.map((s) => [s.kind, s]));
  const ymd = (d) => { const p = time.zonedParts(d, TZ); return `${p.year}-${p.month}-${p.day}`; };
  assert.equal(ymd(by.call_day1.due), '2026-11-24');
  assert.equal(ymd(by.call_day3.due), '2026-11-30', 'Day 3 is the Monday after Thanksgiving weekend');
  assert.equal(ymd(by.email_breakup.due), '2026-12-2', 'Day 5');
  assert.equal(ymd(by.call_day6.due), '2026-12-3', 'Day 6');
});

test('no calls on a holiday, and a holiday reply starts the next business day', () => {
  assert.equal(time.inCallWindow(new Date('2026-11-26T17:00:00Z'), TZ), false, 'Thanksgiving noon CT');
  const next = time.nextCallWindowStart(new Date('2026-11-26T17:00:00Z'), TZ);
  assert.equal(next.toISOString(), '2026-11-30T15:00:00.000Z', 'Mon Nov 30, 9am CST');
  assert.equal(time.inCallWindow(new Date('2026-11-25T17:00:00Z'), TZ), true);
});
