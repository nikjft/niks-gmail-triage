// QueueStore.js - shared by the Slack, Trello and Gmail triage repos. Keep byte-identical in all three.
// Read and close rows on the queue sheet through the google-sheet-mcp JSON-RPC endpoint (tools/call).
// The webhook in QueueSink.js is insert-only. The staleness sweep needs reads and updates, so it uses the MCP tools
// get_filtered_sheet_contents and update_row. Same Script Properties as QueueSink.js: QUEUE_WEBHOOK_URL, QUEUE_API_KEY.
// Nothing here ever calls delete_row. A row is closed with Status Done, Closed At and Closeout in one update_row.

// Statuses the sweep may close. Snoozed is never swept (Nik parked it on purpose). Ignored and Test are not queue items.
var SWEEP_OPEN_STATUSES_ = ['New', 'Drafted', 'Approved', 'Waiting'];
var SWEEP_COLUMNS_ = ['_uid', 'Name', 'Source', 'Kind', 'Status', 'Reason', 'Reason Code', 'Source Ref', 'Card Key', 'Flag Key',
	'Event Ts', 'Lease', 'Draft Ref', 'Parent', 'Collector', '_created_at'];

// Card Key for comparison. The Gmail collector once wrote email:<threadId>.
function sweepKey_(k) { return String(k || '').trim().replace(/^email:/, 'gmail:'); }

// Calls one MCP tool. Returns {ok, data, error}. data is the parsed JSON text of the tool result.
function queueRpc_(tool, args) {
	var p = queueProps_();
	var url = p.url + (p.key ? (p.url.indexOf('?') === -1 ? '?' : '&') + 'apiKey=' + encodeURIComponent(p.key) : '');
	var res = http_(url, {
		method: 'post', contentType: 'application/json', followRedirects: true,
		payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } })
	}, { attempts: 2 });
	var data = parseJson_(res.text);
	if (!data) return { ok: false, error: 'HTTP ' + res.code + ' ' + maskSecrets_(oneLine_(res.text, 200)) };
	if (data.error) return { ok: false, error: maskSecrets_(oneLine_(data.error.message || JSON.stringify(data.error), 200)) };
	var r = data.result, text = r && r.content && r.content[0] && r.content[0].text;
	if (!r || r.isError) return { ok: false, error: maskSecrets_(oneLine_(text || 'empty result', 200)) };
	return { ok: true, data: parseJson_(text) || {} };
}

// Strips a markdown link wrapper: [text](url) -> url.
function unwrapRef_(s) {
	var t = String(s == null ? '' : s).trim(), m = t.match(/^\[[^\]]*\]\(([^)]+)\)$/);
	return (m ? m[1] : t).trim();
}

// Open rows for the given sources (case-insensitive names, e.g. ['gmail', 'email']), oldest first.
// Reads server side by Status. Only rows the channel's own collector wrote (opts.collector) are judged directly.
// Never judged directly: child rows (non-empty Parent, Nik's instructions), Manual rows, rows inserted by Claude or review,
// Log rows, rows with a Lease (a worker is mid-flight), and collector gate rows (Source Ref needs-help:...).
// Children close only through their parent (see runQueueSweep_).
// Snoozed rows are read too, to find the newest row of a group (see supersededRows_). The only Snoozed rows the sweep
// ever closes are older snoozes behind a newer snooze on the same item.
// Returns {ok, rows, snoozed, children: {parentUid: [rows]}, error}.
function queueReadOpenRows_(sources, opts) {
	opts = opts || {};
	var want = {};
	sources.forEach(function (s) { want[String(s).toLowerCase()] = true; });
	var filters = SWEEP_OPEN_STATUSES_.concat(['Snoozed']).map(function (s) { return { column: 'Status', operator: 'eq', value: s }; });
	var rows = [], offset = 0, limit = 200, guard = 0;
	while (guard++ < 50) {
		var r = queueRpc_('get_filtered_sheet_contents', {
			sheetName: opts.sheet || 'Queue', filters: filters, matchAll: false, columns: SWEEP_COLUMNS_,
			limit: limit, offset: offset, maxCellLength: 400
		});
		if (!r.ok) return { ok: false, rows: [], error: r.error };
		var page = r.data.rows || [];
		rows = rows.concat(page);
		if (page.length < limit) break;
		offset += limit;
	}
	// Open child rows (non-empty Parent), any source. A queued next step hangs off its parent row.
	var children = {};
	rows.forEach(function (row) {
		var par = String(row['Parent'] || '').trim();
		if (!par || String(row['Kind'] || '') === 'Log' || String(row['Lease'] || '').trim() || !row['_uid']) return;
		if (String(row['Status']) === 'Snoozed') return;
		if (unwrapRef_(row['Source Ref']).indexOf('needs-help:') === 0) return;
		(children[par] = children[par] || []).push(row);
	});
	rows = rows.filter(function (row) {
		if (!want[String(row['Source'] || '').toLowerCase()]) return false;
		if (SWEEP_OPEN_STATUSES_.indexOf(String(row['Status'])) === -1 && String(row['Status']) !== 'Snoozed') return false;
		if (String(row['Parent'] || '').trim()) return false;
		if (opts.collector && String(row['Collector'] || '').trim() !== opts.collector) return false;
		if (String(row['Kind'] || '') === 'Log') return false;
		if (String(row['Lease'] || '').trim()) return false;
		if (unwrapRef_(row['Source Ref']).indexOf('needs-help:') === 0) return false;
		return !!row['_uid'];
	});
	var snoozed = rows.filter(function (row) { return String(row['Status']) === 'Snoozed'; });
	rows = rows.filter(function (row) { return String(row['Status']) !== 'Snoozed'; });
	var minAgeMs = (opts.minAgeHours || 0) * 3600000;
	if (minAgeMs) {
		rows = rows.filter(function (row) {
			var t = Date.parse(row['_created_at']);
			return isNaN(t) || Date.now() - t >= minAgeMs;
		});
	}
	rows.sort(function (a, b) { return (Date.parse(a['_created_at']) || 0) - (Date.parse(b['_created_at']) || 0); });
	return { ok: true, rows: rows, snoozed: snoozed, children: children };
}

