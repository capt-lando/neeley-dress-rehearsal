import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestLimit } from '../supabase/functions/rehearsal-api/request-limit.mjs';

test('ten thousand immediate attempts admit only the configured burst', () => {
  let time=1000,accepted=0,rejected=0;
  const enter=createRequestLimit({now:()=>time});
  for(let i=0;i<10000;i++) {
    try { enter()(); accepted++; }
    catch(error) { assert.equal(error.status,429);assert.equal(error.retryAfter,1);rejected++; }
  }
  assert.equal(accepted,60);assert.equal(rejected,9940);
  time+=100;enter()();assert.throws(enter,error=>error.status===429);
  time+=60000;
  for(let i=0;i<60;i++)enter()();
  assert.throws(enter,error=>error.status===429);
});

test('slow concurrent requests stay bounded and releasing twice cannot corrupt the limit', () => {
  const enter=createRequestLimit({now:()=>1000});
  const releases=Array.from({length:8},()=>enter());
  assert.throws(enter,error=>error.status===429&&error.retryAfter===2);
  releases[0]();releases[0]();
  const next=enter();assert.throws(enter,error=>error.status===429);
  next();releases.forEach(release=>release());
  const resumed=Array.from({length:8},()=>enter());
  assert.throws(enter,error=>error.status===429);resumed.forEach(release=>release());
});
