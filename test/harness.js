// Minimal Apps Script runtime mock. Loads every top-level .js file of the repo into one vm context.
const vm = require('vm'), fs = require('fs'), path = require('path'), crypto = require('crypto');

function denver(date, fmt) {
	const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hourCycle: 'h23', weekday: 'short' })
		.formatToParts(date).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
	if (fmt === 'yyyy-MM-dd') return parts.year + '-' + parts.month + '-' + parts.day;
	if (fmt === 'H') return String(Number(parts.hour));
	if (fmt === 'u') return String({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday]);
	throw new Error('formatDate pattern not mocked: ' + fmt);
}

function createEnv(rootDir, opts) {
	opts = opts || {};
	const props = Object.assign({}, opts.props || {});
	const cache = new Map();
	const logs = [];
	const env = { logs, props, fetchLog: [], handler: opts.handler || (() => ({ code: 404, text: '{}' })) };
	const sandbox = {
		console, Date, JSON, Math, Object, Array, String, Number, RegExp, Error, Intl, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
		Logger: { log: (s) => logs.push(String(s)) },
		Utilities: {
			sleep: () => { },
			computeDigest: (alg, str) => Array.from(crypto.createHash('md5').update(String(str)).digest()).map(b => b > 127 ? b - 256 : b),
			DigestAlgorithm: { MD5: 'MD5' }, Charset: { UTF_8: 'UTF_8' },
			formatDate: (d, tz, fmt) => denver(d, fmt)
		},
		PropertiesService: { getScriptProperties: () => ({
			getProperties: () => Object.assign({}, props),
			getProperty: (k) => (k in props ? props[k] : null),
			setProperty: (k, v) => { props[k] = String(v); },
			setProperties: (o) => { Object.keys(o).forEach(k => { props[k] = String(o[k]); }); },
			deleteProperty: (k) => { delete props[k]; }
		}) },
		CacheService: { getScriptCache: () => ({
			get: (k) => (cache.has(k) ? cache.get(k) : null),
			put: (k, v) => { cache.set(k, v); },
			putAll: (o) => { Object.keys(o).forEach(k => cache.set(k, o[k])); },
			getAll: (ks) => { const o = {}; ks.forEach(k => { if (cache.has(k)) o[k] = cache.get(k); }); return o; },
			removeAll: (ks) => ks.forEach(k => cache.delete(k))
		}) },
		LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => { } }) },
		UrlFetchApp: { fetch: (url, options) => {
			env.fetchLog.push({ url, options });
			const r = env.handler(url, options || {}) || { code: 404, text: '{}' };
			return { getResponseCode: () => r.code, getContentText: () => r.text, getHeaders: () => r.headers || {} };
		} },
		Session: { getActiveUser: () => ({ getEmail: () => 'nik@mcgaw.io' }) },
		GmailApp: { getAliases: () => [], getUserLabelByName: () => null },
		ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => { } }), everyHours: () => ({ create: () => { } }) }) }), deleteTrigger: () => { } }
	};
	env.ctx = vm.createContext(sandbox);
	(opts.files || fs.readdirSync(rootDir).filter(f => f.endsWith('.js')).sort()).forEach(f => {
		vm.runInContext(fs.readFileSync(path.join(rootDir, f), 'utf8'), env.ctx, { filename: f });
	});
	env.run = (code) => vm.runInContext(code, env.ctx);
	return env;
}

let failures = 0, passes = 0;
function assert(cond, msg) { if (cond) { passes++; } else { failures++; console.log('  FAIL: ' + msg); } }
function section(name) { console.log('\n# ' + name); }
function done() { console.log('\n' + passes + ' passed, ' + failures + ' failed'); process.exit(failures ? 1 : 0); }

// Gemini mock helper. decide(id, segment) returns a decision object (without id).
function geminiResponse(options, decide) {
	const body = JSON.parse(options.payload), user = body.contents[0].parts[0].text;
	const segs = user.split('\n---\nITEM id=').slice(1);
	const arr = segs.map(s => { const id = s.split('\n')[0].trim(); return Object.assign({ id }, decide(id, s)); });
	return { code: 200, text: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(arr) }] } }] }) };
}

module.exports = { createEnv, assert, section, done, geminiResponse };
