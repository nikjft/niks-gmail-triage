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

	// 2. Fetch Unread Emails from all Configured Sources
	var allThreads = [];

	CONFIG.SOURCE_LABELS.forEach(query => {
		var fullQuery = `${query} newer_than:${CONFIG.MAX_EMAIL_LOOKBACK_DAYS}d`;
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
		var message = thread.getMessages()[0]; // Get the first message
		var msgId = "msg_" + i; // Simple ID for the batch

		// Clean up body
		var rawBody = message.getPlainBody();
		var cleanBody = rawBody.replace(/On .* wrote:[\s\S]*$/, '')
			.replace(/^>.*$/gm, '')
			.replace(/From:.*[\s\S]*?Subject:.*/, '')
			.replace(/\n\s*\n/g, '\n')
			.substring(0, 2000);

		emailBatch.push({
			id: msgId,
			from: message.getFrom(),
			subject: message.getSubject(),
			body: cleanBody
		});

		threadMap[msgId] = { thread: thread, message: message };
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

			// ALWAYS apply "ai_processed" so we don't look at it again
			applyLabel(CONFIG.LABELS.PROCESSED);

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