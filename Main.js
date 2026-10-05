/**
 * TRIGGER 1: Run every 20-30 minutes
 * Refreshes the context cache so it's warm for the triage run.
 */
function refreshContextCache() {
	if (CONFIG.ENABLE_CONTEXT === false) {
		Logger.log("Context refresh skipped (ENABLE_CONTEXT is false).");
		return;
	}
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

	// --- BATCHING LOGIC ---
	var nowSeconds = Math.floor(Date.now() / 1000);
	var minutesSinceLastRun = (nowSeconds - lastRunTimestamp) / 60;
	var minBatch = CONFIG.MIN_BATCH_SIZE || 0;
	var maxWait = CONFIG.MAX_WAIT_TIME_MINUTES || 0;

	if (uniqueThreads.length < minBatch && minutesSinceLastRun < maxWait) {
		Logger.log(`Batching: Only ${uniqueThreads.length} emails found (min: ${minBatch}), and only ${minutesSinceLastRun.toFixed(1)} minutes since last run (max wait: ${maxWait}). Skipping processing.`);
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

		// --- FILTER 1: Skip threads whose last message is from user (and expire stale drafts once replied) ---
		if (isMessageFromUser(lastMsg)) {
			Logger.log(`Skipping thread ${thread.getId()}: last message is from user. Expiring stale drafts.`);
			expireStaleDraftsForThread(thread);
			continue;
		}

		// --- FILTER 2: Deterministic skip for EXCLUDED_DOMAINS before any model call ---
		if (isSenderExcluded(lastMsg.getFrom())) {
			Logger.log(`Skipping thread ${thread.getId()}: sender "${lastMsg.getFrom()}" matches EXCLUDED_DOMAINS.`);
			continue;
		}

		var msgId = "msg_" + i;

		// --- PREPARE FULL CONTENT (Optimized) ---
		var rawBody = lastMsg.getPlainBody();

		// 1. Triage Context (Stage 1): Strict limit
		var cleanBodyTriage = cleanEmailBody(rawBody, CONFIG.MAX_TRIAGE_BODY_CHARS || 500);

		// 2. Draft Context (Stage 2): Larger limit
		var cleanBodyDraft = cleanEmailBody(rawBody, CONFIG.MAX_DRAFT_BODY_CHARS || 3000);

		var facts = buildFacts(allMessages, lastMsg);

		stage1Batch.push({
			id: msgId,
			from: lastMsg.getFrom(),
			subject: lastMsg.getSubject(),
			body: cleanBodyTriage, // LIGHTWEIGHT (Triage Limit)
			facts: factsToString(facts),
			labels: thread.getLabels().map(l => l.getName())
		});

		threadMap[msgId] = {
			thread: thread,
			message: lastMsg,
			fullBody: cleanBodyDraft, // FULL CONTEXT (Draft Limit)
			facts: facts,
			history: buildHistoryForDraft(allMessages)
		};
	}

	// 4. CALL STAGE 1 (Triage)
	// Uses the lightweight context and lightweight model
	var triageDecisions = {};
	try {
		triageDecisions = callGeminiStage1Triage(stage1Batch, contextObj.triageContext);
	} catch (e) {
		Logger.log("CRITICAL ERROR in Stage 1 Triage: " + e.toString());
		Logger.log("Aborting run to prevent skipping emails. Timestamp will NOT be updated.");
		return;
	}

	if (!triageDecisions) {
		Logger.log("Failed to get Stage 1 decisions.");
		return;
	}

	// 5. Execute Triage Actions & Identify Draft Candidates
	var draftCandidates = []; // Array of { id, ... }

	for (var msgId in triageDecisions) {
		var threadObj = threadMap[msgId];

		if (!threadObj) continue;

		var decision = normalizeDecision(triageDecisions[msgId], threadObj.facts);

		Logger.log(`Stage 1 Decision for ${msgId}: ${decision.importance}, Draft: ${decision.draft_reply}, Notify: ${decision.notify}, Code: ${decision.reason_code || '-'}, Conf: ${decision.confidence || '-'}, FullThread: ${decision.needs_full_thread === true}`);

		var thread = threadObj.thread;
		var message = threadObj.message;

		try {
			// Remove prior ai_* labels from the thread before applying new ones
			removeAiLabels(thread);

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
					body: threadObj.fullBody, // FULL CONTEXT
					facts: factsToString(threadObj.facts),
					history: threadObj.history
				});
			}

		} catch (e) {
			Logger.log(`Error processing ${msgId}: ${e.toString()}`);
		}
	}

	// 6. CALL STAGE 2 (Drafting) - Only if enabled and needed
	if (draftCandidates.length > 0) {
		if (CONFIG.ENABLE_DRAFTING === false) {
			Logger.log(`Drafting disabled (ENABLE_DRAFTING is false). Tagged ${draftCandidates.length} email(s) with ${CONFIG.LABELS.DRAFT}, but skipped creating drafts.`);
		} else {
			Logger.log(`Running Stage 2 Drafting for ${draftCandidates.length} emails...`);

			var draftDecisions = {};
			try {
				draftDecisions = callGeminiStage2Draft(draftCandidates, contextObj.draftingContext); // FULL CONTEXT
			} catch (e) {
				Logger.log("CRITICAL ERROR in Stage 2 Drafting: " + e.toString());
				Logger.log("Aborting run to ensure drafts are retried. Timestamp will NOT be updated.");
				return;
			}

			if (draftDecisions) {
				for (var msgId in draftDecisions) {
					var draftResult = draftDecisions[msgId];
					var threadObj = threadMap[msgId];

					if (draftResult && !draftResult.draft_text) {
						Logger.log(`Draft abstained for ${msgId}: ${draftResult.abstain_reason || 'no reason given'}`);
						continue;
					}

					if (draftResult && draftResult.draft_text && threadObj) {
						if (CONFIG.ENABLE_DRAFT_LINT !== false) {
							var lintProblems = lintDraft(draftResult.draft_text);
							if (lintProblems.length > 0) {
								Logger.log(`Draft rejected by lint for ${msgId}: ${lintProblems.join(' | ')}`);
								continue;
							}
						}
						if (threadHasDraft(threadObj.thread)) {
							Logger.log(`Draft skipped for ${msgId}: thread already has a draft.`);
							continue;
						}
						try {
							// Construct HTML Body with Quoted History
							var htmlBody = constructQuotedReply(threadObj.message, draftResult.draft_text);

							// Create Draft with HTML support, excluding self from recipients
							createDraftReplyAllExcludingSelf(threadObj.thread, threadObj.message, htmlBody);
							Logger.log(`Draft created for ${msgId}`);
						} catch (e) {
							Logger.log(`Error creating draft for ${msgId}: ${e.toString()}`);
						}
					}
				}
			}
		}
	}

	// Save timestamp for next run
	scriptProperties.setProperty('LAST_PROCESSED_TIMESTAMP', runTimestamp.toString());
	Logger.log(`Updated LAST_PROCESSED_TIMESTAMP to: ${runTimestamp}`);
}


