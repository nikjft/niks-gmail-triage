
function buildActiveContext(forceRefresh) {
	// 1. Check Cache first (unless forcing refresh)
	var cache = CacheService.getScriptCache();

	if (!forceRefresh) {
		var cachedContext = cache.get("active_context_obj");

		if (cachedContext) {
			Logger.log("Returning cached context.");
			return JSON.parse(cachedContext);
		}
	}

	Logger.log("Building fresh context...");

	// Sets for deduplication
	var projectContexts = new Set();
	var recentSubjects = new Set();
	var recentContacts = new Set();
	var rawSubjectCount = 0;
	var rawContactCount = 0;
	var styleExamples = [];

	// --- SOURCE 1: TRELLO BOARDS ---
	// Looks for subject lines like "... on [Board Name] -" or "... on [Board Name] via..."
	var trelloThreads = GmailApp.search(`${CONFIG.TRELLO_LABEL} newer_than:14d`);

	trelloThreads.forEach(t => {
		var subject = t.getFirstMessageSubject();
		// Regex to extract Board Name between " on " and " - " or " via "
		var match = subject.match(/ on (.*?) (?:-|via)/);
		if (match && match[1]) projectContexts.add("Active Project: " + match[1].trim());
	});

	// --- SOURCE 2: SENT EMAILS (Who are you talking to? + Style Examples) ---
	var sentThreads = GmailApp.search(`from:me newer_than:14d`);
	var myEmail = Session.getActiveUser().getEmail();

	sentThreads.forEach((t, i) => {
		var msgs = t.getMessages();
		// Find the last message sent BY ME
		var lastMsg = null;
		for (var m = msgs.length - 1; m >= 0; m--) {
			if (msgs[m].getFrom().indexOf(myEmail) !== -1) {
				lastMsg = msgs[m];
				break;
			}
		}

		if (!lastMsg) return;

		// Get Recipient Domain/Email
		var to = lastMsg.getTo();
		if (!isExcluded(to)) {
			// Add to distinct lists
			var cleanSub = cleanSubject(t.getFirstMessageSubject());
			if (cleanSub) {
				rawSubjectCount++;
				recentSubjects.add(cleanSub);
			}

			// Extract just the email addresses or names from the 'To' field
			// Simple extraction: split by comma, clean up
			to.split(',').forEach(recipient => {
				var cleanRecipient = recipient.trim();
				if (cleanRecipient && !isExcluded(cleanRecipient)) {
					rawContactCount++;
					recentContacts.add(cleanRecipient);
				}
			});

			// Capture up to 3 writing samples for style matching
			// Filter out calendar invites from style examples
			if (styleExamples.length < 3 && !isCalendarInvite(t.getFirstMessageSubject(), lastMsg.getPlainBody())) {
				var body = lastMsg.getPlainBody();
				var subject = lastMsg.getSubject();

				// Remove quoted headers like "On ... wrote:" and forward info
				var cleanBody = body.replace(/On .* wrote:[\s\S]*$/, '')
					.replace(/^>.*$/gm, '')
					.replace(/From:.*[\s\S]*?Subject:.*/, '')
					.replace(/^--\s*$/gm, 'SIG_DELIMITER') // Mark signature
					.split('SIG_DELIMITER')[0] // Take everything before signature
					.replace(/\n\s*\n/g, '\n')
					.trim();

				if (cleanBody.length > 50 && cleanBody.length < 1000) { // filter out tiny replies or huge docs
					styleExamples.push(`Subject: ${subject}\nBody: "${cleanBody}"`);
				}
			}
		}
	});

	// --- SOURCE 3: STARRED EMAILS ---
	var starredThreads = GmailApp.search(`is:starred newer_than:14d`);

	starredThreads.forEach(t => {
		var cleanSub = cleanSubject(t.getFirstMessageSubject());
		if (cleanSub) {
			rawSubjectCount++;
			recentSubjects.add(cleanSub + " (Starred)");
		}
	});

	// --- BUILD FINAL STRINGS ---

	var styleSection = "";
	if (styleExamples.length > 0) {
		styleSection = "MY WRITING STYLE / VOICE EXAMPLES (Mimic this tone):\n" + styleExamples.join("\n---\n") + "\n\n";
	}

	var contextParts = [];

	if (projectContexts.size > 0) {
		contextParts.push("ACTIVE PROJECTS:\n- " + Array.from(projectContexts).join("\n- "));
	}

	if (recentSubjects.size > 0) {
		// Limit recent subjects to top 30 to save space
		var subjectsArr = Array.from(recentSubjects).slice(0, 30);
		contextParts.push("RECENT EMAIL SUBJECTS:\n- " + subjectsArr.join("\n- "));
	}

	if (recentContacts.size > 0) {
		// Limit contacts to top 40 to ensure we capture colleagues like potential "Laura Pynn"
		var contactsArr = Array.from(recentContacts).slice(0, 40);
		contextParts.push("RECENT CONTACTS (VIPs / Colleagues):\n- " + contactsArr.join("\n- "));
	}

	var coreContext = contextParts.join("\n\n");

	// Triage Context: Core Context only (Projects + Recent Activity)
	var triageContext = coreContext;

	// Drafting Context: Style + Core Context
	var draftingContext = styleSection + "RECENT ACTIVITY CONTEXT:\n" + coreContext;

	// Truncate based on character count estimate
	const MAX_CONTEXT_CHARS = 50000;
	if (draftingContext.length > MAX_CONTEXT_CHARS) {
		draftingContext = draftingContext.substring(0, MAX_CONTEXT_CHARS) + "...(truncated)";
	}

	// --- DETAILED LOGGING ---
	// --- DETAILED LOGGING ---
	Logger.log(`
      CONTEXT BUILD REPORT:
      - Active Projects: ${projectContexts.size}
      - Recent Subjects: ${recentSubjects.size} (from ${rawSubjectCount} raw)
      - Recent Contacts: ${recentContacts.size} (from ${rawContactCount} raw)
      - Style Examples: ${styleExamples.length}
      - Triage Context Size: ~${triageContext.length} chars
      - Drafting Context Size: ~${draftingContext.length} chars
    `);

	var contextResult = {
		triageContext: triageContext,
		draftingContext: draftingContext
	};

	// Cache for 25 minutes
	try {
		cache.put("active_context_obj", JSON.stringify(contextResult), 1500);
	} catch (e) {
		Logger.log("Failed to cache context: " + e.toString());
	}

	return contextResult;
}