// Older rows of a thread or card that a newer collector row supersedes (the review's current-row rule).
// Group by Card Key + Flag Key. The newest _created_at is current (Event Ts breaks a tie). Older rows with Status New close.
// Older Snoozed rows close only when the newest row is Snoozed too (one snooze per item); behind a New row they stay.
// Drafted, Approved and Waiting are work in motion and never close here.
// Returns [{row, keepUid}].
function supersededRows_(rows, snoozed) {
	var groups = {};
	rows.concat(snoozed || []).forEach(function (row) {
		var key = sweepKey_(row['Card Key']);
		if (!key) return;
		key += '|' + String(row['Flag Key'] || '').trim();
		(groups[key] = groups[key] || []).push(row);
	});
	var at = function (row) { return Date.parse(row['_created_at']) || 0; };
	var ev = function (row) { return Date.parse(row['Event Ts']) || 0; };
	var out = [];
	Object.keys(groups).forEach(function (k) {
		var g = groups[k];
		if (g.length < 2) return;
		g.sort(function (a, b) { return (at(b) - at(a)) || (ev(b) - ev(a)); });
		var keep = g[0];
		g.slice(1).forEach(function (row) {
			var st = String(row['Status']);
			if (st === 'New' || (st === 'Snoozed' && String(keep['Status']) === 'Snoozed')) out.push({ row: row, keepUid: keep['_uid'] });
		});
	});
	return out;
}

// Closes one row. Never deletes. Returns {ok, error}.
function queueCloseRow_(uid, closeout) {
	var r = queueRpc_('update_row', {
		sheetName: 'Queue', rowIdentifier: { uid: uid },
		data: { 'Status': 'Done', 'Closed At': nowIso_(), 'Closeout': closeout }
	});
	if (r.ok && r.data && r.data.rowsUpdated === 0) return { ok: false, error: 'no row matched uid ' + uid };
	return r.ok ? { ok: true } : { ok: false, error: r.error };
}