// ---------------------------------------------------------------------------
// FACTS (ground truth for the triage prompt). Computed from headers, never by the model.
// ---------------------------------------------------------------------------

/**
 * True when the address belongs to a configured internal domain (mcgaw.io).
 * @param {String} email
 * @return {Boolean}
 */
function isInternalEmail(email) {
	if (!email) return false;
	var domains = CONFIG.INTERNAL_DOMAINS || [];
	var clean = email.toLowerCase().trim();
	return domains.some(function (d) {
		return clean.endsWith('@' + d.toLowerCase());
	});
}

/**
 * Splits a header like "A <a@x.com>, b@y.com" into lowercase addresses.
 * @param {String} headerVal
 * @return {Array<String>}
 */
function headerEmails(headerVal) {
	if (!headerVal) return [];
	return headerVal.split(',').map(function (p) { return extractSingleEmail(p); }).filter(function (e) { return e; });
}

/**
 * Builds the FACTS object for a thread.
 * teammate_replied_after_external: an internal, non-Nik sender wrote after the latest external message.
 * @param {Array<GmailMessage>} allMessages
 * @param {GmailMessage} lastMsg
 * @return {Object}
 */
function buildFacts(allMessages, lastMsg) {
	var facts = {
		last_from_nik: false,
		nik_in_to: false,
		nik_in_cc: false,
		nik_sent_in_thread: false,
		last_from_internal: false,
		all_internal: true,
		msg_count: allMessages.length,
		teammate_replied_after_external: false,
		has_list_unsubscribe: false
	};
	try {
		facts.last_from_nik = isMessageFromUser(lastMsg);
		facts.last_from_internal = isInternalEmail(extractSingleEmail(lastMsg.getFrom()));
		facts.nik_in_to = headerEmails(lastMsg.getTo()).some(isUserEmail);
		facts.nik_in_cc = headerEmails(lastMsg.getCc()).some(isUserEmail);

		var lastExternalIdx = -1;
		allMessages.forEach(function (msg, idx) {
			var from = extractSingleEmail(msg.getFrom());
			if (isUserEmail(from)) facts.nik_sent_in_thread = true;
			var internal = isInternalEmail(from) || isUserEmail(from);
			if (!internal) {
				facts.all_internal = false;
				lastExternalIdx = idx;
			}
		});
		if (facts.all_internal) {
			// Recipients count too: an external To or Cc makes the thread external.
			var recips = headerEmails(lastMsg.getTo()).concat(headerEmails(lastMsg.getCc()));
			facts.all_internal = recips.every(function (e) { return isInternalEmail(e) || isUserEmail(e); });
		}
		if (lastExternalIdx >= 0) {
			for (var i = lastExternalIdx + 1; i < allMessages.length; i++) {
				var f = extractSingleEmail(allMessages[i].getFrom());
				if (isInternalEmail(f) && !isUserEmail(f)) {
					facts.teammate_replied_after_external = true;
					break;
				}
			}
		}
		facts.has_list_unsubscribe = hasListUnsubscribe(lastMsg);
	} catch (e) {
		Logger.log('buildFacts error: ' + e.toString());
	}
	return facts;
}

