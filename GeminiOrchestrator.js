
/**
 * Response schemas. They force valid enums, so a typo cannot turn into a wrong action.
 * Kept in sync with the OUTPUT FORMAT blocks in Prompts.js.
 */
var TRIAGE_RESPONSE_SCHEMA = {
	"type": "ARRAY",
	"items": {
		"type": "OBJECT",
		"properties": {
			"id": { "type": "STRING" },
			"importance": { "type": "STRING", "enum": ["STAR", "NEITHER", "ARCHIVE", "BLOCK", "UNSURE"] },
			"draft_reply": { "type": "BOOLEAN" },
			"notify": { "type": "BOOLEAN" },
			"notification_text": { "type": "STRING" },
			"reason_code": {
				"type": "STRING",
				"enum": ["ACTIVE_DEAL_SIGNAL", "CLIENT_ISSUE", "ASK_OF_NIK", "CANDIDATE", "SIGNATURE", "TIME_SENSITIVE", "TONE", "ROUTINE_SCHEDULING", "SOLICITATION", "AUTOMATED", "ATS_NOISE", "SPAM", "FYI", "TEAMMATE_HANDLING", "FROM_NIK", "THIN_PREVIEW"]
			},
			"confidence": { "type": "STRING", "enum": ["high", "medium", "low"] },
			"needs_full_thread": { "type": "BOOLEAN" },
			"reason": { "type": "STRING" }
		},
		"required": ["id", "importance", "draft_reply", "notify", "notification_text", "reason_code", "confidence", "needs_full_thread", "reason"],
		"propertyOrdering": ["id", "importance", "draft_reply", "notify", "notification_text", "reason_code", "confidence", "needs_full_thread", "reason"]
	}
};

var DRAFT_RESPONSE_SCHEMA = {
	"type": "ARRAY",
	"items": {
		"type": "OBJECT",
		"properties": {
			"id": { "type": "STRING" },
			"draft_text": { "type": "STRING", "nullable": true },
			"asks_covered": { "type": "ARRAY", "items": { "type": "STRING" } },
			"abstain_reason": { "type": "STRING", "nullable": true },
			"reason": { "type": "STRING" }
		},
		"required": ["id", "draft_text", "asks_covered", "abstain_reason", "reason"],
		"propertyOrdering": ["id", "draft_text", "asks_covered", "abstain_reason", "reason"]
	}
};

/**
 * STAGE 1: TRIAGE
 * Calls Gemini with a batch of emails for classification.
 * @param {Array} emailBatch Array of Objects {id, from, subject, body, facts?} (Body is truncated)
 * @param {String} triageContext
 * @returns {Object} Map of email ID to Decision Object { importance, draft_reply, notify, reason }
 */
function callGeminiStage1Triage(emailBatch, triageContext) {
	if (!emailBatch || emailBatch.length === 0) return {};

	var apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL_TRIAGE}:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

	// Construct a batch prompt
	var emailListString = emailBatch.map((email, index) => {
		return `
    EMAIL #${index} (ID: ${email.id}):
    From: ${email.from}
    Subject: ${email.subject}
    ${email.facts ? 'FACTS: ' + email.facts + '\n    ' : ''}Body Preview: ${email.body}
    --------------------------------------------------`;
	}).join("\n");

	var hasContext = CONFIG.ENABLE_CONTEXT !== false && triageContext && triageContext.trim().length > 0;
	var contextBlock = hasContext ? `ACTIVE CONTEXT (Projects & Contacts):\n    ${triageContext}\n\n    ` : '';
	var reviewInstruction = hasContext ? "Review each email against the Active Context." : "Review each email.";

	var userPrompt = `
    ${contextBlock}INCOMING EMAILS TO TRIAGE (${emailBatch.length} items):
    ${emailListString}
    
    INSTRUCTIONS:
    ${reviewInstruction}
    Return a JSON array with one decision object per email. Put the "ID" provided above (e.g. "msg_123") in each object's "id" field.
    USE THE OUTPUT FORMAT DEFINED IN THE SYSTEM PROMPT.
  `;

	var payload = {
		"system_instruction": { "parts": [{ "text": PROMPTS.TRIAGE }] },
		"contents": [{ "role": "user", "parts": [{ "text": userPrompt }] }],
		"generationConfig": {
			"temperature": 0,
			"response_mime_type": "application/json",
			"response_schema": TRIAGE_RESPONSE_SCHEMA
		}
	};

	return callGeminiApi(apiUrl, payload);
}

