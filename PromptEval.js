/**
 * PromptEval.js
 *
 * Golden cases for the triage prompt, plus a lint for drafts. Run from the Apps Script editor.
 *   runTriageEval()   calls Gemini once with all cases and prints pass rates. Run it on the OLD and NEW
 *                     Prompts.js to get a before and after number.
 *   testLintDraft()   offline checks for lintDraft(). No API calls.
 *
 * Cases are taken from the Classification Rubric worked examples in Notion (email-triage).
 * `expect.importance` is an array of acceptable values. `draft_reply` and `notify` are exact when set.
 * Facts are passed inside the body so this works with the current orchestrator. Once Main.js builds a
 * FACTS line itself, the same text goes in the same place.
 */

var TRIAGE_EVAL_CASES = [
	{
		id: "status_change_teammate_handled",
		from: "MC <mc@mcgaw.io>",
		subject: "Re: Midi Health proposal review",
		body: "Confirmed with Joel. They moved the proposal review to next Thursday at 11am ET. I updated the invite.",
		facts: "last_from_nik=false; nik_in_to=false; nik_in_cc=true; nik_sent_in_thread=true; last_from_internal=true; msg_count=4",
		expect: { importance: ["STAR"], draft_reply: false }
	},
	{
		id: "direct_mention_weigh_in",
		from: "Laura <laura@example.com>",
		subject: "Re: Project Alpha Update",
		body: "Hi Aayush, this looks good to me, looping in @Nik Friedman TeBockhorst in case he wants to weigh in",
		facts: "last_from_nik=false; nik_in_to=true; nik_in_cc=false; nik_sent_in_thread=false; msg_count=2",
		expect: { importance: ["STAR"], draft_reply: true }
	},
	{
		id: "candidate_no_ask_of_nik",
		from: "Jordan Lee <jordan.lee@gmail.com>",
		subject: "Checking on my interview status",
		body: "Hi, I interviewed for the Solutions Architect role last week and wanted to check on next steps. Thanks.",
		facts: "last_from_nik=false; nik_in_to=false; nik_in_cc=true; nik_sent_in_thread=false; msg_count=1",
		expect: { importance: ["STAR"], draft_reply: false }
	},
	{
		id: "candidate_asks_nik",
		from: "Jordan Lee <jordan.lee@gmail.com>",
		subject: "Re: Solutions Architect role",
		body: "Nik, could you clarify the reporting structure for this role before I decide?",
		facts: "last_from_nik=false; nik_in_to=true; nik_in_cc=false; nik_sent_in_thread=true; msg_count=3",
		expect: { importance: ["STAR"], draft_reply: true }
	},
	{
		id: "signature_request",
		from: "McGaw via DocuSign <dse@docusign.net>",
		subject: "Please DocuSign: McGaw MSA",
		body: "Dan McGaw sent you a document to review and sign. REVIEW DOCUMENT.",
		facts: "last_from_nik=false; nik_in_to=true; nik_in_cc=false; has_list_unsubscribe=false; msg_count=1",
		expect: { importance: ["STAR"], draft_reply: false }
	},
	{
		id: "routine_scheduling",
		from: "Sarah <sarah@mcgaw.io>",
		subject: "Gainbridge check-in",
		body: "Does Tuesday at 2pm work for the check-in? Same Zoom link as last time.",
		facts: "last_from_nik=false; nik_in_to=true; last_from_internal=true; all_internal=true; msg_count=1",
		expect: { importance: ["NEITHER"], draft_reply: false }
	},
	{
		id: "scheduling_with_status_change",
		from: "Sarah <sarah@mcgaw.io>",
		subject: "Re: Sounders discovery call",
		body: "Heads up, they pushed the discovery call out two weeks. Their CFO is joining now.",
		facts: "last_from_nik=false; nik_in_to=true; last_from_internal=true; msg_count=3",
		expect: { importance: ["STAR"], draft_reply: false }
	},
	{
		id: "ats_noise",
		from: "Greenhouse <no-reply@greenhouse-mail.io>",
		subject: "Application received: Senior Analyst",
		body: "A new application was received for Senior Analyst. View in Greenhouse.",
		facts: "last_from_nik=false; nik_in_to=true; has_list_unsubscribe=true; msg_count=1",
		expect: { importance: ["ARCHIVE"], draft_reply: false, notify: false }
	},
	{
		id: "vendor_pitch",
		from: "Chris Park <chris@leadspark.example>",
		subject: "Quick question about your lead gen",
		body: "Hi Nik, we help B2B firms book 20 qualified meetings a month. Do you have 15 minutes this week?",
		facts: "last_from_nik=false; nik_in_to=true; msg_count=1; nik_sent_in_thread=false",
		expect: { importance: ["ARCHIVE", "BLOCK"], draft_reply: false, notify: false }
	},
	{
		id: "podcast_invite",
		from: "Booking <guests@consultinggrowthpod.example>",
		subject: "Invitation: be a guest on The Consulting Growth Podcast",
		body: "We would love to feature you on our show about scaling management consulting firms.",
		facts: "last_from_nik=false; nik_in_to=true; msg_count=1; nik_sent_in_thread=false",
		expect: { importance: ["BLOCK", "ARCHIVE"], draft_reply: false, notify: false }
	},
	{
		id: "client_issue_urgent_ask",
		from: "Dana Ruiz <dana@clientco.example>",
		subject: "Re: August invoice",
		body: "Nik, the August overage looks wrong. This is the third time I am asking. I need an answer today.",
		facts: "last_from_nik=false; nik_in_to=true; nik_sent_in_thread=true; msg_count=5",
		expect: { importance: ["STAR"], draft_reply: true, notify: true }
	},
	{
		id: "client_closer",
		from: "Dana Ruiz <dana@clientco.example>",
		subject: "Re: Updated roadmap",
		body: "Thanks, got it!",
		facts: "last_from_nik=false; nik_in_to=true; nik_sent_in_thread=true; msg_count=4",
		expect: { importance: ["NEITHER"], draft_reply: false, notify: false }
	},
	{
		id: "cc_on_ask_for_teammate",
		from: "Dana Ruiz <dana@clientco.example>",
		subject: "Re: SOW",
		body: "Joel, can you send the updated SOW when you have a moment?",
		facts: "last_from_nik=false; nik_in_to=false; nik_in_cc=true; nik_sent_in_thread=false; msg_count=2",
		expect: { importance: ["NEITHER", "STAR"], draft_reply: false }
	},
	{
		id: "newsletter",
		from: "MarTech Weekly <news@martechweekly.example>",
		subject: "This week in martech",
		body: "Top stories: five CDP launches, a new attribution study, and more. Unsubscribe at any time.",
		facts: "last_from_nik=false; nik_in_to=true; has_list_unsubscribe=true; msg_count=1",
		expect: { importance: ["ARCHIVE"], draft_reply: false, notify: false }
	},
	{
		id: "thin_unknown_followup",
		from: "Sam Ortiz <sam@unknownco.example>",
		subject: "Re: my note",
		body: "Any thoughts on my earlier note?",
		facts: "last_from_nik=false; nik_in_to=true; nik_sent_in_thread=false; msg_count=2",
		expect: { importance: ["UNSURE", "ARCHIVE", "NEITHER"], draft_reply: false }
	}
];

