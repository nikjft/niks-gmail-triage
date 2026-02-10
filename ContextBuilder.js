function buildActiveContext(forceRefresh) {
	// 1. Check Cache first (unless forcing refresh)
	var cache = CacheService.getScriptCache();

	if (!forceRefresh) {
		var cachedContext = cache.get("active_context");

		if (cachedContext) {
			Logger.log("Returning cached context.");
			return cachedContext;
		}
	}

	Logger.log("Building fresh context...");
	var lookbackDate = new Date();
	lookbackDate.setDate(lookbackDate.getDate() - CONFIG.LOOKBACK_DAYS);
	var dateStr = Utilities.formatDate(lookbackDate, Session.getScriptTimeZone(), "yyyy/MM/dd");

	var contextList = [];

	// --- SOURCE 1: TRELLO BOARDS ---
	// Looks for subject lines like "... on [Board Name] -" or "... on [Board Name] via..."
	var trelloThreads = GmailApp.search(`${CONFIG.TRELLO_LABEL} newer_than:14d`);
	var trelloSubjects = [];

	trelloThreads.forEach(t => {
		var subject = t.getFirstMessageSubject();
		// Regex to extract Board Name between " on " and " - " or " via "
		var match = subject.match(/ on (.*?) (?:-|via)/);
		if (match && match[1]) trelloSubjects.push("Active Project/Client: " + match[1].trim());
	});

	// --- SOURCE 2: SENT EMAILS (Who are you talking to? + Style Examples) ---
	var sentThreads = GmailApp.search(`from:me newer_than:14d`);
	var sentContext = [];
	var styleExamples = [];
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

		if (!lastMsg) return; // Should not happen given the search query, but safe to check

		// Get Recipient Domain/Email
		var to = lastMsg.getTo();
		if (!isExcluded(to)) {
			sentContext.push(`Recently emailed: ${cleanSubject(t.getFirstMessageSubject())} (To: ${to})`);

			// Capture up to 3 writing samples for style matching
			if (styleExamples.length < 3) {
				var body = lastMsg.getPlainBody();
				var subject = lastMsg.getSubject(); // Capture subject too

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
	var starredContext = [];

	starredThreads.forEach(t => {
		starredContext.push(`Starred Priority: ${cleanSubject(t.getFirstMessageSubject())}`);
	});

	// --- DEDUPLICATE AND MERGE ---
	// Add Style Examples as a distinct block at the top or bottom
	var styleSection = "";
	if (styleExamples.length > 0) {
		styleSection = "MY WRITING STYLE / VOICE EXAMPLES (Mimic this tone):\n" + styleExamples.join("\n---\n") + "\n\n";
	}

	var allItems = [...trelloSubjects, ...sentContext, ...starredContext];
	var uniqueItems = [...new Set(allItems)]; // JavaScript Set deduplicates automatically

	Logger.log(`Built context with ${uniqueItems.length} items.`);

	// Truncate based on character count estimate (approx 4 chars per token)
	// Gemini 1.5 Flash has a huge context window, but for latency and cost, let's keep it reasonable.
	// 50,000 characters is plenty for triage context.
	const MAX_CONTEXT_CHARS = 50000;
	let currentChars = styleSection.length; // Count style section first
	let limitedContext = [];

	for (const item of uniqueItems) {
		if (currentChars + item.length > MAX_CONTEXT_CHARS) {
			break;
		}
		limitedContext.push(item);
		currentChars += item.length + 1; // +1 for newline
	}

	var finalContext = styleSection + "RECENT ACTIVITY CONTEXT:\n" + limitedContext.join("\n");

	// Cache for 25 minutes (1500 seconds) to cover the 20m trigger gap
	try {
		cache.put("active_context", finalContext, 1500);
	} catch (e) {
		Logger.log("Failed to cache context (likely too large): " + e.toString());
	}

	return finalContext;
}

// Helper: Clean subject lines (remove Re:, Fwd:)
function cleanSubject(subject) {
	return subject.replace(/^(re:|fwd:|fw:|sand:)\s*/i, '').trim();
}

// Helper: Check exclusions
function isExcluded(emailString) {
	return CONFIG.EXCLUDED_DOMAINS.some(domain => emailString.includes(domain));
}