/**
 * STAGE 2: DRAFTING
 * Calls Gemini to draft replies for specific emails.
 * @param {Array} emailBatch Array of Objects {id, from, subject, body} (FULL Body)
 * @param {String} draftingContext
 * @returns {Object} Map of email ID to { draft_text, reason }
 */
function callGeminiStage2Draft(emailBatch, draftingContext) {
	if (!emailBatch || emailBatch.length === 0) return {};

	var apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL_DRAFT}:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

	var emailListString = emailBatch.map((email, index) => {
		return `
    EMAIL (ID: ${email.id}):
    From: ${email.from}
    Subject: ${email.subject}
    ${email.facts ? 'FACTS: ' + email.facts + '\n    ' : ''}${email.history ? 'THREAD HISTORY (oldest first, before the message below):\n' + email.history + '\n    ' : ''}Body of the message to answer:
    ${email.body}
    --------------------------------------------------`;
	}).join("\n");

	var hasContext = CONFIG.ENABLE_CONTEXT !== false && draftingContext && draftingContext.trim().length > 0;
	var contextBlock = hasContext ? `ACTIVE CONTEXT (Style & History):\n    ${draftingContext}\n\n    ` : '';

	var userPrompt = `
    ${contextBlock}EMAILS TO DRAFT (${emailBatch.length} items):
    ${emailListString}

    Return a JSON array with one object per email. Put the "ID" in each object's "id" field.
    USE THE OUTPUT FORMAT DEFINED IN THE SYSTEM PROMPT.
  `;

	var payload = {
		"system_instruction": { "parts": [{ "text": PROMPTS.DRAFTING }] },
		"contents": [{ "role": "user", "parts": [{ "text": userPrompt }] }],
		"generationConfig": {
			"temperature": 0.4,
			"response_mime_type": "application/json",
			"response_schema": DRAFT_RESPONSE_SCHEMA
		}
	};

	return callGeminiApi(apiUrl, payload);
}


/**
 * Helper: Generic Gemini API Call
 */
function callGeminiApi(apiUrl, payload) {
	var options = {
		"method": "post",
		"contentType": "application/json",
		"payload": JSON.stringify(payload),
		"muteHttpExceptions": true
	};

	try {
		var response = UrlFetchApp.fetch(apiUrl, options);
		var responseCode = response.getResponseCode();
		var responseText = response.getContentText();

		if (responseCode !== 200) {
			var errorMsg = `Error calling Gemini API: ${responseCode} - ${responseText}`;
			Logger.log(errorMsg);
			// THROW error so Main.js knows to abort and not save timestamp
			throw new Error(errorMsg);
		}

		var json = JSON.parse(responseText);

		if (!json.candidates || !json.candidates[0] || !json.candidates[0].content) {
			Logger.log("Invalid response structure from Gemini: " + responseText);
			return {};
		}

		var contentText = json.candidates[0].content.parts[0].text;

		// Cleanup: Remove markdown code fencing
		contentText = contentText.replace(/^```json\n/, '').replace(/\n```$/, '').trim();

		var parsed = JSON.parse(contentText);

		// Array of {id, ...} objects (current schema): convert to a map keyed by id.
		// Legacy array of {msg_id: {...}} objects: flatten.
		if (Array.isArray(parsed)) {
			var flatMap = {};
			parsed.forEach(item => {
				if (item && typeof item.id === 'string') {
					flatMap[item.id] = item;
				} else {
					for (var key in item) {
						flatMap[key] = item[key];
					}
				}
			});
			return flatMap;
		}

		return parsed;
	} catch (e) {
		Logger.log("Exception calling Gemini: " + e.toString());
		throw e; // Re-throw to ensure Main.js handles the abort
	}
}