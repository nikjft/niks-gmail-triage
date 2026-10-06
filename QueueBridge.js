/**
 * QueueBridge.js - sends Gmail triage decisions to the queue sheet (google-sheet-mcp webhook).
 * Uses QueueSink.js and Util.js (shared with niks-slack-triage and niks-trello-triage).
 *
 * Mapping:
 *   STAR + (draft_reply or an action reason code) -> Kind Action, tier Now if notify else At Risk
 *   STAR otherwise                                -> Kind Brief, tier Later (Now if notify)
 *   UNSURE                                        -> Kind Brief, tier Later (never dropped silently)
 *   NEITHER, ARCHIVE, BLOCK                       -> Triage_Log tab, Kind Log, Status Ignored
 * Row contract matches the Notion Nik Queue: Card Key gmail:<threadId>, [act:<ISO>] on Reason.
 * The sheet webhook is insert-only. A new message on a known thread inserts a new row with the same Card Key.
 */

var GMAIL_COLLECTOR_NAME_ = 'gmail-triage';
var GMAIL_COLLECTOR_VERSION_ = '2026-10-06';
var GMAIL_ACTION_CODES_ = ['ASK_OF_NIK', 'CLIENT_ISSUE', 'ACTIVE_DEAL_SIGNAL', 'TIME_SENSITIVE', 'SIGNATURE'];
var GMAIL_SINK_MAX_FAILS_ = 3;

function queueConfigured_() {
	return !!PropertiesService.getScriptProperties().getProperty('QUEUE_WEBHOOK_URL');
}

function gmailEntityFor_(fromHeader) {
	var map = CONFIG.DOMAIN_ENTITY_MAP || {};
	var email = extractSingleEmail(fromHeader), domain = email.indexOf('@') > -1 ? email.split('@')[1] : '';
	return map[email] || map[domain] || '';
}

// Returns {kind, status, tier, isLog}
function queueClassForDecision_(d) {
	var imp = d.importance;
	if (imp === 'STAR') {
		var action = d.draft_reply === true || GMAIL_ACTION_CODES_.indexOf(d.reason_code) !== -1;
		if (action) return { kind: 'Action', tier: d.notify ? 'Now' : 'At Risk', isLog: false };
		return { kind: 'Brief', tier: d.notify ? 'Now' : 'Later', isLog: false };
	}
	if (imp === 'UNSURE') return { kind: 'Brief', tier: 'Later', isLog: false };
	return { kind: 'Log', tier: '', isLog: true };
}

