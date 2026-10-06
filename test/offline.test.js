// Offline tests for the Gmail queue bridge. Run: node test/offline.test.js
const path = require('path'), fs = require('fs');
const { createEnv, assert, section, done } = require('./harness');
const root = path.join(__dirname, '..');
const FILES = ['Config.js', 'Util.js', 'QueueSink.js', 'Prompts.js', 'GeminiOrchestrator.js', 'ContextBuilder.js', 'QueueBridge.js', 'Main.js'];
const PROPS = { QUEUE_WEBHOOK_URL: 'https://script.google.com/macros/s/X/exec', QUEUE_API_KEY: 'k123', GEMINI_API_KEY: 'g' };

function mk(handler, extraProps) { return createEnv(root, { files: FILES, props: Object.assign({}, PROPS, extraProps), handler }); }
const mockItems = `
var mkMsg = function(id, from, subj, body){ return { getId:()=>id, getFrom:()=>from, getSubject:()=>subj, getDate:()=>new Date('2026-10-06T15:00:00Z') }; };
var mkThread = function(id){ return { getId:()=>id, getLabels:()=>[{getName:()=>'ai_star'}] }; };
var mkItem = function(msgId, tid, from, subj, d){ return { msgId: msgId, decision: d, threadObj: { message: mkMsg(msgId, from, subj), thread: mkThread(tid), fullBody: 'Body of ' + subj, facts: {}, history: '' } }; };
`;
function ok(counts) { return (url, o) => { const p = JSON.parse(o.payload); counts.push({ url, rows: p }); return { code: 200, text: JSON.stringify({ success: true, insertedRows: p.length }) }; }; }

section('class mapping');
{
	const e = mk(() => ({ code: 200, text: '{}' }));
	const c = (d) => JSON.stringify(e.run('queueClassForDecision_(' + JSON.stringify(d) + ')'));
	assert(c({ importance: 'STAR', draft_reply: true, notify: true }).includes('"Action"') && c({ importance: 'STAR', draft_reply: true, notify: true }).includes('"Now"'), 'STAR+draft+notify -> Action Now');
	assert(c({ importance: 'STAR', draft_reply: false, reason_code: 'ASK_OF_NIK' }).includes('At Risk'), 'ASK_OF_NIK -> Action At Risk');
	assert(c({ importance: 'STAR', reason_code: 'FYI' }).includes('"Brief"') && c({ importance: 'STAR', reason_code: 'FYI' }).includes('Later'), 'STAR other -> Brief Later');
	assert(c({ importance: 'UNSURE' }).includes('"Brief"'), 'UNSURE -> Brief');
	['NEITHER', 'ARCHIVE', 'BLOCK'].forEach(i => assert(c({ importance: i }).includes('"isLog":true'), i + ' -> log'));
}

section('flushQueue_ writes Queue and Triage_Log');
{
	const calls = []; const e = mk(ok(calls));
	e.run(mockItems);
	const ret = e.run(`flushQueue_([
	  mkItem('m1','t1','Maya <maya@acme.com>','Approve rename',{importance:'STAR',draft_reply:true,notify:false,reason:'ask',reason_code:'ASK_OF_NIK'}),
	  mkItem('m2','t2','News <n@x.com>','Weekly digest',{importance:'ARCHIVE',reason:'newsletter'}),
	  mkItem('m3','t3','Bob <bob@acme.com>','Maybe',{importance:'UNSURE',reason:'unclear'})
	], {m1:{text:'Yes, go.',id:'r-9'}})`);
	assert(ret === true, 'returns true');
	const q = calls.find(c => c.url.includes('sheetName=Queue')), l = calls.find(c => c.url.includes('sheetName=Triage_Log'));
	assert(q && q.rows.length === 2, 'two queue rows');
	assert(l && l.rows.length === 1, 'one log row');
	const r1 = q.rows.find(r => r['Card Key'] === 'gmail:t1');
	assert(r1 && r1['Kind'] === 'Action' && r1['Status'] === 'Drafted' && r1['Draft Text'] === 'Yes, go.' && r1['Draft Ref'] === 'gmail-draft:r-9', 'drafted action row');
	assert(r1['Name'].includes('Approve rename') && r1['Source Ref'].endsWith('/t1') && /\[act:2026-10-06T15:00:00\.000Z\]$/.test(r1['Reason']), 'name has subject, ref and act token');
	assert(l.rows[0]['Kind'] === 'Log' && l.rows[0]['Status'] === 'Ignored', 'log row status');
	assert(q.url.includes('apiKey=k123'), 'api key sent');
	// second run: same items skipped
	calls.length = 0;
	e.run(`flushQueue_([mkItem('m1','t1','Maya <maya@acme.com>','Approve rename',{importance:'STAR',draft_reply:true,reason:'ask'})], {})`);
	assert(calls.length === 0, 'seen-store skips repeat message');
	// new message on same thread inserts
	e.run(`flushQueue_([mkItem('m4','t1','Maya <maya@acme.com>','Re: Approve rename',{importance:'STAR',draft_reply:true,reason:'ask'})], {})`);
	assert(calls.length === 1, 'new message on same thread is written');
	assert(e.logs.some(l => l.includes('QUEUE row') && l.includes('Approve rename')), 'log lines carry the subject');
}

section('failure counter');
{
	const e = mk(() => ({ code: 500, text: 'boom' }));
	e.run(mockItems);
	const run = () => e.run(`flushQueue_([mkItem('f1','tf','A <a@b.com>','Subj',{importance:'STAR',draft_reply:true,reason:'r'})], {})`);
	assert(run() === false, 'first failure holds timestamp');
	assert(run() === false, 'second failure holds timestamp');
	assert(run() === true, 'third failure gives up');
	assert(e.logs.some(l => l.includes('GIVING UP')), 'give-up is loud');
}

section('config and dry run');
{
	const calls = []; const e = mk(ok(calls), { QUEUE_WEBHOOK_URL: '' });
	e.run(mockItems);
	assert(e.run('queueConfigured_()') === false, 'not configured without URL');
	const e2 = mk(ok(calls)); e2.run(mockItems); e2.run('CONFIG.QUEUE_DRY_RUN = true');
	e2.run(`flushQueue_([mkItem('d1','td','A <a@b.com>','Subj',{importance:'STAR',draft_reply:true,reason:'r'})], {})`);
	assert(calls.length === 0, 'dry run sends nothing');
	const e3 = mk(ok(calls)); e3.run(mockItems); e3.run('CONFIG.ENABLE_QUEUE_SINK = false');
	assert(e3.run(`flushQueue_([mkItem('d1','td','A <a@b.com>','Subj',{importance:'STAR'})], {})`) === true && calls.length === 0, 'sink off sends nothing');
}

section('Main wiring');
{
	const src = fs.readFileSync(path.join(root, 'Main.js'), 'utf8');
	assert(/queueItems\.push\(/.test(src) && src.indexOf('queueItems.push(') < src.indexOf('switch (decision.importance)'), 'decision captured before the switch');
	assert(/flushQueue_\(queueItems, draftInfo\)/.test(src), 'flush called');
	assert(src.indexOf('flushQueue_(queueItems') < src.indexOf("setProperty('LAST_PROCESSED_TIMESTAMP', runTimestamp"), 'flush before timestamp save');
	assert(/return GmailApp\.createDraft/.test(src), 'draft returned');
	const e = mk(() => ({ code: 200, text: '{}' }));
	assert(e.run("sendTextWebhook_('x')") === false, 'alert skipped when webhook unset');
}

done();
