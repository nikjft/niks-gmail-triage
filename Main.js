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
	var contextObj = buildActiveContext(false);
	// Fallback if old cache string exists (unlikely but safe) (Actually ContextBuilder handles parsing)

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

	// Deduplicate threads
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

	// Limit processing
	if (uniqueThreads.length > CONFIG.MAX_EMAILS_TO_PROCESS) {
		uniqueThreads = uniqueThreads.slice(0, CONFIG.MAX_EMAILS_TO_PROCESS);
	}

	Logger.log(`Processing ${uniqueThreads.length} threads...`);

	// 3. Prepare STAGE 1 Batch (Lightweight)
	var stage1Batch = [];
	var threadMap = {}; // Map ID -> { thread, lastMsg, fullBody, history }

	for (var i = 0; i < uniqueThreads.length; i++) {
		var thread = uniqueThreads[i];
		var allMessages = thread.getMessages();
		var msgCount = allMessages.length;
		if (msgCount === 0) continue;

		var lastMsg = allMessages[msgCount - 1];
		var msgId = "msg_" + i;

		// --- PREPARE FULL CONTENT (Processed once for efficiency) ---
		var rawBody = lastMsg.getPlainBody();

		// Clean the latest message body
		var cleanBody = rawBody.replace(/On .* wrote:[\s\S]*$/, '')
			.replace(/^>.*$/gm, '')
			.replace(/From:.*[\s\S]*?Subject:.*/, '')
			.replace(/\n\s*\n/g, '\n')
			.trim();

		// Truncate for Stage 1 Preview (500 chars)
		var previewBody = cleanBody.substring(0, 500);

		// Prepare History for potential Stage 2
		var historyBody = "";
		if (msgCount > 1) {
			var historyLimit = Math.max(0, msgCount - 3);
			for (var h = msgCount - 2; h >= historyLimit; h--) {
				var histMsg = allMessages[h];
				var histBodyShort = histMsg.getPlainBody().substring(0, 800)
					.replace(/\n\s*\n/g, '\n');
				historyBody = `\n--- PREVIOUS MESSAGE (From: ${histMsg.getFrom()}) ---\n${histBodyShort}` + historyBody;
			}
		}

		// Full body for Stage 2
		var fullContextBody = `[LATEST MESSAGE]\n${cleanBody.substring(0, 3000)}`;
		if (historyBody) {
			fullContextBody += `\n\n[THREAD HISTORY]${historyBody}`;
		}

		stage1Batch.push({
			id: msgId,
			from: lastMsg.getFrom(),
			subject: lastMsg.getSubject(),
			body: previewBody, // LIGHTWEIGHT
			labels: thread.getLabels().map(l => l.getName())
		});

		threadMap[msgId] = {
			thread: thread,
			message: lastMsg,
			fullBody: fullContextBody
		};
	}

	// 4. CALL STAGE 1 (Triage)
	// Uses the lightweight context and lightweight model
	var triageDecisions = callGeminiStage1Triage(stage1Batch, contextObj.triageContext);

	if (!triageDecisions) {
		Logger.log("Failed to get Stage 1 decisions.");
		return;
	}

	// 5. Execute Triage Actions & Identify Draft Candidates
	var draftCandidates = []; // Array of { id, ... }

	for (var msgId in triageDecisions) {
		var decision = triageDecisions[msgId];
		var threadObj = threadMap[msgId];

		if (!threadObj) continue;

		Logger.log(`Stage 1 Decision for ${msgId}: ${decision.importance}, Draft: ${decision.draft_reply}`);

		var thread = threadObj.thread;
		var message = threadObj.message;

		try {
			var applyLabel = function (labelName) {
				var label = GmailApp.getUserLabelByName(labelName) || GmailApp.createLabel(labelName);
				thread.addLabel(label);
			};

			// Apply Importance Labels / Actions
			switch (decision.importance) {
				case "ARCHIVE":
					applyLabel(CONFIG.LABELS.ARCHIVE);
					if (CONFIG.ENABLE_DESTRUCTIVE_ACTIONS) {
						thread.markRead();
						thread.moveToArchive();
						continue; // Stop processing this email
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
			}

			// NOTIFY Check
			if (decision.notify) {
				applyLabel(CONFIG.LABELS.NOTIFY);
				message.star();
				callWebhook(decision, message);
			}

			// DRAFT CHECK -> Queue for Stage 2
			if (decision.draft_reply) {
				applyLabel(CONFIG.LABELS.DRAFT);
				message.star(); // Keep starred if replying

				draftCandidates.push({
					id: msgId,
					from: message.getFrom(),
					subject: message.getSubject(),
					body: threadObj.fullBody // FULL CONTEXT
				});
			}

		} catch (e) {
			Logger.log(`Error processing ${msgId}: ${e.toString()}`);
		}
	}

	// 6. CALL STAGE 2 (Drafting) - Only if needed
	if (draftCandidates.length > 0) {
		Logger.log(`Running Stage 2 Drafting for ${draftCandidates.length} emails...`);

		var draftDecisions = callGeminiStage2Draft(draftCandidates, contextObj.draftingContext); // FULL CONTEXT

		if (draftDecisions) {
			for (var msgId in draftDecisions) {
				var draftResult = draftDecisions[msgId];
				var threadObj = threadMap[msgId];

				if (draftResult && draftResult.draft_text && threadObj) {
					try {
						threadObj.thread.createDraftReplyAll(draftResult.draft_text);
						Logger.log(`Draft created for ${msgId}`);
					} catch (e) {
						Logger.log(`Error creating draft for ${msgId}: ${e.toString()}`);
					}
				}
			}
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