// Helper: Check for calendar invite indicators
function isCalendarInvite(subject, body) {
	var s = subject.toLowerCase();
	if (s.includes('invitation:') || s.includes('accepted:') || s.includes('declined:') || s.includes('canceled event:') || s.includes('updated invitation:') || s.includes('synced invitation:')) {
		return true;
	}
	// Check body for common calendar artifacts
	if (body.includes('invite.ics') || body.includes('google.com/calendar/event') || body.includes('View all guest info')) {
		return true;
	}
	return false;
}

// Helper: Clean subject lines comprehensively
function cleanSubject(subject) {
	if (!subject) return "";
	// Remove common prefixes iteratively
	var cleaned = subject;
	var iterations = 0;
	// Regex matches Re:, Fwd:, Invitation:, Accepted:, Declined:, Updated invitation:, Canceled event:, Synced invitation:, [External]
	var prefixRegex = /^\s*(?:re:|fwd:|fw:|sand:|invitation:|accepted:|declined:|updated invitation:|canceled event:|synced invitation:|\[external\])\s*/i;

	while (prefixRegex.test(cleaned) && iterations < 5) {
		cleaned = cleaned.replace(prefixRegex, '');
		iterations++;
	}

	// Remove " @ [Time]" often found in calendar invites if any remain
	cleaned = cleaned.replace(/\s@\s\w{3}\s\w{3}\s\d{1,2},.*$/, '');

	return cleaned.trim();
}

// Helper: Check exclusions
function isExcluded(emailString) {
	if (!emailString) return true;
	return CONFIG.EXCLUDED_DOMAINS.some(domain => emailString.toLowerCase().includes(domain.toLowerCase()));
}

/**
 * DEBUG: Run this function manually to inspect the current cache state.
 */
function inspectContextCache() {
	var cache = CacheService.getScriptCache();
	var cachedContext = cache.get("active_context_obj");

	if (!cachedContext) {
		Logger.log("CACHE STATUS: Empty / Expired");
		return;
	}

	var ctx = JSON.parse(cachedContext);
	Logger.log("CACHE STATUS: Found");
	Logger.log("--------------------------------------------------");
	Logger.log(`TRIAGE CONTEXT (${ctx.triageContext.length} chars) [First 2000 chars]:\n` + ctx.triageContext.substring(0, 2000) + "\n");
	Logger.log("--------------------------------------------------");
	Logger.log(`DRAFTING CONTEXT (${ctx.draftingContext.length} chars) [First 2000 chars]:\n` + ctx.draftingContext.substring(0, 2000) + "\n");
	Logger.log("--------------------------------------------------");
}

function forceBuildActiveContext() {
	buildActiveContext(true);
}
