
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

	// 1. Projects (Used in BOTH)
	var projectString = "";
	if (projectContexts.size > 0) {
		projectString = "ACTIVE PROJECTS:\n- " + Array.from(projectContexts).join("\n- ");
	}

	// 2. Recent Activity (Used ONLY in Triage)
	var recentActivityParts = [];
	if (recentSubjects.size > 0) {
		var subjectsArr = Array.from(recentSubjects).slice(0, 30);
		recentActivityParts.push("RECENT EMAIL SUBJECTS:\n- " + subjectsArr.join("\n- "));
	}
	if (recentContacts.size > 0) {
		var contactsArr = Array.from(recentContacts).slice(0, 40);
		recentActivityParts.push("RECENT CONTACTS (VIPs / Colleagues):\n- " + contactsArr.join("\n- "));
	}
	var recentActivityString = recentActivityParts.join("\n\n");

	// Triage Context: Core Context (Projects + Recent Activity)
	var triageContext = [projectString, recentActivityString].filter(function (s) { return s; }).join("\n\n");

	// Drafting Context: Style + Projects ONLY (No noisy recent activity)
	var draftingContext = styleSection + (projectString ? ("\nRELEVANT CONTEXT:\n" + projectString) : "");

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


