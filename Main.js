/**
 * TRIGGER 1: Run every 20-30 minutes
 * Refreshes the context cache so it's warm for the triage run.
 */
function refreshContextCache() {
	Logger.log("Force refreshing context cache...");
	buildActiveContext(true); // true = force refresh
}

/**
 * TRIGGER 2: Run Hourly
 * Processes incoming mail using the cached context.
 */
function processIncomingMail() {
	// 1. Get Context (Fast, should be cached)
	var activeContext = buildActiveContext(false);

	// Capture start time for next run (seconds)
	var runTimestamp = Math.floor(Date.now() / 1000);

	// Get last run time (default to 24h ago if missing)
	var scriptProperties = PropertiesService.getScriptProperties();
	var lastRunTimestamp = scriptProperties.getProperty('LAST_PROCESSED_TIMESTAMP');
	if (!lastRunTimestamp) {
		lastRunTimestamp = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
	}
	Logger.log(`Processing emails since: ${lastRunTimestamp} (Epoch)`);

	// 2. Fetch Unread Emails from all Configured Sources
	var allThreads = [];

	CONFIG.SOURCE_LABELS.forEach(query => {
		var fullQuery = `${query} after:${lastRunTimestamp}`;
		Logger.log(`Searching: ${fullQuery}`);
		var threads = GmailApp.search(fullQuery, 0, CONFIG.MAX_EMAILS_TO_PROCESS);
		allThreads = allThreads.concat(threads);
	});

	// Deduplicate threads (in case labels overlap)
	var threadIds = new Set();
	var uniqueThreads = [];
	allThreads.forEach(t => {
		if (!threadIds.has(t.getId())) {
			threadIds.add(t.getId());
			uniqueThreads.push(t);
		}
	});

	if (uniqueThreads.length === 0) {
		Logger.log("No new mail.");
		return;
	}

	// Double check max limit after merging
	if (uniqueThreads.length > CONFIG.MAX_EMAILS_TO_PROCESS) {
		uniqueThreads = uniqueThreads.slice(0, CONFIG.MAX_EMAILS_TO_PROCESS);
	}

	Logger.log(`Processing ${uniqueThreads.length} threads...`);

	// 3. Prepare Batch
	var emailBatch = [];
	var threadMap = {}; // Map ID -> Thread Object

	for (var i = 0; i < uniqueThreads.length; i++) {
		var thread = uniqueThreads[i];
		var allMessages = thread.getMessages(); // result is oldest to newest
		var msgCount = allMessages.length;

		if (msgCount === 0) continue; // Should not happen

		var lastMsg = allMessages[msgCount - 1]; // The latest message
		var msgId = "msg_" + i;

		// --- BUILD HISTORY CONTEXT ---
		// We want to see what happened before this latest message.
		// Let's grab up to 2 previous messages.
		var historyBody = "";
		if (msgCount > 1) {
			// Start from the message before the last one, go back up to 2 steps
			var historyLimit = Math.max(0, msgCount - 3);
			for (var h = msgCount - 2; h >= historyLimit; h--) {
				var histMsg = allMessages[h];
				var histFrom = histMsg.getFrom();
				var histBodyShort = histMsg.getPlainBody().substring(0, 800)
					.replace(/\n\s*\n/g, '\n'); // condense

				historyBody = `\n--- PREVIOUS MESSAGE (From: ${histFrom}) ---\n${histBodyShort}` + historyBody;
			}
		}

		// --- PROCESS LATEST MESSAGE ---
		var rawBody = lastMsg.getPlainBody();

		// Clean the latest message body
		var cleanBody = rawBody.replace(/On .* wrote:[\s\S]*$/, '')
			.replace(/^>.*$/gm, '')
			.replace(/From:.*[\s\S]*?Subject:.*/, '')
			.replace(/\n\s*\n/g, '\n')
			.trim()
			.substring(0, 3000); // Give latest message more space

		// --- COMBINE FOR GEMINI ---
		// Explicitly label the parts so Gemini understands the timeline
		var fullContextBody = `[LATEST MESSAGE]\n${cleanBody}`;

		if (historyBody) {
			fullContextBody += `\n\n[THREAD HISTORY]${historyBody}`;
		}

		emailBatch.push({
			id: msgId,
			from: lastMsg.getFrom(),
			subject: lastMsg.getSubject(),
			body: fullContextBody
		});

		threadMap[msgId] = { thread: thread, message: lastMsg };
	}

	// 4. Call Gemini (One API Call)
	var decisionMap = callGeminiTriageBatch(emailBatch, activeContext);

	if (!decisionMap) {
		Logger.log("Failed to get batch decisions.");
		return;
	}

	// 5. Execute Actions
	for (var msgId in decisionMap) {
		var decision = decisionMap[msgId];
		var threadObj = threadMap[msgId];

		if (!threadObj) continue;

		Logger.log(`Decision for ${msgId}: ${decision.importance}`);

		var thread = threadObj.thread;
		var message = threadObj.message;

		try {
			// Helper to apply label safely
			var applyLabel = function (labelName) {
				var label = GmailApp.getUserLabelByName(labelName) || GmailApp.createLabel(labelName);
				thread.addLabel(label);
			};


			switch (decision.importance) {
				case "ARCHIVE":
					applyLabel(CONFIG.LABELS.ARCHIVE);
					if (CONFIG.ENABLE_DESTRUCTIVE_ACTIONS) {
						thread.markRead();
						thread.moveToArchive();
						// If archived/blocked, stop processing this email (no drafts/notifies)
						continue;
					}
					break;

				case "BLOCK":
					applyLabel(CONFIG.LABELS.BLOCK);
					if (CONFIG.ENABLE_DESTRUCTIVE_ACTIONS) {
						thread.moveToTrash();
						continue;
					}
					break;

				case "STAR":
					applyLabel(CONFIG.LABELS.STAR);
					message.star();
					break;

				case "UNSURE":
					applyLabel(CONFIG.LABELS.UNSURE);
					break;

				case "NEITHER":
					// Do nothing specific for importance
					break;
			}

			// INDEPENDENT ACTION: Draft Reply
			if (decision.draft_reply) {
				applyLabel(CONFIG.LABELS.DRAFT);
				message.star(); // Suggest keeping starred if replying
				if (decision.draft_text) {
					thread.createDraftReplyAll(decision.draft_text);
				}
			}

			// INDEPENDENT ACTION: Notify
			if (decision.notify) {
				applyLabel(CONFIG.LABELS.NOTIFY);
				message.star();
				callWebhook(decision, message);
			}
		} catch (e) {
			Logger.log(`Error executing action for ${msgId}: ${e.toString()}`);
		}
	}

	// Save timestamp for next run
	scriptProperties.setProperty('LAST_PROCESSED_TIMESTAMP', runTimestamp.toString());
	Logger.log(`Updated LAST_PROCESSED_TIMESTAMP to: ${runTimestamp}`);
}

