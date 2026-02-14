/**
 * Calls Gemini with a batch of emails.
 * @param {Array} emailBatch Array of Objects {id, from, subject, body}
 * @param {String} activeContext
 * @returns {Object} Map of email ID to Decision Object
 */
function callGeminiTriageBatch(emailBatch, activeContext) {
	if (!emailBatch || emailBatch.length === 0) return {};

	var apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

	// Construct a batch prompt
	var emailListString = emailBatch.map((email, index) => {
		return `
    EMAIL #${index} (ID: ${email.id}):
    From: ${email.from}
    Subject: ${email.subject}
    Labels: ${email.labels ? email.labels.join(', ') : "(None)"}
    Body: ${email.body}
    --------------------------------------------------`;
	}).join("\n");

	var userPrompt = `
    ACTIVE CONTEXT (What is important to me right now):
    ${activeContext}

    USER CONFIGURATION:
    - HIGH PRIORITY LABELS: ${JSON.stringify(CONFIG.PRIORITY_LABELS.HIGH)}
    - LOW PRIORITY LABELS: ${JSON.stringify(CONFIG.PRIORITY_LABELS.LOW)}

    INCOMING EMAILS TO TRIAGE (${emailBatch.length} items):
    ${emailListString}
    
    INSTRUCTIONS:
    Review each email against the Active Context.
    Return a JSON object where the keys are the "ID" provided above (e.g. "msg_123") and the values are the decision objects.
    USE THE OUTPUT FORMAT DEFINED IN THE SYSTEM PROMPT.
  `;

	var payload = {
		"contents": [{
			"parts": [{ "text": CONFIG.SYSTEM_PROMPT + "\n\n" + userPrompt }]
		}],
		"generationConfig": {
			"response_mime_type": "application/json"
		}
	};

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
		Logger.log("Gemini Raw Response: " + responseText); // DEBUG

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
		Logger.log("Gemini Content Text: " + contentText); // DEBUG

		// Cleanup: Remove markdown code fencing if present
		contentText = contentText.replace(/^```json\n/, '').replace(/\n```$/, '').trim();

		var parsed = JSON.parse(contentText);

		// FIX: Gemini sometimes returns an Array of Objects [ {"msg_0": {}}, {"msg_1": {}} ]
		// We need to flatten this into a single Map { "msg_0": {}, "msg_1": {} }
		if (Array.isArray(parsed)) {
			var flatMap = {};
			parsed.forEach(item => {
				for (var key in item) {
					flatMap[key] = item[key];
				}
			});
			return flatMap;
		}

		return parsed; // Return the structured JSON map
	} catch (e) {
		Logger.log("Exception calling Gemini: " + e.toString());
		return {};
	}
}