/**
 * Checks the raw header block for List-Unsubscribe. GmailMessage has no getHeader, so read the raw header section.
 * @param {GmailMessage} msg
 * @return {Boolean}
 */
function hasListUnsubscribe(msg) {
	try {
		var raw = msg.getRawContent();
		var headerEnd = raw.search(/\r?\n\r?\n/);
		var headers = headerEnd > 0 ? raw.substring(0, headerEnd) : raw.substring(0, 8000);
		return /^list-unsubscribe:/im.test(headers);
	} catch (e) {
		return false;
	}
}

/**
 * @param {Object} facts
 * @return {String} "k=v; k=v" line for the prompt
 */
function factsToString(facts) {
	if (!facts) return '';
	return Object.keys(facts).map(function (k) { return k + '=' + facts[k]; }).join('; ');
}

/**
 * Compact history for drafting. Marks each message SENT (by Nik) or RECEIVED so the model
 * can tell which asks Nik already answered. Newest message is excluded, it is sent as the body.
 * @param {Array<GmailMessage>} allMessages
 * @return {String}
 */
function buildHistoryForDraft(allMessages) {
	var prior = allMessages.slice(0, -1).slice(-4);
	return prior.map(function (msg) {
		var who = isMessageFromUser(msg) ? 'SENT BY NIK' : 'RECEIVED from ' + msg.getFrom();
		var body = cleanEmailBody(msg.getPlainBody(), 600);
		return '    [' + who + '] ' + body.replace(/\n/g, '\n    ');
	}).join('\n    ---\n');
}

// ---------------------------------------------------------------------------
// DECISION SAFETY
// ---------------------------------------------------------------------------