// Shared driver. cfg = {
//   label: 'Gmail', sources: ['gmail','email'], collector: 'gmail-triage', cursorKey: 'SWEEP_CURSOR_GMAIL',
//   check: function (rows, ctx) -> number of rows examined (rows is already rotated to start at the cursor)
// }
// ctx = {now, budget, report, dryRun, close(row, why, opts), failed(row, why), kept(row, why)}.
// close opts.cascade (default true): also close open children on the same Card Key. Pass false when the reason does not
// make a queued action moot (a Trello comment or a moved due date is not the action a child asks for).
// A run examines as many rows as the budget allows. The rest carry to the next run through a cursor in Script Properties,
// so every row is eventually checked even when one run cannot reach them all.
function runQueueSweep_(cfg) {
	var S = CONFIG.SWEEP || {};
	var dryRun = cfg.dryRun != null ? cfg.dryRun : !!S.DRY_RUN;
	var out = withLock_(function () {
		var budget = makeBudget_(S.RUN_BUDGET_MS || 270000);
		var report = { label: cfg.label, dryRun: dryRun, open: 0, examined: 0, closed: 0, failed: 0, kept: 0, reasons: {}, errors: [], carried: 0 };
		var read = queueReadOpenRows_(cfg.sources, { minAgeHours: S.MIN_ROW_AGE_HOURS || 0, collector: cfg.collector });
		if (!read.ok) {
			report.errors.push('read queue: ' + read.error);
			return report;
		}
		var rows = read.rows, children = read.children, closedUids = {};
		report.cascaded = 0;
		report.merged = 0;
		report.open = rows.length;
		if (!rows.length) return report;

		var sp = PropertiesService.getScriptProperties();
		var start = (Number(sp.getProperty(cfg.cursorKey)) || 0) % rows.length;
		var ordered = rows.slice(start).concat(rows.slice(0, start));
		var maxRows = S.MAX_ROWS_PER_RUN || 150;

		function closeOne(row, why, parentUid, cascade) {
			var uid = row['_uid'];
			if (closedUids[uid]) return false;
			var label = parentUid ? 'stale sweep: parent ' + parentUid + ' closed (' + why + ')' : 'stale sweep: ' + why;
			if (dryRun) {
				Logger.log('DRY would close ' + uid + ' [' + oneLine_(row['Name'], 60) + '] ' + label);
			} else {
				var w = queueCloseRow_(uid, label);
				if (!w.ok) { report.failed++; report.errors.push('close ' + uid + ': ' + w.error); return false; }
				Logger.log('CLOSED ' + uid + ' [' + oneLine_(row['Name'], 60) + '] ' + label);
			}
			closedUids[uid] = true;
			report.closed++;
			if (parentUid) report.cascaded++;
			else { var rk = why.replace(/ [0-9a-f-]{36}$/, ''); report.reasons[rk] = (report.reasons[rk] || 0) + 1; }
			if (cascade) {
				var key = sweepKey_(row['Card Key']);
				(children[uid] || []).forEach(function (child) {
					if (key && sweepKey_(child['Card Key']) === key) closeOne(child, why, uid, true);
				});
			}
			return true;
		}

		var ctx = {
			now: new Date(), budget: budget, report: report, dryRun: dryRun, maxRows: maxRows,
			// Closes the row. With cascade, also closes every open queued next step under it (Parent = this row's _uid,
			// recursively) that sits on the same Card Key: a queued reply to a thread or card that is already handled.
			// Children on another channel or card are separate instructions and stay open. Leased and Snoozed children stay too.
			close: function (row, why, opts) { return closeOne(row, why, '', !(opts && opts.cascade === false)); },
			failed: function (row, why) { report.failed++; Logger.log('UNREADABLE ' + row['_uid'] + ': ' + why); },
			kept: function () { report.kept++; }
		};
		// Sheet-only pass first: close older rows that a newer row on the same thread or card supersedes. No API calls.
		supersededRows_(rows, read.snoozed).forEach(function (s) {
			if (closeOne(s.row, 'merged into ' + s.keepUid, '', false)) report.merged++;
		});
		ordered = ordered.filter(function (row) { return !closedUids[row['_uid']]; });
		var n = Math.min(cfg.check(ordered, ctx) || 0, ordered.length);
		report.examined = n;
		report.carried = ordered.length - n;
		if (!dryRun && ordered.length) sp.setProperty(cfg.cursorKey, String((start + n) % ordered.length));
		return report;
	});
	if (!out) return null;
	var reasons = Object.keys(out.reasons).map(function (k) { return k + ' ' + out.reasons[k]; }).join('; ');
	Logger.log('Sweep ' + out.label + (out.dryRun ? ' (DRY RUN)' : '') + ': open ' + out.open + ', examined ' + out.examined +
		', closed ' + out.closed + ' (incl. ' + out.cascaded + ' queued next steps of closed rows, ' + out.merged + ' merged into a newer row)' + (reasons ? ' (' + reasons + ')' : '') + ', kept ' + out.kept + ', unreadable/failed ' + out.failed +
		', carried to next run ' + out.carried + (out.errors.length ? ' | errors: ' + out.errors.slice(0, 5).join(' | ') : ''));
	return out;
}

// Creates the daily trigger for fnName at CONFIG.SWEEP.TRIGGER_HOUR (Denver, from appsscript.json). Replaces an existing one.
function installSweepTrigger_(fnName) {
	ScriptApp.getProjectTriggers().forEach(function (t) {
		if (t.getHandlerFunction() === fnName) ScriptApp.deleteTrigger(t);
	});
	var hour = (CONFIG.SWEEP && CONFIG.SWEEP.TRIGGER_HOUR != null) ? CONFIG.SWEEP.TRIGGER_HOUR : 5;
	ScriptApp.newTrigger(fnName).timeBased().everyDays(1).atHour(hour).create();
	Logger.log('Trigger set: ' + fnName + ' daily at about ' + hour + ':00 (script time zone). Change CONFIG.SWEEP.TRIGGER_HOUR or add more triggers by hand to run it more often.');
}
