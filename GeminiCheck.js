// GeminiCheck.js - diagnostic. Shows which Gemini key this project uses and what Google says about it.
// Run diagnoseGeminiKey from the editor. Prints only the key's length and last 4 characters, never the key.
function diagnoseGeminiKey() {
	var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '';
	Logger.log('GEMINI_API_KEY: ' + (key ? key.length + ' chars, ends in ...' + key.slice(-4) : 'NOT SET'));
	if (!key) return;
	var base = 'https://generativelanguage.googleapis.com/v1beta/models';
	function show(label, res) {
		var t = res.getContentText().split(key).join('<key>');
		Logger.log(label + ': HTTP ' + res.getResponseCode() + (res.getResponseCode() === 200 ? '' : '\n' + t.substring(0, 3000)));
	}
	show('list models (no billing needed)', UrlFetchApp.fetch(base + '?pageSize=1&key=' + encodeURIComponent(key), { muteHttpExceptions: true }));
	['gemini-2.5-flash-lite', 'gemini-2.5-flash'].forEach(function (m) {
		show('generate ' + m, UrlFetchApp.fetch(base + '/' + m + ':generateContent?key=' + encodeURIComponent(key), {
			method: 'post', contentType: 'application/json', muteHttpExceptions: true,
			payload: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }], generationConfig: { maxOutputTokens: 5 } })
		}));
	});
}
