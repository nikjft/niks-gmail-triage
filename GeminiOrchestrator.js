/**
 * STAGE 1: TRIAGE
 * Calls Gemini with a batch of emails for classification.
 * @param {Array} emailBatch Array of Objects {id, from, subject, body} (Body is truncated)
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
    Body Preview: ${email.body}
    --------------------------------------------------`;
	}).join("\n");

	var userPrompt = `
    ACTIVE CONTEXT (Projects & Contacts):
    ${triageContext}

    INCOMING EMAILS TO TRIAGE (${emailBatch.length} items):
    ${emailListString}
    
    INSTRUCTIONS:
    Review each email against the Active Context.
    Return a JSON object where the keys are the "ID" provided above (e.g. "msg_123") and the values are the decision objects.
    USE THE OUTPUT FORMAT DEFINED IN THE SYSTEM PROMPT.
  `;

	var payload = {
		"contents": [{
			"parts": [{ "text": PROMPTS.TRIAGE + "\n\n" + userPrompt }]
		}],
		"generationConfig": {
			"response_mime_type": "application/json"
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
    Body:
    ${email.body}
    --------------------------------------------------`;
	}).join("\n");

	var userPrompt = `
    ACTIVE CONTEXT (Style & History):
    ${draftingContext}

    EMAILS TO DRAFT (${emailBatch.length} items):
    ${emailListString}
  `;

	var payload = {
		"contents": [{
			"parts": [{ "text": PROMPTS.DRAFTING + "\n\n" + userPrompt }]
		}],
		"generationConfig": {
			"response_mime_type": "application/json"
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
			Logger.log(`Error calling Gemini API: ${responseCode} - ${responseText}`);
			return {};
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

		// Flatten Array if necessary
		if (Array.isArray(parsed)) {
			var flatMap = {};
			parsed.forEach(item => {
				for (var key in item) {
					flatMap[key] = item[key];
				}
			});
			return flatMap;
		}

		return parsed;
	} catch (e) {
		Logger.log("Exception calling Gemini: " + e.toString());
		return {};
	}
}