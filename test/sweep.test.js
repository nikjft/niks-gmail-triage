// Offline tests for the Gmail staleness sweep. Run: node test/sweep.test.js
const path = require('path');
const { createEnv, assert, section, done } = require('./harness');
const root = path.join(__dirname, '..');
const FILES = ['Config.js', 'Util.js', 'QueueSink.js', 'QueueStore.js', 'Main.js', 'GmailStaleness.js'];
const PROPS = { QUEUE_WEBHOOK_URL: 'https://script.google.com/macros/s/X/exec', QUEUE_API_KEY: 'k123' };
const old = new Date(Date.now() - 86400000).toISOString();

function sheet(rows) {
	const updates = [];
	const handler = (url, o) => {
		const p = JSON.parse(o.payload), a = p.params.arguments;
		let data;
		if (p.params.name === 'get_filtered_sheet_contents') {
			const sts = a.filters.map(f => f.value);
			const hit = rows.filter(r => sts.includes(r.Status));
			data = { rows: hit.slice(a.offset, a.offset + a.limit), totalMatched: hit.length };
		} else if (p.params.name === 'update_row') { updates.push(a); data = { success: true, rowsUpdated: 1 }; }
		else data = {};
		return { code: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false } }) };
	};
	return { handler, updates };
}
const row = (uid, tid, extra) => Object.assign({ _uid: uid, Name: 'Email ' + uid, Source: 'Gmail', Kind: 'Action', Status: 'New', 'Card Key': 'gmail:' + tid, 'Source Ref': 'https://mail.google.com/mail/u/0/#all/' + tid, Lease: '', _created_at: old }, extra);

const msg = (from, draft) => ({ getFrom: () => from, isDraft: () => !!draft });
function thread(id, o) {
	o = o || {};
	return { getId: () => id, getMessages: () => o.msgs, isInInbox: () => o.inbox !== false, isInTrash: () => !!o.trash, hasStarredMessages: () => !!o.starred };
}

function run(rows, threads, searches, dry) {
	const s = sheet(rows), e = createEnv(root, { files: FILES, props: PROPS, handler: s.handler });
	e.ctx.__threads = threads; e.ctx.__searches = searches || {};
	e.run(`GmailApp.getThreadById = function(id){ return __threads[id] || null; };
		GmailApp.search = function(q){ return (__searches[q] || []).map(function(id){ return { getId: function(){ return id; } }; }); };`);
	const out = e.run(dry ? 'runGmailStalenessSweepDry()' : 'runGmailStalenessSweep()');
	return { out, updates: s.updates, e };
}
const closed = (r) => r.updates.map(u => u.rowIdentifier.uid).sort();

section('last reply from me closes; last from them stays');
{
	const r = run([row('a', 'T1'), row('b', 'T2'), row('c', 'T3')], {
		T1: thread('T1', { msgs: [msg('Bob <bob@x.com>'), msg('Nik <nik@mcgaw.io>')] }),
		T2: thread('T2', { msgs: [msg('Nik <nik@mcgaw.io>'), msg('Bob <bob@x.com>')] }),
		T3: thread('T3', { msgs: [msg('Bob <bob@x.com>'), msg('Nik <nik@mcgaw.io>', true)] })   // my message is only a draft
	});
	assert(closed(r).join() === 'a', 'only a closed, got ' + closed(r));
	const u = r.updates[0];
	assert(u.data.Status === 'Done' && u.data.Closeout.startsWith('stale sweep:') && /^\d{4}-/.test(u.data['Closed At']), 'Done + Closeout + Closed At in one update');
	assert(!r.e.logs.some(l => l.includes('delete')), 'no delete');
}

section('archived and not starred closes; inbox and starred stay');
{
	const r = run([row('a', 'T1'), row('b', 'T2'), row('c', 'T3'), row('d', 'T4')], {
		T1: thread('T1', { msgs: [msg('Bob <b@x.com>')], inbox: false }),
		T2: thread('T2', { msgs: [msg('Bob <b@x.com>')], inbox: false, starred: true }),
		T3: thread('T3', { msgs: [msg('Bob <b@x.com>')], inbox: false }),
		T4: thread('T4', { msgs: [msg('Bob <b@x.com>')], inbox: true })
	});
	assert(closed(r).join() === 'a,c', 'only a closed, got ' + closed(r));
}

