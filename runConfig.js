// runConfig.js - one-time loader for Script Properties (secrets).
//
// HOW TO USE
// 1. Push this file with empty values (clasp push).
// 2. Open the project in the Apps Script editor. Paste your values below. Do not click Save in git.
// 3. Pick runConfig in the function dropdown and click Run. Authorize if asked.
// 4. Read the execution log. It lists each property as set, updated or skipped. It never prints a value.
// 5. Delete this file in the editor, or push the empty version again to overwrite it.
//
// Rules
// - An empty value is skipped. An existing property is never erased.
// - Run it again any time to rotate a key.
// - Never run `clasp pull` while real values are in this file. It would copy them into your repo.
// - This file is safe to commit only while every value is ''.

var RUN_CONFIG_VALUES_ = {
	// Required. Gemini API key. Create one at https://aistudio.google.com/apikey (the same key can serve all three tools).
	GEMINI_API_KEY: '',

	// Required. The google-sheet-mcp web app URL. It ends in /exec. Same deployment the Slack and Trello tools use.
	QUEUE_WEBHOOK_URL: '',

	// Required. The API key configured on the google-sheet-mcp project. It is sent as ?apiKey= on each write.
	QUEUE_API_KEY: '',

	// Optional. A webhook URL for push alerts on urgent email (Zapier, Pushover). Leave empty to skip alerts.
	WEBHOOK_URL: '',

};

// Properties that must exist before the tool can run.
var RUN_CONFIG_REQUIRED_ = ['GEMINI_API_KEY', 'QUEUE_WEBHOOK_URL', 'QUEUE_API_KEY'];

// Light format checks. A failed check skips that property and says why.
var RUN_CONFIG_CHECKS_ = {
	QUEUE_WEBHOOK_URL: function (v) { return /^https:\/\//.test(v) ? null : 'Must start with https://'; },
	WEBHOOK_URL: function (v) { return /^https:\/\//.test(v) ? null : 'Must start with https://'; },
};

function runConfig() {
	var sp = PropertiesService.getScriptProperties();
	var existing = sp.getProperties(), toSet = {}, lines = [];
	Object.keys(RUN_CONFIG_VALUES_).forEach(function (k) {
		var v = String(RUN_CONFIG_VALUES_[k] == null ? '' : RUN_CONFIG_VALUES_[k]).trim();
		if (!v) { lines.push(k + ': skipped (empty)' + (existing[k] ? ', existing value kept' : '')); return; }
		var chk = RUN_CONFIG_CHECKS_[k], bad = chk ? chk(v) : null;
		if (bad) { lines.push(k + ': NOT SET. ' + bad); return; }
		toSet[k] = v;
		lines.push(k + ': ' + (existing[k] ? 'updated' : 'set') + ' (' + v.length + ' chars)');
	});
	if (Object.keys(toSet).length) sp.setProperties(toSet);
	var now = sp.getProperties();
	var missing = RUN_CONFIG_REQUIRED_.filter(function (k) { return !now[k]; });
	lines.forEach(function (l) { Logger.log(l); });
	Logger.log(missing.length ? 'STILL MISSING: ' + missing.join(', ') : 'All required properties are set.');
	Logger.log('Next: delete this file or push the empty version over it.');
}

// Shows which properties exist. Never prints a value.
function runConfigCheck() {
	var now = PropertiesService.getScriptProperties().getProperties();
	Object.keys(RUN_CONFIG_VALUES_).forEach(function (k) {
		Logger.log(k + ': ' + (now[k] ? 'set (' + String(now[k]).length + ' chars)' : 'not set') + (RUN_CONFIG_REQUIRED_.indexOf(k) !== -1 ? ' [required]' : ' [optional]'));
	});
}