/**
 * Cleans one Stage 1 decision. Never lets a doubtful or malformed answer cause a quiet loss:
 *   - unknown importance becomes UNSURE
 *   - ARCHIVE or BLOCK with low confidence or needs_full_thread becomes UNSURE
 *   - draft_reply is forced false when facts show the last message is from Nik
 *   - draft_reply is forced false unless importance is STAR
 * @param {Object} d
 * @param {Object} facts
 * @return {Object}
 */
function normalizeDecision(d, facts) {
	var out = d && typeof d === 'object' ? d : {};
	var valid = ['STAR', 'NEITHER', 'ARCHIVE', 'BLOCK', 'UNSURE'];
	if (valid.indexOf(out.importance) === -1) {
		out.importance = 'UNSURE';
		out.reason_code = out.reason_code || 'THIN_PREVIEW';
	}
	if ((out.importance === 'ARCHIVE' || out.importance === 'BLOCK') &&
		(out.confidence === 'low' || out.needs_full_thread === true)) {
		Logger.log('Downgraded ' + out.importance + ' to UNSURE (low confidence or needs full thread).');
		out.importance = 'UNSURE';
	}
	if (out.importance !== 'STAR') out.draft_reply = false;
	if (facts && facts.last_from_nik) out.draft_reply = false;
	if (out.importance === 'ARCHIVE' || out.importance === 'BLOCK') out.notify = false;
	out.draft_reply = out.draft_reply === true;
	out.notify = out.notify === true;
	return out;
}

/**
 * True when the thread already holds a draft. Stops duplicate drafts across retries.
 * @param {GmailThread} thread
 * @return {Boolean}
 */
function threadHasDraft(thread) {
	try {
		var id = thread.getId();
		return GmailApp.getDrafts().some(function (d) {
			try { return d.getMessage().getThread().getId() === id; } catch (e) { return false; }
		});
	} catch (e) {
		Logger.log('threadHasDraft error: ' + e.toString());
		return false;
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
			timestamp: new Date().toISOString()
		};
		options.contentType = 'application/json';
		options.payload = JSON.stringify(payload);
	}

	try {
		var response = UrlFetchApp.fetch(finalUrl, options);
		Logger.log(`Webhook Sent: ${response.getResponseCode()}`);
	} catch (e) {
		Logger.log(`Webhook Error: ${e.toString()}`);
	}
}

/**
 * Constructs a Gmail-style quoted reply HTML body.
 * @param {GmailMessage} originalMessage 
 * @param {String} newDraftText 
 * @return {String} HTML body with quoted history
 */
function constructQuotedReply(originalMessage, newDraftText) {
	var date = originalMessage.getDate();
	var from = originalMessage.getFrom();
	// Format date roughly like Gmail: "On Fri, Feb 14, 2025 at 8:30 AM Name <email> wrote:"
	var dateStr = Utilities.formatDate(date, Session.getScriptTimeZone(), "EEE, MMM d, yyyy 'at' h:mm a");

	// Clean up newDraftText (convert newlines to <br>)
	var htmlDraftText = newDraftText.replace(/\n/g, '<br>');

	// Build the HTML
	var html = `
    <div dir="ltr" style="font-family: Arial, sans-serif; font-size: 12.8px; color: rgb(34, 34, 34);">
    ${htmlDraftText}
    </div>
    <br><br>
    <div class="gmail_quote">
      On ${dateStr}, ${from} wrote:<br>
      <blockquote class="gmail_quote" style="margin: 0px 0px 0px 0.8ex; border-left: 1px solid rgb(204, 204, 204); padding-left: 1ex;">
        ${originalMessage.getBody()} 
      </blockquote>
    </div>
  `;
	return html;
}

/**
 * Helper to clean email body:
 * - Preserves quotes
 * - Removes IGNORE_PHRASES (boilerplate)
 * - Strips internal headers
 * - Truncates to custom limit
 */