section('snoozed row, leased row, gate row, Manual, Log never touched; unreadable thread kept');
{
	const r = run([
		row('s', 'T1', { Status: 'Snoozed' }), row('l', 'T1', { Lease: 'queue-processor@x' }),
		row('g', 'T1', { 'Source Ref': 'needs-help:email-backlog', 'Card Key': '' }), row('m', 'T1', { Source: 'Manual' }),
		row('k', 'T1', { Kind: 'Log' }), row('u', 'T9'), row('ok', 'T1')
	], { T1: thread('T1', { msgs: [msg('Nik <nik@mcgaw.io>')] }) });
	assert(closed(r).join() === 'ok', 'only ok closed, got ' + closed(r));
	assert(r.out.failed === 1, 'unreadable counted failed');
}

section('queued next steps under a closed row close with it, any channel, recursively');
{
	const r = run([row('p', 'T1'), row('kid', 'T2', { Source: 'Slack', Parent: 'p', 'Card Key': 'slack:C1:1.1' }), row('grand', 'T2', { Source: 'Trello', Parent: 'kid' }),
		row('leased', 'T2', { Parent: 'p', Lease: 'qp@x' }), row('snz', 'T2', { Parent: 'p', Status: 'Snoozed' }), row('other', 'T2', { Parent: 'zzz' }),
		row('keep', 'T3')], {
		T1: thread('T1', { msgs: [msg('nik@mcgaw.io')] }),
		T2: thread('T2', { msgs: [msg('Bob <b@x.com>')] }),
		T3: thread('T3', { msgs: [msg('Bob <b@x.com>')] })
	});
	assert(closed(r).join() === 'grand,kid,p', 'p, kid, grand closed; leased, snoozed, unrelated stay; got ' + closed(r));
	const kid = r.updates.find(u => u.rowIdentifier.uid === 'kid');
	assert(kid.data.Closeout.includes('parent p closed'), 'child closeout names the parent');
	assert(r.updates.filter(u => u.rowIdentifier.uid === 'kid').length === 1, 'no double close');
	assert(r.out.cascaded === 2, 'cascade counted');
}

section('legacy Email source and ref parsing');
{
	const r = run([row('a', '', { Source: 'Email', 'Card Key': '', 'Source Ref': '[link](https://mail.google.com/mail/u/0/#inbox/T1)' })],
		{ T1: thread('T1', { msgs: [msg('nik@mcgaw.io')] }) });
	assert(closed(r).join() === 'a', 'Email source with wrapped ref closes');
}

section('dry run writes nothing; cursor carries over');
{
	const r = run([row('a', 'T1')], { T1: thread('T1', { msgs: [msg('nik@mcgaw.io')] }) }, {}, true);
	assert(r.updates.length === 0 && r.out.closed === 1, 'dry run reports but writes nothing');
	const rows = [row('a', 'T1'), row('b', 'T1'), row('c', 'T1')];
	const s = sheet(rows), e = createEnv(root, { files: FILES, props: PROPS, handler: s.handler });
	e.ctx.__threads = { T1: thread('T1', { msgs: [msg('Bob <b@x.com>')] }) };
	e.run(`GmailApp.getThreadById = function(id){ return __threads[id]; }; GmailApp.search = function(){ return []; }; CONFIG.SWEEP.MAX_ROWS_PER_RUN = 2;`);
	const o1 = e.run('runGmailStalenessSweep()');
	assert(o1.examined === 2 && o1.carried === 1, 'first run examines 2, carries 1');
	assert(e.props.SWEEP_CURSOR_GMAIL === '2', 'cursor saved');
}

section('queue read failure is reported, not thrown');
{
	const e = createEnv(root, { files: FILES, props: PROPS, handler: () => ({ code: 500, text: 'boom' }) });
	const out = e.run('runGmailStalenessSweep()');
	assert(out.errors.length === 1 && out.closed === 0, 'error reported');
}
done();