/**
 * Calls Stage 1 once with every case and prints a pass table.
 * Counts a case as passed only when every set expectation holds.
 */
function runTriageEval() {
	var batch = TRIAGE_EVAL_CASES.map(function (c) {
		return {
			id: c.id,
			from: c.from,
			subject: c.subject,
			body: c.body,
			facts: c.facts,
			labels: []
		};
	});

	var decisions = callGeminiStage1Triage(batch, "");
	var passed = 0;
	var fieldHits = { importance: 0, draft_reply: 0, notify: 0 };
	var fieldTotals = { importance: 0, draft_reply: 0, notify: 0 };

	TRIAGE_EVAL_CASES.forEach(function (c) {
		var d = decisions[c.id] || {};
		var problems = [];

		fieldTotals.importance++;
		if (c.expect.importance.indexOf(d.importance) !== -1) fieldHits.importance++;
		else problems.push("importance " + d.importance + " not in [" + c.expect.importance.join("/") + "]");

		if (typeof c.expect.draft_reply === "boolean") {
			fieldTotals.draft_reply++;
			if (d.draft_reply === c.expect.draft_reply) fieldHits.draft_reply++;
			else problems.push("draft_reply " + d.draft_reply + " expected " + c.expect.draft_reply);
		}
		if (typeof c.expect.notify === "boolean") {
			fieldTotals.notify++;
			if (d.notify === c.expect.notify) fieldHits.notify++;
			else problems.push("notify " + d.notify + " expected " + c.expect.notify);
		}

		if (problems.length === 0) {
			passed++;
			Logger.log("PASS " + c.id + " (" + d.importance + ", " + (d.reason_code || "-") + ")");
		} else {
			Logger.log("FAIL " + c.id + ": " + problems.join("; ") + " | reason: " + d.reason);
		}
	});

	Logger.log("PROMPTS_VERSION " + (typeof PROMPTS_VERSION !== "undefined" ? PROMPTS_VERSION : "old") +
		" | model " + CONFIG.GEMINI_MODEL_TRIAGE);
	Logger.log("CASES PASSED " + passed + " of " + TRIAGE_EVAL_CASES.length);
	Logger.log("importance " + fieldHits.importance + "/" + fieldTotals.importance +
		" | draft_reply " + fieldHits.draft_reply + "/" + fieldTotals.draft_reply +
		" | notify " + fieldHits.notify + "/" + fieldTotals.notify);
}

