// QueueSink.js - shared by the Slack and Trello triage repos. Keep byte-identical in both.
// Writes queue rows to the Google Sheet through the google-sheet-mcp web app webhook.
// Webhook: POST <exec>?action=webhook&sheetName=X&apiKey=Y with a JSON array body.
// The webhook is insert-only. Duplicate protection is the client Seen_ store.
// Script Properties: QUEUE_WEBHOOK_URL (the /exec URL), QUEUE_API_KEY.

// Non-system columns. _uid, _created_at, _updated_at are filled by the sheet.
var QUEUE_COLUMNS = [
	'Name', 'Source', 'Kind', 'Status', 'Priority Tier', 'Entity', 'Reason', 'Quote',
	'Source Ref', 'Card Key', 'Flag Key', 'Check Date', 'Times Shown',
	'Draft Text', 'Draft Ref', 'Closeout', 'Closed At', 'Lease', 'Next Owner', 'Parent',
	'Importance', 'Reason Code', 'Notify', 'Suggested Action', 'Who', 'Open Ask', 'Context',
	'Event Ts', 'Collector', 'Collector Version', 'Model'
];

// Build a full row with every column present (empty string when unknown).
function makeQueueRow_(fields) {
	var row = {};
	QUEUE_COLUMNS.forEach(function (c) { row[c] = ''; });
	Object.keys(fields || {}).forEach(function (k) {
		if (row.hasOwnProperty(k)) row[k] = fields[k] == null ? '' : fields[k];
	});
	// Sheets cells cap at 50k chars. Keep long fields well under it.
	['Quote', 'Context', 'Draft Text', 'Open Ask', 'Reason'].forEach(function (k) {
		if (typeof row[k] === 'string' && row[k].length > 8000) row[k] = row[k].substring(0, 8000) + ' [truncated]';
	});
	return row;
}

function queueProps_() {
	var sp = PropertiesService.getScriptProperties();
	var url = sp.getProperty('QUEUE_WEBHOOK_URL'), key = sp.getProperty('QUEUE_API_KEY');
	if (!url) throw new Error('QUEUE_WEBHOOK_URL is not set in Script Properties.');
	return { url: url, key: key || '' };
}

function queueUrl_(sheetName, extra) {
	var p = queueProps_();
	var u = p.url + (p.url.indexOf('?') === -1 ? '?' : '&') + 'action=webhook&sheetName=' + encodeURIComponent(sheetName);
	if (p.key) u += '&apiKey=' + encodeURIComponent(p.key);
	return u + (extra || '');
}

// Insert rows in chunks. Returns {ok, inserted, ignoredFields[], errors[]}.
// Any chunk failure sets ok=false. The caller must not commit watermarks unless ok.
function queueEnqueue_(sheetName, rows, opts) {
	opts = opts || {};
	var out = { ok: true, inserted: 0, ignoredFields: [], errors: [], assignedIds: [] };
	if (!rows || !rows.length) return out;
	var chunk = opts.chunk || 20;
	for (var i = 0; i < rows.length; i += chunk) {
		var part = rows.slice(i, i + chunk);
		var res = http_(queueUrl_(sheetName), {
			method: 'post', contentType: 'application/json', payload: JSON.stringify(part), followRedirects: true
		}, { attempts: 2 });
		var data = parseJson_(res.text);
		if (res.code >= 300 || !data || data.success === false || data.error) {
			out.ok = false;
			out.errors.push('HTTP ' + res.code + ' ' + maskSecrets_(oneLine_((data && (data.error || data.message)) || res.text, 200)));
			break;
		}
		out.inserted += Number(data.insertedRows != null ? data.insertedRows : part.length);
		(data.ignoredFields || []).forEach(function (f) { if (out.ignoredFields.indexOf(f) === -1) out.ignoredFields.push(f); });
		(data.assignedIds || []).forEach(function (id) { out.assignedIds.push(id); });
	}
	if (out.ignoredFields.length) Logger.log('WARN sheet "' + sheetName + '" is missing columns: ' + out.ignoredFields.join(', '));
	return out;
}

// Diagnostic. Calls the MCP get_sheet_schema tool and compares headers to QUEUE_COLUMNS.
function queueVerifySchema_(sheetName) {
	var p = queueProps_();
	var url = p.url + (p.url.indexOf('?') === -1 ? '?' : '&') + (p.key ? 'apiKey=' + encodeURIComponent(p.key) : '');
	var res = http_(url, {
		method: 'post', contentType: 'application/json', followRedirects: true,
		payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_sheet_schema', arguments: { sheetName: sheetName } } })
	}, { attempts: 2 });
	var data = parseJson_(res.text);
	if (!data) return { ok: false, error: 'HTTP ' + res.code + ' ' + oneLine_(res.text, 200) };
	var text = data.result && data.result.content && data.result.content[0] && data.result.content[0].text;
	var schema = parseJson_(text) || {};
	var headers = schema.headers || schema.columns || [];
	if (headers.length && typeof headers[0] === 'object') headers = headers.map(function (h) { return h.name || h.header; });
	var have = {};
	headers.forEach(function (h) { have[String(h).toLowerCase()] = true; });
	var missing = QUEUE_COLUMNS.filter(function (c) { return !have[c.toLowerCase()]; });
	return { ok: missing.length === 0, missing: missing, headers: headers, rawSample: oneLine_(text, 300) };
}

// Alert / draft webhook. mode: 'TEXT' (Slack-style {text}), 'JSON' (full object), 'URL_PARAM' (query string).
// url comes from Script Properties (ALERT_WEBHOOK_URL). Silent when unset.
function alertWebhook_(payload, mode) {
	var url = PropertiesService.getScriptProperties().getProperty('ALERT_WEBHOOK_URL');
	if (!url) return { ok: false, skipped: true };
	mode = mode || 'JSON';
	var res;
	if (mode === 'URL_PARAM') {
		var qs = Object.keys(payload).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(String(payload[k])); }).join('&');
		res = http_(url + (url.indexOf('?') === -1 ? '?' : '&') + qs, { method: 'get' }, { attempts: 2 });
	} else {
		var body = mode === 'TEXT' ? { text: payload.text || JSON.stringify(payload) } : payload;
		res = http_(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(body) }, { attempts: 2 });
	}
	return { ok: res.code < 300, code: res.code };
}
