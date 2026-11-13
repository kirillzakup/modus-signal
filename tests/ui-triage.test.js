'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const core = require('../public/core.js');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const handlers = html.slice(html.indexOf('  triDue:function'), html.indexOf('  triTrash:function'));

function harness() {
  const fields = {
    '#trDue': { value: '2026-11-20', dataset: {}, reportValidity: () => true },
    '#trCollect': { value: '2026-11-15T12:00', reportValidity: () => true }, '#trVote': { value: '2026-11-16T12:00', reportValidity: () => true }, '#trWho': { value: 'm1' }, '#trPrio': { value: 'medium' }, '#trCat': { value: '' }
  };
  let submitted;
  const context = { $, D: core, Date, isNaN, ymd: () => '2026-11-23',
    App: { tri: 'A-001', api: { accept: (_id, body) => { submitted = body; return Promise.resolve({ id: 'A-001' }); } } },
    toast() {}, closeModal() {}, refreshCounters: () => Promise.resolve(), rerender() {}, fail: e => { throw e; }
  };
  function $(selector) { return fields[selector]; }
  const acts = vm.runInNewContext('({' + handlers + '})', context);
  return { fields, acts, submitted: () => submitted };
}

test('priority updates the suggested date but preserves a manually chosen deadline', () => {
  const h = harness();
  h.acts.triPrio({ value: 'medium' });
  assert.equal(h.fields['#trDue'].value, '2026-11-23');
  h.fields['#trDue'].value = '2026-11-20';
  h.acts.triDue(h.fields['#trDue']);
  h.acts.triPrio({ value: 'high' });
  assert.equal(h.fields['#trDue'].value, '2026-11-20');
});

test('invalid deadline is not submitted or disabled', () => {
  const h = harness(), button = { disabled: false };
  h.fields['#trDue'].reportValidity = () => false;
  h.acts.triAcceptGo(button);
  assert.equal(h.submitted(), undefined);
  assert.equal(button.disabled, false);
});

test('browser-local end-of-day survives UTC server storage in multiple zones', () => {
  for (const zone of ['UTC', 'Asia/Tashkent', 'America/New_York']) {
    const source = `const fs=require('node:fs'),vm=require('node:vm');
      const text=fs.readFileSync('public/index.html','utf8');
      const body=text.slice(text.indexOf('  triDue:function'),text.indexOf('  triTrash:function'));
      let result; const fields={'#trDue':{value:'2026-11-20',reportValidity:()=>true},'#trCollect':{value:'2026-11-15T12:00',reportValidity:()=>true},'#trVote':{value:'2026-11-16T12:00',reportValidity:()=>true},'#trWho':{value:'m1'},'#trPrio':{value:'medium'},'#trCat':{value:''}};
      class FixedDate extends Date { constructor(...args){ super(...(args.length ? args : ['2026-11-13T00:00:00Z'])); } static now(){ return Date.parse('2026-11-13T00:00:00Z'); } }
      const a=vm.runInNewContext('({'+body+'})',{$:s=>fields[s],Date:FixedDate,isNaN,App:{api:{accept:(_,p)=>{result=p;return Promise.resolve({});}}},closeModal(){},toast(){},refreshCounters:()=>Promise.resolve(),rerender(){},fail(){}});
      a.triAcceptGo({});process.stdout.write(JSON.stringify(result));`;
    const payload = JSON.parse(execFileSync(process.execPath, ['-e', source], { cwd: path.join(__dirname, '..'), env: { ...process.env, TZ: zone }, encoding: 'utf8' }));
    const now = Date.parse('2026-11-13T00:00:00Z'), state = core.emptyState();
    state.settings.ownerTriage = true;
    const employee = state.users.find(u => u.role === 'employee');
    const ticket = core.createTicket(state, employee.id, { type: 'problem', text: 'Учебная проблема с экраном в переговорной', title: 'Экран не работает' }, now);
    core.accept(state, 'o1', ticket.id, payload, now);
    assert.equal(ticket.resolveDue, payload.due);
    assert.equal(new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(ticket.resolveDue)), '2026-11-20');
  }
});
