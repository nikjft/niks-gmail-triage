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

section('cold pitch posing as a deal signal is demoted (no prior contact)');
{
	const e = mk(() => ({ code: 200, text: '{}' }));
	const nd = (d, facts) => JSON.parse(e.run('JSON.stringify(normalizeDecision(' + JSON.stringify(d) + ', ' + JSON.stringify(facts) + ', "t"))'));
	const deal = { importance: 'STAR', reason_code: 'ACTIVE_DEAL_SIGNAL', draft_reply: true, notify: true };
	let o = nd(deal, { prior_contact: false });
	assert(o.importance === 'NEITHER' && o.reason_code === 'SOLICITATION' && !o.draft_reply && !o.notify, 'STAR/ACTIVE_DEAL_SIGNAL with no contact -> NEITHER');
	o = nd({ importance: 'STAR', reason_code: 'CLIENT_ISSUE' }, { prior_contact: false });
	assert(o.importance === 'NEITHER', 'CLIENT_ISSUE with no contact -> NEITHER');
	assert(nd(deal, { prior_contact: true }).importance === 'STAR', 'known sender keeps STAR');
	assert(nd({ importance: 'STAR', reason_code: 'ASK_OF_NIK' }, { prior_contact: false }).importance === 'STAR', 'a direct ask from a stranger is not demoted (could be an inbound lead)');
	assert(nd(deal, {}).importance === 'STAR' && nd(deal, null).importance === 'STAR', 'missing fact never demotes');
}

section('prior contact: sent-mail search by domain, by address for freemail, cached; failure counts as contact');
{
	const e = mk(() => ({ code: 200, text: '{}' }));
	e.ctx.__q = [];
	e.run("GmailApp.search = function (q) { __q.push(q); return q.indexOf('acme.com') > -1 || q.indexOf('pal@gmail.com') > -1 ? [{}] : []; };");
	assert(e.run("hasSentTo_('bob@acme.com')") === true, 'domain contact found');
	assert(e.run("hasSentTo_('new.person@acme.com')") === true && e.ctx.__q.length === 1, 'same domain cached, one search');
	assert(e.run("hasSentTo_('colton.manzo@serenityprovision.co')") === false, 'cold sender has no contact');
	assert(e.run("hasSentTo_('stranger@gmail.com')") === false && e.ctx.__q.includes('in:sent to:stranger@gmail.com'), 'freemail matched by full address');
	assert(e.run("hasSentTo_('pal@gmail.com')") === true, 'freemail contact found');
	e.run("_sentToCache = {}; GmailApp.search = function () { throw new Error('quota'); };");
	assert(e.run("hasSentTo_('x@unknown.io')") === true, 'search failure never demotes');
}

section('buildFacts sets prior_contact');
{
	const e = mk(() => ({ code: 200, text: '{}' }));
	e.run("GmailApp.search = function () { return []; };");
	const M = (from) => `{ getFrom: function(){ return '${from}'; }, getTo: function(){ return 'nik@mcgaw.io'; }, getCc: function(){ return ''; }, getRawContent: function(){ return 'X: y'; } }`;
	const f = (msgs) => JSON.parse(e.run('JSON.stringify(buildFacts([' + msgs.join(',') + '], ' + msgs[msgs.length - 1] + '))'));
	assert(f([M('Colton <colton.manzo@serenityprovision.co>')]).prior_contact === false, 'single cold message: no contact');
	assert(f([M('Pat <pat@newco.com>'), M('Sarah <sarah@mcgaw.io>'), M('Pat <pat@newco.com>')]).prior_contact === true, 'teammate in thread counts');
	assert(f([M('nik@mcgaw.io'), M('Pat <pat@newco.com>')]).prior_contact === true, 'Nik in thread counts');
}

done();
