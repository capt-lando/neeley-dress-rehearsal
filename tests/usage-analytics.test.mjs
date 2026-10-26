import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageAnalytics } from '../lib/usage-analytics.mjs';

function fixture(send) {
  let time = 0, id = 0;
  const batches = [];
  const analytics = createUsageAnalytics({ now: () => time, uuid: () => `id-${++id}`, send: send || (async events => { batches.push(events); }) });
  return { analytics, batches, advance: ms => { time += ms; } };
}

test('no consent means no session identifier or events; revoking clears queued events', async () => {
  const { analytics, batches, advance } = fixture();
  analytics.setView({ section: 'prepare', visible: true, focused: true });
  advance(10000); analytics.track('recording_completed'); await analytics.flush();
  assert.equal(batches.length, 0);
  analytics.setConsent(true); analytics.track('analysis_requested'); analytics.setConsent(false);
  await analytics.flush(); assert.equal(batches.length, 0);
});

test('dwell excludes hidden, unfocused, and idle time with bounded content-free events', async () => {
  const { analytics, batches, advance } = fixture();
  analytics.setConsent(true); analytics.setView({ section: 'prepare', visible: true, focused: true });
  advance(10000); analytics.setView({ section: 'rehearse' });
  advance(20000); analytics.setView({ visible: false });
  advance(30000); analytics.activity(); analytics.setView({ visible: true, focused: false });
  advance(10000); analytics.setView({ focused: true });
  advance(90000); await analytics.flush();
  const events = batches.flat();
  assert.equal(events.filter(event => event.name === 'section_engaged' && event.section === 'prepare').reduce((sum, event) => sum + event.activeSeconds, 0), 10);
  assert.equal(events.filter(event => event.name === 'section_engaged' && event.section === 'rehearse').reduce((sum, event) => sum + event.activeSeconds, 0), 70);
  assert.ok(events.every(event => Object.keys(event).every(key => ['id', 'sessionId', 'name', 'section', 'activeSeconds'].includes(key))));
  assert.ok(events.every(event => !event.activeSeconds || event.activeSeconds <= 60));
});

test('unrecognized events and sections cannot capture arbitrary content', async () => {
  const { analytics, batches } = fixture();
  analytics.setConsent(true); analytics.track('My private script'); analytics.setView({ section: 'my@email.example' });
  analytics.track('analysis_completed'); await analytics.flush();
  assert.deepEqual(batches.flat().map(event => event.name), ['session_started', 'analysis_completed']);
  assert.ok(batches.flat().every(event => event.section === 'prepare'));
});

test('retries preserve event IDs; revoke aborts in-flight sending and new consent creates a new session', async () => {
  let attempts = 0; const sent = [];
  const { analytics } = fixture(async (events, { signal }) => { sent.push({ events, signal }); if (!attempts++) throw new Error('offline'); });
  analytics.setConsent(true); await analytics.flush(); await analytics.flush();
  assert.equal(sent[0].events[0].id, sent[1].events[0].id);
  const originalSession = sent[1].events[0].sessionId;
  analytics.setConsent(false); analytics.setConsent(true); await analytics.flush();
  assert.notEqual(sent[2].events[0].sessionId, originalSession);
  analytics.dispose();
});

test('synchronous revocation before a scheduled send prevents any network call', async () => {
  const { analytics, batches } = fixture();
  analytics.setConsent(true); const flushing = analytics.flush(); analytics.setConsent(false); await flushing;
  assert.equal(batches.length, 0);
});

test('batches and queue remain bounded while offline', async () => {
  const sent = []; const { analytics } = fixture(async events => { sent.push(events); throw new Error('offline'); });
  analytics.setConsent(true);
  for (let i = 0; i < 300; i++) analytics.track('recording_completed');
  await analytics.flush(); await analytics.flush();
  assert.equal(sent.length, 2); assert.ok(sent.every(events => events.length <= 20));
  assert.equal(sent[0][0].id, sent[1][0].id);
});