function cleanEmailBody(rawBody, maxLength) {
	var body = rawBody;

	// 1. Remove Ignore Phrases
	if (CONFIG.IGNORE_PHRASES && CONFIG.IGNORE_PHRASES.length > 0) {
		CONFIG.IGNORE_PHRASES.forEach(phrase => {
			if (phrase instanceof RegExp) {
				body = body.replace(phrase, '');
			} else {
				// Global replace of the string
				body = body.split(phrase).join('');
			}
		});
	}

	// 2. Strip Metadata Headers (common in forwarded/replied chains)
	// Attempts to remove "From: ...", "Sent: ...", "To: ...", "Subject: ..." lines
	body = body.replace(/^From:.*$/gm, '')
		.replace(/^Sent:.*$/gm, '')
		.replace(/^Date:.*$/gm, '')
		.replace(/^To:.*$/gm, '')
		.replace(/^Subject:.*$/gm, '');

	// 3. Cleanup Whitespace
	body = body.replace(/\n\s*\n/g, '\n').trim();

	// 4. Truncate
	var limit = maxLength || 2000;
	if (body.length > limit) {
		body = body.substring(0, limit) + "\n...[TRUNCATED]";
	}

	return body;
}

/**
 * Creates a reply-all draft for a thread, but excludes the user's own email and aliases from recipients.
 * @param {GmailThread} thread 
 * @param {GmailMessage} originalMessage 
 * @param {String} htmlBody 
 */
function createDraftReplyAllExcludingSelf(thread, originalMessage, htmlBody) {
	var myEmail = Session.getActiveUser().getEmail().toLowerCase();
	var aliases = [];
	try {
		aliases = GmailApp.getAliases().map(a => a.toLowerCase());
	} catch (e) {
		Logger.log("Error getting aliases: " + e.toString());
	}

	function isMe(email) {
		var cleanEmail = email.toLowerCase().trim();
		if (cleanEmail === myEmail) return true;
		return aliases.indexOf(cleanEmail) !== -1;
	}

	// Helper to extract email addresses from headers like "Name <email@example.com>"
	function extractEmailAddresses(headerVal) {
		if (!headerVal) return [];
		var emails = [];
		var parts = headerVal.split(',');
		parts.forEach(part => {
			var match = part.match(/<([^>]+)>/);
			var email = match ? match[1] : part;
			email = email.trim();
			if (email) {
				emails.push(email);
			}
		});
		return emails;
	}

	var toRecipients = [];
	var ccRecipients = [];

	// 1. Reply-to or From is the primary To recipient
	var replyTo = originalMessage.getReplyTo() || originalMessage.getFrom();
	var primaryEmails = extractEmailAddresses(replyTo);
	primaryEmails.forEach(e => {
		if (!isMe(e) && toRecipients.indexOf(e) === -1) {
			toRecipients.push(e);
		}
	});

	// If the primary sender is me, look at the original To recipients of the message
	if (toRecipients.length === 0) {
		var originalToEmails = extractEmailAddresses(originalMessage.getTo());
		originalToEmails.forEach(e => {
			if (!isMe(e) && toRecipients.indexOf(e) === -1) {
				toRecipients.push(e);
			}
		});
	}

	// 2. Add other To and Cc recipients to Cc
	var allTo = extractEmailAddresses(originalMessage.getTo());
	var allCc = extractEmailAddresses(originalMessage.getCc());

	allTo.forEach(e => {
		if (!isMe(e) && toRecipients.indexOf(e) === -1 && ccRecipients.indexOf(e) === -1) {
			ccRecipients.push(e);
		}
	});

	allCc.forEach(e => {
		if (!isMe(e) && toRecipients.indexOf(e) === -1 && ccRecipients.indexOf(e) === -1) {
			ccRecipients.push(e);
		}
	});

	var options = {
		htmlBody: htmlBody,
		threadId: thread.getId()
	};

	if (ccRecipients.length > 0) {
		options.cc = ccRecipients.join(',');
	}

	// If there are no recipients left (e.g. email was only to/from me), default to sending to me
	var toField = toRecipients.join(',');
	if (!toField) {
		toField = myEmail;
	}

	// Make sure the subject prefix matches thread context
	var subject = originalMessage.getSubject();
	if (subject && !/^re:/i.test(subject)) {
		subject = "Re: " + subject;
	}

	GmailApp.createDraft(toField, subject, "", options);
}