function gmailRowFor_(it, draft) {
	var d = it.decision, msg = it.threadObj.message, thread = it.threadObj.thread;
	var cls = queueClassForDecision_(d), threadId = thread.getId();
	var from = msg.getFrom(), subject = String(msg.getSubject() || '').replace(/\s+/g, ' ').trim();
	var when = msg.getDate ? msg.getDate().toISOString() : nowIso_();
	var senderName = from.replace(/<.*>/, '').replace(/"/g, '').trim() || extractSingleEmail(from);
	var labels = [];
	try { labels = thread.getLabels().map(function (l) { return l.getName(); }); } catch (e) { }
	var context = 'FACTS: ' + factsToString(it.threadObj.facts) + (labels.length ? '\nLabels: ' + labels.join(', ') : '') +
		(it.threadObj.history ? '\nEarlier in thread:\n' + it.threadObj.history : '');
	var suggested = '';
	if (draft && draft.text) suggested = 'Review the draft in Gmail and send or edit.';
	else if (d.notification_text) suggested = oneLine_(d.notification_text, 200);
	else if (cls.kind === 'Action') suggested = 'Reply to this email.';
	return makeQueueRow_({
		'Name': 'Email: ' + oneLine_(senderName, 40) + ' - ' + oneLine_(subject, 80),
		'Source': 'Gmail',
		'Kind': cls.kind,
		'Status': cls.isLog ? 'Ignored' : (draft && draft.text ? 'Drafted' : 'New'),
		'Priority Tier': cls.tier,
		'Entity': gmailEntityFor_(from),
		'Reason': oneLine_(d.reason || '', 300) + ' [act:' + when + ']',
		'Quote': truncate_(it.threadObj.fullBody || '', 4000),
		'Source Ref': 'https://mail.google.com/mail/u/0/#all/' + threadId,
		'Card Key': 'gmail:' + threadId,
		'Check Date': denverDate_(new Date()),
		'Times Shown': 0,
		'Draft Text': draft && draft.text ? draft.text : '',
		'Draft Ref': draft && draft.id ? 'gmail-draft:' + draft.id : '',
		'Importance': d.importance,
		'Reason Code': d.reason_code || '',
		'Notify': d.notify ? 'TRUE' : 'FALSE',
		'Suggested Action': suggested,
		'Who': from,
		'Context': truncate_(context, 6000),
		'Event Ts': when,
		'Collector': GMAIL_COLLECTOR_NAME_,
		'Collector Version': GMAIL_COLLECTOR_VERSION_,
		'Model': CONFIG.GEMINI_MODEL_TRIAGE
	});
}

function gmailSeenKey_(it) {
	return 'gmail:' + it.threadObj.thread.getId() + '|' + it.threadObj.message.getId();
}

/**
 * Writes one run's decisions to the queue sheet.
 * items: [{msgId, decision, threadObj}]. draftInfo: {msgId: {text, id}}.
 * Returns true when it is safe to advance LAST_PROCESSED_TIMESTAMP.
 * A failed write returns false for the first (GMAIL_SINK_MAX_FAILS_ - 1) runs so rows are retried.
 * After that it gives up on those rows, says so loudly, and returns true so the run is not stuck.
 */
function flushQueue_(items, draftInfo) {
	if (CONFIG.ENABLE_QUEUE_SINK === false) return true;
	if (!items.length) return true;
	if (!queueConfigured_()) {
		Logger.log('QUEUE skipped: QUEUE_WEBHOOK_URL is not set. Run runConfig to set it.');
		return true;
	}
	State_.load();
	Seen_.reset();
	Seen_.load();
	var qRows = [], logRows = [], keys = [];
	items.forEach(function (it) {
		var sk = gmailSeenKey_(it);
		var tag = emailTag(it.msgId, it.threadObj.message, it.threadObj.thread);
		if (Seen_.has(sk)) { Logger.log('QUEUE skip ' + tag + ' already written earlier'); return; }
		var row = gmailRowFor_(it, draftInfo[it.msgId]);
		var isLog = row['Kind'] === 'Log';
		if (isLog && CONFIG.LOG_IGNORED === false) { keys.push(sk); return; }
		(isLog ? logRows : qRows).push(row);
		keys.push(sk);
		Logger.log('QUEUE ' + (isLog ? 'log' : 'row') + ' ' + tag + ' kind=' + row['Kind'] + ' tier=' + (row['Priority Tier'] || '-') + ' status=' + row['Status']);
	});
	if (CONFIG.QUEUE_DRY_RUN === true) {
		Logger.log('QUEUE_DRY_RUN: would write ' + qRows.length + ' queue rows and ' + logRows.length + ' log rows. Nothing sent.');
		return true;
	}
	var res = queueEnqueue_(CONFIG.QUEUE_SHEET || 'Queue', qRows);
	if (!res.ok) {
		var fails = Number(State_.get('GM_SINK_FAILS') || 0) + 1;
		State_.set('GM_SINK_FAILS', fails);
		State_.flush();
		Logger.log('QUEUE FAIL (' + fails + ' of ' + GMAIL_SINK_MAX_FAILS_ + '): ' + res.errors.join(' | '));
		if (fails >= GMAIL_SINK_MAX_FAILS_) {
			Logger.log('QUEUE GIVING UP on ' + qRows.length + ' row(s) after ' + fails + ' failed runs. Fix the sink. Those emails stay labeled in Gmail.');
			sendTextWebhook_('Gmail triage: the queue sheet write failed ' + fails + ' runs in a row. ' + qRows.length + ' row(s) were dropped. Check QUEUE_WEBHOOK_URL.');
			State_.set('GM_SINK_FAILS', 0);
			State_.flush();
			return true;
		}
		return false;
	}
	if (logRows.length) {
		var ls = queueEnqueue_(CONFIG.LOG_SHEET || 'Triage_Log', logRows);
		if (!ls.ok) Logger.log('QUEUE WARN log write failed: ' + ls.errors.join(' | '));
	}
	keys.forEach(function (k) { Seen_.add(k); });
	State_.set('GM_SINK_FAILS', 0);
	State_.flush();
	Logger.log('QUEUE wrote ' + res.inserted + ' queue row(s) and ' + logRows.length + ' log row(s).');
	return true;
}

// ---- Diagnostics and ops ----------------------------------------------------------------

function diagnoseQueue() {
	Logger.log('queue configured: ' + queueConfigured_());
	[CONFIG.QUEUE_SHEET || 'Queue', CONFIG.LOG_SHEET || 'Triage_Log'].forEach(function (sn) {
		var v = queueVerifySchema_(sn);
		Logger.log('sheet "' + sn + '" ok=' + v.ok + (v.ok ? '' : ' missing=' + JSON.stringify(v.missing || v.error) + ' sample=' + (v.rawSample || '')));
	});
}

// Writes one test row to the log tab. Confirms the webhook accepts POST and the columns match.
function testQueueSink() {
	var row = makeQueueRow_({ 'Name': 'TEST gmail-triage sink check', 'Source': 'Gmail', 'Kind': 'Log', 'Status': 'Test',
		'Reason': 'Safe to delete.', 'Collector': GMAIL_COLLECTOR_NAME_, 'Collector Version': GMAIL_COLLECTOR_VERSION_, 'Event Ts': nowIso_() });
	Logger.log('testQueueSink ' + JSON.stringify(queueEnqueue_(CONFIG.LOG_SHEET || 'Triage_Log', [row])));
}

// Clears the queue seen-store. Next run may write rows again for unread mail in the lookback window.
function resetQueueSeen() {
	var sp = PropertiesService.getScriptProperties(), all = sp.getProperties();
	Object.keys(all).forEach(function (k) { if (k.indexOf('SEEN_') === 0 || k === 'GM_SINK_FAILS') sp.deleteProperty(k); });
	Logger.log('Queue seen-store cleared.');
}