/**
 * Deterministic style lint for a drafted reply. Returns an array of violation strings.
 * All drafts are Nik voice. Mirrors the rules in nik-context.
 * Run it on every model draft before creating the Gmail draft, and drop or flag drafts that fail.
 */
function lintDraft(text) {
	var v = [];
	if (!text || typeof text !== "string") return ["empty draft"];

	if (/—|–/.test(text)) v.push("contains an em-dash or en-dash");
	if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) v.push("contains an emoji");
	if (/\*\*|__|^#{1,6}\s|`/m.test(text)) v.push("contains markdown");
	if (!/Best,\s*\n\s*\n\s*Nik\s*$/.test(text.trim())) v.push("sign-off is not Best, blank line, Nik");

	var aiTells = ["delve", "tapestry", "landscape", "kindly", "hope this finds you well", "reach out"];
	aiTells.forEach(function (w) {
		if (new RegExp("\\b" + w + "\\b", "i").test(text)) v.push("AI tell: " + w);
	});
	if (/\bensure\b/i.test(text)) v.push("AI tell: ensure");

	text.trim().split(/\n\s*\n/).forEach(function (p, i) {
		var lines = p.split("\n").filter(function (l) { return l.trim().length > 0; });
		if (lines.length > 3) v.push("paragraph " + (i + 1) + " is longer than 3 lines");
	});
	return v;
}

function testLintDraft() {
	var failures = 0;
	function check(name, cond) {
		if (cond) Logger.log("PASS " + name);
		else { failures++; Logger.log("FAIL " + name); }
	}

	var good = "Good news! We completed your stack assessment.\n\nThanks for your patience.\n\nDo you have time tomorrow?\n\nBest,\n\nNik";
	check("good draft has no violations", lintDraft(good).length === 0);
	check("em-dash flagged", lintDraft("Quick update — all set.\n\nBest,\n\nNik").length > 0);
	check("markdown flagged", lintDraft("**Update** here.\n\nBest,\n\nNik").length > 0);
	check("missing sign-off flagged", lintDraft("All set.\n\nThanks").length > 0);
	check("AI tell flagged", lintDraft("Let us delve into it.\n\nBest,\n\nNik").length > 0);
	check("long paragraph flagged", lintDraft("a\nb\nc\nd\n\nBest,\n\nNik").length > 0);
	check("softeners allowed", lintDraft("Happy to give you your time back.\n\nBest,\n\nNik").length === 0);
	check("emoji flagged", lintDraft("All set \u{1F600}\n\nBest,\n\nNik").length > 0);

	Logger.log(failures === 0 ? "ALL LINT CHECKS PASSED" : failures + " LINT CHECKS FAILED");
}