// Helper: Call Generic Webhook
function callWebhook(decision, message) {
	if (!CONFIG.WEBHOOK_URL || CONFIG.WEBHOOK_URL.indexOf('http') === -1 || CONFIG.WEBHOOK_URL.includes('YOUR_WEBHOOK_URL')) {
		Logger.log("Webhook skipped (URL not configured).");
		return;
	}

	var mode = CONFIG.WEBHOOK_MODE || 'JSON';
	var paramName = CONFIG.WEBHOOK_PARAM_NAME || 'message';
	var finalUrl = CONFIG.WEBHOOK_URL;

	// Default Notification Text
	var notifText = decision.notification_text || `Action required for email from ${message.getFrom()}`;

	var options = {
		'method': 'post',
		'muteHttpExceptions': true
	};

	if (mode === 'TEXT') {
		options.contentType = 'text/plain';
		options.payload = notifText;
	} else if (mode === 'URL_PARAM') {
		var encodedText = encodeURIComponent(notifText);
		var separator = finalUrl.indexOf('?') !== -1 ? '&' : '?';
		finalUrl = finalUrl + separator + paramName + '=' + encodedText;
		options.method = 'get';
		// No payload for URL param mode, just hitting the URL
	} else {
		// Default to JSON
		var payload = {
			messageId: message.getId(),
			subject: message.getSubject(),
			sender: message.getFrom(),
			geminiOutput: decision,
			notificationText: notifText
		};
		options.contentType = 'application/json';
		options.payload = JSON.stringify(payload);
	}

	try {
		Logger.log('Webhook url:' + finalUrl);
		UrlFetchApp.fetch(finalUrl, options);
		Logger.log(`Webhook sent (Mode: ${mode}).`);
	} catch (e) {
		Logger.log("Error sending webhook: " + e.toString());
	}
}