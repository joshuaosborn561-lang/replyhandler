'use strict';

/**
 * The client day-of brief is Josh's brief with a redaction pass on top (Josh, Nov 1 2026).
 * Same builder, same sections in the same order, same lines. Only campaign, mailbox,
 * internal-note and tool-name lines are removed. All people and companies here are synthetic.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  buildJoshDayofBrief,
  buildClientDayofBrief,
  buildClientDayofBriefParts,
  EXAMPLE_BRIEF_FACTS,
} = require('../src/services/client-dayof-brief');
const { redactionReason, CLIENT_HIDDEN_SECTION_KEYS } = require('../src/services/dayof-brief-redact');

const TITLES = ['Who', "Why you're meeting", 'Rapport hooks', 'Easy openers', 'Allo', 'Fireflies / Cube', 'Logistics'];
const CLIENT_TITLES = ['Who', "Why you're meeting", 'Rapport hooks', 'Easy openers', 'Allo', 'Logistics'];
const CAMPAIGN = EXAMPLE_BRIEF_FACTS.how.campaign;
const MAILBOX = EXAMPLE_BRIEF_FACTS.how.sender;

const sample = () => JSON.parse(JSON.stringify(EXAMPLE_BRIEF_FACTS));

describe('client brief = Josh brief minus redacted lines', () => {
  it('Josh version carries the campaign and internal lines, so the redaction has something to remove', () => {
    const josh = buildJoshDayofBrief(sample());
    assert.match(josh.textBody, new RegExp(CAMPAIGN));
    assert.match(josh.textBody, /LTV/);
    assert.match(josh.textBody, /Proof to lean on/);
    assert.match(josh.textBody, /Smartlead/);
    assert.ok(josh.textBody.includes(MAILBOX));
  });

  it('client sections, order and lines equal Josh sections minus the removed lines', () => {
    const facts = sample();
    const { josh, client, removed } = buildClientDayofBriefParts(facts);
    assert.deepEqual(client.sections.map((s) => s.title), CLIENT_TITLES);
    assert.deepEqual(josh.sections.map((s) => s.title), TITLES);
    assert.equal(client.subject, josh.subject);
    const removedLines = new Set(removed.map((r) => `${r.section}::${r.line}`));
    assert.ok(removed.length >= 4);
    const hidden = new Set(CLIENT_HIDDEN_SECTION_KEYS);
    for (const js of josh.sections) {
      const cs = client.sections.find((s) => s.key === js.key);
      if (hidden.has(js.key)) { assert.equal(cs, undefined, `${js.title} is hidden from clients`); continue; }
      const expected = js.items.filter((line) => !removedLines.has(`${js.title}::${line}`));
      assert.deepEqual(cs.items, expected, `section ${js.title}`);
    }
    // Every removed line really is gone, every other Josh line is still there verbatim.
    const clientText = buildClientDayofBrief(facts).textBody;
    for (const r of removed) assert.equal(clientText.includes(r.line), false, r.line);
    for (const js of josh.sections.filter((x) => !hidden.has(x.key))) {
      for (const line of js.items) {
        if (!removedLines.has(`${js.title}::${line}`)) assert.ok(clientText.includes(`- ${line}`), line);
      }
    }
  });

  it('is rendered by the same renderer: html and text differ only by the removed lines', () => {
    const facts = sample();
    const josh = buildJoshDayofBrief(facts);
    const out = buildClientDayofBrief(facts);
    // Josh's text, rebuilt without the hidden sections and the removed lines, is the client text.
    const keep = josh.sections.filter((x) => !CLIENT_HIDDEN_SECTION_KEYS.includes(x.key));
    const gone = new Set(out.removed.map((r) => `${r.section}::${r.line}`));
    const rebuilt = [josh.subject, ''];
    for (const x of keep) {
      rebuilt.push(x.title);
      for (const line of x.items) if (!gone.has(`${x.title}::${line}`)) rebuilt.push(`- ${line}`);
      rebuilt.push('');
    }
    assert.equal(out.textBody, rebuilt.join('\n').replace(/\n{3,}/g, '\n\n').trim());
    assert.ok(out.htmlBody.startsWith("<div style='font-family:Arial,sans-serif;font-size:14px'>"));
    assert.deepEqual([...out.htmlBody.matchAll(/<h3>([^<]*)<\/h3>/g)].map((m) => m[1]), CLIENT_TITLES);
  });

  it('no campaign name, mailbox, tool name or internal note appears anywhere in the client output', () => {
    const out = buildClientDayofBrief(sample());
    const all = `${out.subject}\n${out.textBody}\n${out.htmlBody}`;
    assert.equal(all.toLowerCase().includes(CAMPAIGN.toLowerCase()), false);
    assert.equal(/campaign/i.test(all), false);
    assert.equal(all.includes(MAILBOX), false);
    assert.equal(all.includes('example-mail.example'), false);
    for (const word of ['Smartlead', 'HeyReach', 'LTV', '$36K', 'Proof to lean on', 'unsubscribe']) {
      assert.equal(all.includes(word), false, word);
    }
    // The real content stays. Fireflies / Cube is hidden (see the next test); Allo stays.
    assert.match(out.textBody, /Came in by Email\./);
    assert.match(out.textBody, /walk us through pricing/);
  });

  it('Fireflies / Cube is hidden from the client, Allo stays, and Josh still sees both', () => {
    assert.deepEqual(CLIENT_HIDDEN_SECTION_KEYS, ['fireflies']);
    const facts = sample();
    facts.history.callLines = ['Oct 26, 1:37pm CT: Cayden outbound, left a voicemail about the booking link'];
    facts.history.firefliesLines = ['Intro call with the sample company, Oct 20: they asked about pricing'];
    const josh = buildJoshDayofBrief(facts);
    const client = buildClientDayofBrief(facts);
    for (const t of ['Allo', 'Fireflies / Cube']) {
      assert.match(josh.textBody, new RegExp(`^${t.replace('/', '\\/')}$`, 'm'));
      assert.match(josh.htmlBody, new RegExp(`<h3>${t.replace('/', '\\/')}</h3>`));
    }
    // Allo stays for the client, with its call lines.
    assert.match(client.textBody, /^Allo$/m);
    assert.match(client.htmlBody, /<h3>Allo<\/h3>/);
    assert.match(client.textBody, /left a voicemail/);
    // Fireflies / Cube is gone from the client copy, lines included.
    assert.equal(client.textBody.includes('Fireflies'), false);
    assert.equal(client.htmlBody.includes('Fireflies'), false);
    assert.equal(client.textBody.includes('Intro call with the sample company'), false);
    assert.match(josh.textBody, /Intro call with the sample company/);
    assert.deepEqual(
      client.removed.filter((r) => r.reason === 'hidden_section').map((r) => r.section),
      ['Fireflies / Cube'],
    );
    assert.deepEqual([...client.htmlBody.matchAll(/<h3>([^<]*)<\/h3>/g)].map((m) => m[1]), CLIENT_TITLES);
  });

  it('removes a campaign name wherever it shows up, including inside a quote or the written sections', () => {
    const facts = sample();
    facts.how.campaign = 'Q4 Owners Blitz 88';
    facts.history.quotes = [{ when: 'Oct 28', who: 'Jordan Hale', text: 'Saw your q4 owners blitz 88 note, Thursday works.' }];
    facts.written = {
      why: ['Replied to the Q4 Owners Blitz 88 email on Oct 28', 'Asked for pricing on the call'],
      openers: ['"How do you win new work today?"'],
    };
    const josh = buildJoshDayofBrief(facts);
    assert.match(josh.textBody, /Q4 Owners Blitz 88/);
    const out = buildClientDayofBrief(facts);
    assert.equal(/q4 owners blitz/i.test(out.textBody), false);
    assert.match(out.textBody, /Asked for pricing on the call/);
    assert.match(out.textBody, /How do you win new work today/);
  });

  it('a prospect asking about pricing stays; our pricing does not', () => {
    assert.equal(redactionReason('They asked: walk us through pricing on the call'), null);
    assert.equal(redactionReason('Our pricing is $2,500/month per account'), 'internal_note');
    assert.equal(redactionReason('Should clear the $36K LTV bar'), 'internal_note');
    assert.equal(redactionReason('Sent from the sender mailbox on the warmup domain'), 'mailbox');
    assert.equal(redactionReason('Smartlead shows two sends'), 'internal_note');
  });

  it('a section emptied by redaction keeps its place with one honest line', () => {
    const facts = { prospect: { name: 'Alex Example' }, how: { campaign: 'Only Campaign Line' }, history: { callNotes: 'No calls on file.' } };
    const out = buildClientDayofBrief(facts);
    assert.deepEqual([...out.htmlBody.matchAll(/<h3>([^<]*)<\/h3>/g)].map((m) => m[1]), CLIENT_TITLES);
    assert.equal(out.textBody.includes('Only Campaign Line'), false);
    assert.match(out.textBody, /Why you're meeting\n- No thread on file\./);
  });

  it('example data: the subject client and the body agree, and nothing says Example Industrial', () => {
    const out = buildClientDayofBrief(sample());
    assert.match(out.subject, /^Brief: Jordan Hale and Sample Client Co\. @ 9:30am CT$/);
    assert.equal(/Example Industrial/.test(out.subject + out.textBody + out.htmlBody), false);
    assert.match(out.textBody, /Northwind Roofing Co\./);
  });

  it('there is one builder: the client path calls the Josh builder and no second template exists', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/client-dayof-brief.js'), 'utf8');
    const fn = src.slice(src.indexOf('function buildClientDayofBriefParts'), src.indexOf('function buildClientDayofBrief('));
    assert.match(fn, /buildJoshDayofBrief\(facts\)/);
    assert.match(fn, /redactBriefForClient\(/);
    assert.equal((src.match(/BRIEF_SECTIONS\.map/g) || []).length, 1, 'sections are laid out in one place');
    assert.deepEqual(CLIENT_HIDDEN_SECTION_KEYS, ['fireflies'], 'only Fireflies / Cube is hidden from clients');
  });
});
