/**
 * TEST SUITE
 * Run these functions from the Apps Script editor to verify your setup.
 */

function testConfiguration() {
	Logger.log("--- Testing Configuration ---");
	Logger.log("API Key present: " + (!!CONFIG.GEMINI_API_KEY));
	Logger.log("Triage Model: " + CONFIG.GEMINI_MODEL_TRIAGE);
	Logger.log("Draft Model: " + CONFIG.GEMINI_MODEL_DRAFT);
	Logger.log("Trello Label: " + CONFIG.TRELLO_LABEL);
}

function testContextBuilder() {
	Logger.log("--- Testing Context Builder ---");
	try {
		// Test Context Splitting
		var contextObj = buildActiveContext(true); // Force Refresh

		Logger.log("\n[TRIAGE CONTEXT PREVIEW]:");
		Logger.log(contextObj.triageContext.substring(0, 500) + "...");

		Logger.log("\n[DRAFTING CONTEXT PREVIEW]:");
		// Should NOT contain "Recent Contacts" or "Recent Subjects"
		Logger.log(contextObj.draftingContext.substring(0, 500) + "...");

		if (contextObj.draftingContext.includes("RECENT EMAIL SUBJECTS")) {
			Logger.log("❌ FAILURE: Drafting context contains Recent Subjects (should be excluded).");
		} else {
			Logger.log("✅ SUCCESS: Drafting context appears clean.");
		}

	} catch (e) {
		Logger.log("❌ Error building context: " + e.toString());
	}
}

/**
 * Tests the specific limits for Triage vs Drafting cleaning
 */
function testBodyCleaningLimits() {
	Logger.log("--- Testing Body Cleaning Limits ---");
	var longBody = "A".repeat(5000); // 5000 chars

	var triageClean = cleanEmailBody(longBody, CONFIG.MAX_TRIAGE_BODY_CHARS);
	var draftClean = cleanEmailBody(longBody, CONFIG.MAX_DRAFT_BODY_CHARS);

	Logger.log(`Triage Limit: ${CONFIG.MAX_TRIAGE_BODY_CHARS} -> Actual: ${triageClean.length}`);
	Logger.log(`Draft Limit: ${CONFIG.MAX_DRAFT_BODY_CHARS} -> Actual: ${draftClean.length}`);

	if (triageClean.length <= CONFIG.MAX_TRIAGE_BODY_CHARS + 50) { // +50 for "...[TRUNCATED]"
		Logger.log("✅ Triage Truncation working");
	} else {
		Logger.log("❌ Triage Truncation FAILED");
	}
}

function testWebhook() {
	Logger.log("--- Testing Webhook ---");

	if (!CONFIG.WEBHOOK_URL || CONFIG.WEBHOOK_URL.includes('YOUR_WEBHOOK_URL')) {
		Logger.log("⚠️ Webhook URL not configured in Script Properties or updated in Config.js");
		return;
	}

	Logger.log(`Target URL: ${CONFIG.WEBHOOK_URL}`);

	// Mock Message Object
	var mockMessage = {
		getId: function () { return "msg_test_123"; },
		getSubject: function () { return "Test Email Subject"; },
		getFrom: function () { return "test@example.com"; }
	};

	// Mock Decision
	var mockDecision = {
		importance: "STAR",
		draft_reply: false,
		notify: true,
		notification_text: "This is a test notification from the Triage Agent.",
		reason: "Testing webhook functionality."
	};

	// Call the actual helper function from Main.js
	callWebhook(mockDecision, mockMessage);
	Logger.log("Webhook call initiated. Check logs above for success/error.");
}

/**
 * DEBUG TOOL: Test Context Cleaning
 * Runs the cleaning logic on recent emails and logs the result.
 * Does NOT call Gemini.
 */
function testContextCleaning() {
	var threads = GmailApp.search("in:inbox", 0, 3);
	Logger.log(`Testing cleaning on ${threads.length} threads...`);

	threads.forEach((t, i) => {
		var msg = t.getMessages().pop(); // Last message
		var raw = msg.getPlainBody();

		// Test with DRAFT limit to see full content
		var cleaned = cleanEmailBody(raw, CONFIG.MAX_DRAFT_BODY_CHARS);

		Logger.log(`\n--- MSG ${i + 1}: ${msg.getSubject()} ---`);
		Logger.log(`[ORIGINAL LEN]: ${raw.length}`);
		Logger.log(`[RAW START (first 500 chars)]:\n${raw.substring(0, 500)}...`);
		Logger.log(`[CLEANED LEN]: ${cleaned.length}`);
		Logger.log(`[CLEANED CONTENT START]: \n${cleaned.substring(0, 500)}`);
		Logger.log(`[CLEANED CONTENT END]: \n${cleaned.substring(Math.max(0, cleaned.length - 200))}`);
	});
}