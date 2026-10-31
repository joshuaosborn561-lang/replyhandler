const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const ms = require('../src/services/meetstream-attendance');

const KEYS = ['MEETSTREAM_ATTENDANCE_ENABLED', 'MEETSTREAM_ATTENDANCE_SCOPE'];

describe('meetstream attendance: flags and scope', () => {
  it('is off by default and josh_only by default', () => {
    assert.equal(ms.enabled({}), false);
    assert.equal(ms.scopeSetting({}), 'josh_only');
    assert.equal(ms.scopeSetting({ MEETSTREAM_ATTENDANCE_SCOPE: 'nonsense' }), 'josh_only');
  });

  it('josh_only never allows a client meeting', () => {
    const env = { MEETSTREAM_ATTENDANCE_SCOPE: 'josh_only' };
    assert.equal(ms.scopeAllows('josh', env), true);
    assert.equal(ms.scopeAllows('client', env), false);
    assert.equal(ms.scopeAllows('client', {}), false);
  });

  it('clients and all widen the scope', () => {
    assert.equal(ms.scopeAllows('client', { MEETSTREAM_ATTENDANCE_SCOPE: 'clients' }), true);
    assert.equal(ms.scopeAllows('josh', { MEETSTREAM_ATTENDANCE_SCOPE: 'clients' }), false);
    assert.equal(ms.scopeAllows('josh', { MEETSTREAM_ATTENDANCE_SCOPE: 'all' }), true);
  });

  it('does nothing when disabled', async () => {
    const r = await ms.runAttendanceTick({ env: {} });
    assert.deepEqual(r, { created: 0, evaluated: 0, decided: 0, expired: 0, capped: 0, hardStopped: 0 });
  });
  void KEYS;
});

describe('meetstream attendance: bot payload is silent and named Attendance', () => {
  const env = { MEETSTREAM_WEBHOOK_TOKEN: 'tok', MEETSTREAM_PUBLIC_URL: 'https://example.test' };
  const p = ms.createBotPayload({ id: 'row1', scope: 'josh', meeting_url: 'https://meet.google.com/abc-defg-hij' }, ms.config(env), env);

  it('uses the exact bot name', () => {
    assert.equal(p.bot_name, 'Attendance');
    assert.equal(ms.BOT_NAME, 'Attendance');
  });

  it('records nothing', () => {
    assert.equal(p.audio_required, false);
    assert.equal(p.video_required, false);
    assert.equal(p.audio_separate_streams, false);
    assert.equal(p.video_separate_streams, false);
    assert.equal(p.recording_config.transcript, undefined);
    assert.equal(p.live_transcription_required, undefined);
    assert.equal(p.live_audio_required, undefined);
    assert.equal(p.bot_message, undefined);
    assert.equal(p.recording_config.retention.hours, 1);
  });

  it('webhooks go to our token path and dedupe on the row id', () => {
    assert.equal(p.callback_url, 'https://example.test/webhook/meetstream/tok');
    assert.equal(p.deduplication_key, 'rh-attendance-row1');
    assert.deepEqual(p.recording_config.realtime_endpoints[0].events, ['participant_events.join', 'participant_events.leave']);
  });
});

describe('meetstream attendance: platform and cost', () => {
  it('detects platforms', () => {
    assert.equal(ms.platformOf('https://meet.google.com/abc-defg-hij'), 'google_meet');
    assert.equal(ms.platformOf('https://us06web.zoom.us/j/123'), 'zoom');
    assert.equal(ms.platformOf('https://teams.microsoft.com/l/meetup-join/x'), 'teams');
    assert.equal(ms.platformOf(''), 'other');
  });

  it('keeps one bot far below the $5 credit', () => {
    const c = ms.estimateCostUsd(ms.config({}));
    assert.ok(c > 0 && c < 0.2, `estimate ${c}`);
    assert.ok(c * ms.config({}).maxBots < 5);
  });
});

describe('meetstream attendance: who counts as the prospect', () => {
  const internal = ['Josh', 'Joshua Osborn'];

  it('host, our bot and other notetakers never count', () => {
    const c = ms.classifyParticipants([
      { displayName: 'Joshua Osborn', humanized_status: 'in_meeting' },
      { displayName: 'Attendance', humanized_status: 'in_meeting' },
      { displayName: 'Fireflies.ai Notetaker', humanized_status: 'in_meeting' },
    ], internal);
    assert.equal(c.prospect, false);
    assert.equal(c.internal, 1);
    assert.equal(c.bots, 2);
  });

  it('a participant who already left still counts as having joined', () => {
    const c = ms.classifyParticipants([
      { displayName: 'Pat Example', humanized_status: 'not_in_meeting' },
    ], internal);
    assert.equal(c.prospect, true);
  });

  it('ignores secondary devices and never stores names in the summary', () => {
    const c = ms.classifyParticipants([
      { displayName: 'Joshua Osborn', humanized_status: 'in_meeting' },
      { displayName: 'Joshua Osborn', parentDeviceId: 'x', humanized_status: 'in_meeting' },
    ], internal);
    assert.equal(c.internal, 1);
    assert.ok(c.summary.every((s) => Object.keys(s).sort().join() === 'role,state'));
  });
});

describe('meetstream attendance: decisions never guess a no-show', () => {
  const start = Date.parse('2026-11-02T20:00:00Z');
  const noShowMs = 10 * 60 * 1000;
  const base = { startsAtMs: start, noShowMs, prospect: false, inMeeting: true, botEnded: false };

  it('showed as soon as a prospect is present', () => {
    assert.equal(ms.decide({ ...base, prospect: true, nowMs: start + 60000 }).status, 'showed');
  });

  it('waits inside the window', () => {
    assert.equal(ms.decide({ ...base, nowMs: start + 5 * 60000 }), null);
  });

  it('no_show only when our bot was in the call through the window', () => {
    assert.equal(ms.decide({ ...base, nowMs: start + noShowMs }).status, 'no_show');
  });

  it('a bot that never got in is unverified, not no_show', () => {
    const d = ms.decide({ ...base, inMeeting: false, botEnded: true, nowMs: start + 60000 });
    assert.equal(d.status, 'unverified');
    const late = ms.decide({ ...base, inMeeting: false, nowMs: start + noShowMs + 6 * 60000 });
    assert.equal(late.status, 'unverified');
  });

  it('a bot that left early is unverified', () => {
    assert.equal(ms.decide({ ...base, botEnded: true, nowMs: start + 120000 }).status, 'unverified');
  });
});

describe('meetstream attendance: webhook token', () => {
  it('rejects a wrong or missing token', () => {
    assert.equal(ms.tokenOk('x', {}), false);
    assert.equal(ms.tokenOk('', { MEETSTREAM_WEBHOOK_TOKEN: 'abc' }), false);
    assert.equal(ms.tokenOk('abd', { MEETSTREAM_WEBHOOK_TOKEN: 'abc' }), false);
    assert.equal(ms.tokenOk('abc', { MEETSTREAM_WEBHOOK_TOKEN: 'abc' }), true);
  });
});

describe('meetstream attendance: host matching is exact', () => {
  it('a prospect who shares a first name with the host still counts', () => {
    const c = ms.classifyParticipants([
      { displayName: 'Joshua Osborn', humanized_status: 'in_meeting' },
      { displayName: 'Josh Smith', humanized_status: 'in_meeting' },
    ], ['Josh', 'Josh Osborn', 'Joshua Osborn']);
    assert.equal(c.prospect, true);
  });
});