/**
 * Removes prior ai_* labels from the thread before applying new ones.
 * @param {GmailThread} thread
 */
function removeAiLabels(thread) {
	try {
		var labels = thread.getLabels();
		labels.forEach(function (lbl) {
			if (lbl.getName().toLowerCase().startsWith("ai_")) {
				thread.removeLabel(lbl);
			}
		});
	} catch (e) {
		Logger.log("Error removing prior ai_* labels: " + e.toString());
	}
}

/**
 * Checks if a sender email address matches any domain or pattern in CONFIG.EXCLUDED_DOMAINS.
 * @param {String} fromHeader
 * @return {Boolean}
 */
function isSenderExcluded(fromHeader) {
	if (!fromHeader || !CONFIG.EXCLUDED_DOMAINS || !Array.isArray(CONFIG.EXCLUDED_DOMAINS)) {
		return false;
	}
	var email = fromHeader.toLowerCase();
	return CONFIG.EXCLUDED_DOMAINS.some(function (domain) {
		return email.indexOf(domain.toLowerCase()) !== -1;
	});
}

/**
 * Checks if a message was sent by the authenticated user or one of their aliases.
 * @param {GmailMessage} message
 * @return {Boolean}
 */
function isMessageFromUser(message) {
	if (!message) return false;
	var fromHeader = message.getFrom();
	var email = extractSingleEmail(fromHeader);
	return isUserEmail(email);
}

/**
 * Helper to check if an email matches the active user or any alias.
 * @param {String} email
 * @return {Boolean}
 */
function isUserEmail(email) {
	if (!email) return false;
	var myEmail = Session.getActiveUser().getEmail().toLowerCase();
	var aliases = [];
	try {
		aliases = GmailApp.getAliases().map(function (a) { return a.toLowerCase(); });
	} catch (e) {
		Logger.log("Error getting aliases: " + e.toString());
	}
	var cleanEmail = email.toLowerCase().trim();
	if (cleanEmail === myEmail) return true;
	return aliases.indexOf(cleanEmail) !== -1;
}

/**
 * Helper to extract single email address from header like "Name <email@example.com>" or "email@example.com"
 * @param {String} headerVal
 * @return {String}
 */
function extractSingleEmail(headerVal) {
	if (!headerVal) return "";
	var match = headerVal.match(/<([^>]+)>/);
	return (match ? match[1] : headerVal).trim().toLowerCase();
}

/**
 * Expire stale drafts for a thread once replied (also removes ai_draft label).
 * @param {GmailThread} thread
 */
var _cachedDrafts = null;
function expireStaleDraftsForThread(thread) {
	try {
		// 1. Remove ai_draft label if present
		var draftLabelName = (CONFIG.LABELS && CONFIG.LABELS.DRAFT) ? CONFIG.LABELS.DRAFT : "ai_draft";
		var draftLabel = GmailApp.getUserLabelByName(draftLabelName);
		if (draftLabel) {
			thread.removeLabel(draftLabel);
		}

		// 2. Delete any drafts belonging to this thread
		if (_cachedDrafts === null) {
			try {
				_cachedDrafts = GmailApp.getDrafts();
			} catch (e) {
				_cachedDrafts = [];
				Logger.log("Error fetching drafts: " + e.toString());
			}
		}
		var threadId = thread.getId();
		_cachedDrafts.forEach(function (d) {
			try {
				if (d && d.getMessage && d.getMessage().getThread().getId() === threadId) {
					d.deleteDraft();
					Logger.log(`Deleted stale draft for thread ${threadId}`);
				}
			} catch (err) {
				Logger.log(`Error deleting individual draft: ${err.toString()}`);
			}
		});
	} catch (e) {
		Logger.log(`Error expiring stale drafts for thread ${thread.getId()}: ${e.toString()}`);
	}
}
