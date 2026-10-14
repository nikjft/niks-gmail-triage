// GmailStaleness.js - scheduled staleness sweep for Gmail rows on the queue sheet. Deterministic. No Gemini.
// Read-only against Gmail. Closes an open Gmail row when:
//   1. the last message in the thread (drafts ignored) is from Nik or one of his aliases, or
//   2. the thread is archived and not starred.
// Queued next steps under a closed row (Parent = its _uid) close with it. See runQueueSweep_ in QueueStore.js.
// Snoozed queue rows are never touched. A thread that cannot be read is left alone.
// A Gmail draft on a closed row is left in place. Deleting drafts stays with the daily kill cleanup.

function runGmailStalenessSweep() { return runGmailStaleness_({}); }
function runGmailStalenessSweepDry() { return runGmailStaleness_({ dryRun: true }); }
function setupStalenessTrigger() { installSweepTrigger_('runGmailStalenessSweep'); }

function gmailThreadIdOf_(row) {
	var m = String(row['Card Key'] || '').match(/^(?:gmail|email):([A-Za-z0-9]+)$/);
	if (m) return m[1];
	var u = unwrapRef_(row['Source Ref']).match(/#[a-z]+\/([A-Za-z0-9]+)\s*$/);
	return u ? u[1] : '';
}

// Lowercased set of Nik's addresses: the account and its aliases. Built once per run.
function gmailMyAddresses_() {
	var set = {};
	try { set[Session.getActiveUser().getEmail().toLowerCase()] = true; } catch (e) { }
	try { GmailApp.getAliases().forEach(function (a) { set[a.toLowerCase()] = true; }); } catch (e) { }
	return set;
}

// Why this thread makes the row stale, '' when it does not. mine = set of Nik's addresses.
function gmailStaleReason_(thread, mine) {
	var msgs = thread.getMessages().filter(function (m) { return !m.isDraft(); });
	if (msgs.length) {
		var last = msgs[msgs.length - 1];
		if (mine[extractSingleEmail(last.getFrom())]) return 'last reply in thread is from Nik';
	}
	if (thread.isInTrash() || (!thread.isInInbox() && !thread.hasStarredMessages())) return 'email archived and not starred';
	return '';
}

function runGmailStaleness_(opts) {
	return runQueueSweep_({
		label: 'Gmail', sources: ['gmail', 'email'], cursorKey: 'SWEEP_CURSOR_GMAIL', dryRun: opts.dryRun,
		check: function (rows, ctx) {
			var mine = gmailMyAddresses_();
			var n = 0;
			for (; n < rows.length && n < ctx.maxRows; n++) {
				if (ctx.budget.expired(15000)) break;
				var row = rows[n], id = gmailThreadIdOf_(row);
				if (!id) { ctx.kept(row); continue; }
				var thread = null;
				try { thread = GmailApp.getThreadById(id); } catch (e) { }
				if (!thread) { ctx.failed(row, 'thread ' + id + ' not readable'); continue; }
				var why;
				try { why = gmailStaleReason_(thread, mine); } catch (e) { ctx.failed(row, 'thread ' + id + ': ' + oneLine_(e.message || e, 100)); continue; }
				if (why) ctx.close(row, why); else ctx.kept(row);
			}
			return n;
		}
	});
}
