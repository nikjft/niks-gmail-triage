/**
 * Util.js - helpers shared by niks-slack-triage and niks-trello-triage.
 * Keep this file byte-identical in both repos (and in niks-gmail-triage when it adopts the queue sink).
 *
 * Apps Script loads files in an unspecified order. Nothing here runs at load time.
 * Config.js must not call anything defined here at load time either.
 */
var UTIL_VERSION = '2026-10-06';
var TZ_DENVER = 'America/Denver';

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------
function nowIso_() { return new Date().toISOString(); }
function denverDate_(d) { return Utilities.formatDate(d || new Date(), TZ_DENVER, 'yyyy-MM-dd'); }
function denverDow_(d) {
	var n = Number(Utilities.formatDate(d || new Date(), TZ_DENVER, 'u')); // 1=Mon ... 7=Sun
	return n === 7 ? 0 : n;
}
function denverHour_(d) { return Number(Utilities.formatDate(d || new Date(), TZ_DENVER, 'H')); }
function isBusinessDay_(d) { var w = denverDow_(d); return w >= 1 && w <= 5; }

function dateParts_(s) { return Date.UTC(Number(s.substr(0, 4)), Number(s.substr(5, 2)) - 1, Number(s.substr(8, 2))); }
/** Calendar days from a to b, both yyyy-MM-dd. */
function daysBetweenDates_(a, b) { return Math.round((dateParts_(b) - dateParts_(a)) / 86400000); }
/** Mon-Fri days after fromDate, up to and including toDate. Both yyyy-MM-dd. */
function businessDaysSince_(fromDate, toDate) {
	var span = daysBetweenDates_(fromDate, toDate), start = dateParts_(fromDate), n = 0;
	for (var i = 1; i <= span; i++) {
		var w = new Date(start + i * 86400000).getUTCDay();
		if (w >= 1 && w <= 5) n++;
	}
	return n;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------
function oneLine_(s, n) {
	var t = (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
	return n && t.length > n ? t.substring(0, n - 3) + '...' : t;
}
function truncate_(s, n) {
	s = (s == null ? '' : String(s));
	return s.length > n ? s.substring(0, n) + ' [truncated, ' + (s.length - n) + ' more chars]' : s;
}
function hash8_(s) {
	var d = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(s), Utilities.Charset.UTF_8), out = '';
	for (var i = 0; i < 4; i++) out += ('0' + ((d[i] + 256) % 256).toString(16)).slice(-2);
	return out;
}
function maskSecrets_(s) {
	return String(s == null ? '' : s).replace(/([?&](?:key|apiKey|token)=)[^&\s"]+/g, '$1***').replace(/xox[a-z]-[A-Za-z0-9-]+/g, 'xox***');
}

// ---------------------------------------------------------------------------
// HTTP with retry. Returns {code, text, headers, rateLimited?, retryAfterMs?}. Never throws on HTTP status.
// opts.maxWaitMs: if a rate-limit wait is longer than this, return instead of sleeping.
// ---------------------------------------------------------------------------
function http_(url, options, opts) {
	options = options || {};
	opts = opts || {};
	options.muteHttpExceptions = true;
	var attempts = opts.attempts || 3, last = null;
	for (var i = 0; i < attempts; i++) {
		var res = UrlFetchApp.fetch(url, options);
		var code = res.getResponseCode();
		var headers = res.getHeaders ? res.getHeaders() : {};
		last = { code: code, text: res.getContentText(), headers: headers };
		if (code !== 429 && code < 500) return last;
		var ra = Number(headers['Retry-After'] || headers['retry-after'] || 0);
		var wait = ra > 0 ? ra * 1000 : 1000 * Math.pow(2, i);
		if (opts.maxWaitMs && wait > opts.maxWaitMs) {
			last.rateLimited = code === 429;
			last.retryAfterMs = wait;
			return last;
		}
		if (i < attempts - 1) Utilities.sleep(Math.min(wait, 20000));
	}
	if (last && last.code === 429) last.rateLimited = true;
	return last;
}

function parseJson_(text) {
	try { return JSON.parse(text); } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// Run budget (Apps Script stops a run at 6 minutes)
// ---------------------------------------------------------------------------
function makeBudget_(ms) {
	var start = Date.now();
	return {
		left: function () { return ms - (Date.now() - start); },
		expired: function (reserveMs) { return ms - (Date.now() - start) < (reserveMs || 0); }
	};
}

function withLock_(fn) {
	var lock = LockService.getScriptLock();
	if (!lock.tryLock(5000)) {
		Logger.log('SKIP another run holds the lock.');
		return null;
	}
	try { return fn(); } finally { lock.releaseLock(); }
}

// ---------------------------------------------------------------------------
// State in Script Properties. One read per run, one batched write at the end.
// Commit state only after the queue write succeeds.
// ---------------------------------------------------------------------------
var State_ = {
	_cache: null, _dirty: {}, _del: {},
	load: function () {
		this._cache = PropertiesService.getScriptProperties().getProperties() || {};
		this._dirty = {};
		this._del = {};
	},
	get: function (k) {
		if (!this._cache) this.load();
		return Object.prototype.hasOwnProperty.call(this._cache, k) ? this._cache[k] : null;
	},
	set: function (k, v) {
		if (!this._cache) this.load();
		this._cache[k] = String(v);
		this._dirty[k] = String(v);
		delete this._del[k];
	},
	del: function (k) {
		if (!this._cache) this.load();
		delete this._cache[k];
		delete this._dirty[k];
		this._del[k] = true;
	},
	keys: function (prefix) {
		if (!this._cache) this.load();
		return Object.keys(this._cache).filter(function (k) { return k.indexOf(prefix) === 0; });
	},
	flush: function () {
		var sp = PropertiesService.getScriptProperties();
		if (Object.keys(this._dirty).length) sp.setProperties(this._dirty);
		Object.keys(this._del).forEach(function (k) { sp.deleteProperty(k); });
		this._dirty = {};
		this._del = {};
	},
	discard: function () { this._cache = null; this._dirty = {}; this._del = {}; }
};

// ---------------------------------------------------------------------------
// Seen store: short hashes of "Card Key|activity token" so a retry never writes the same row twice.
// Buckets per Denver day, pruned after SEEN_TTL_DAYS.
// ---------------------------------------------------------------------------
var SEEN_TTL_DAYS = 14;
var Seen_ = {
	_set: null,
	load: function () {
		this._set = {};
		var today = denverDate_(), self = this;
		State_.keys('SEEN_').forEach(function (k) {
			var m = k.match(/^SEEN_(\d{4}-\d{2}-\d{2})_(\d+)$/);
			if (!m) return;
			if (daysBetweenDates_(m[1], today) > SEEN_TTL_DAYS) { State_.del(k); return; }
			var arr = parseJson_(State_.get(k)) || [];
			arr.forEach(function (h) { self._set[h] = true; });
		});
	},
	has: function (key) {
		if (!this._set) this.load();
		return this._set[hash8_(key)] === true;
	},
	add: function (key) {
		if (!this._set) this.load();
		var h = hash8_(key);
		if (this._set[h]) return;
		this._set[h] = true;
		var today = denverDate_(), n = 0, name;
		State_.keys('SEEN_' + today + '_').forEach(function (k) { n = Math.max(n, Number(k.split('_')[2])); });
		name = 'SEEN_' + today + '_' + n;
		var arr = parseJson_(State_.get(name)) || [];
		if (JSON.stringify(arr).length > 7500) { n++; name = 'SEEN_' + today + '_' + n; arr = []; }
		arr.push(h);
		State_.set(name, JSON.stringify(arr));
	},
	reset: function () { this._set = null; }
};

// ---------------------------------------------------------------------------
// Cadence. A frequent trigger calls shouldRunNow_ and exits cheaply when it is not time.
// table rows: {days:[0-6, 0=Sun], from:hour, to:hour (exclusive), everyMin:N}
// ---------------------------------------------------------------------------
function cadenceEveryMin_(table, now) {
	var dow = denverDow_(now), hr = denverHour_(now);
	for (var i = 0; i < table.length; i++) {
		var r = table[i];
		if (r.days.indexOf(dow) !== -1 && hr >= r.from && hr < r.to) return r.everyMin;
	}
	return null;
}
function shouldRunNow_(lastRunIso, table, now) {
	now = now || new Date();
	var every = cadenceEveryMin_(table, now);
	if (every === null) return { run: false, reason: 'quiet hours' };
	if (!lastRunIso) return { run: true, reason: 'first run' };
	var elapsed = (now.getTime() - new Date(lastRunIso).getTime()) / 60000;
	if (elapsed >= every - 1) return { run: true, reason: 'due (' + Math.round(elapsed) + ' min since last, every ' + every + ')' };
	return { run: false, reason: 'not due (' + Math.round(elapsed) + ' of ' + every + ' min)' };
}
