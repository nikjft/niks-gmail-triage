/**
 * TEST SUITE
 * Run these functions from the Apps Script editor to verify your setup.
 */

function testConfiguration() {
	Logger.log("--- Testing Configuration ---");
	Logger.log("API Key present: " + (!!CONFIG.GEMINI_API_KEY));
	Logger.log("Model: " + CONFIG.GEMINI_MODEL);
	Logger.log("Trello Label: " + CONFIG.TRELLO_LABEL);
}

function testContextBuilder() {
	Logger.log("--- Testing Context Builder ---");
	try {
		// Test Force Refresh
		var context = buildActiveContext(true);
		Logger.log("Context Length: " + context.length + " chars");
		Logger.log("Context Preview:\n" + context.substring(0, 500) + "...");
	} catch (e) {
		Logger.log("❌ Error building context: " + e.toString());
	}
}

function testGeminiConnection() {
	Logger.log("--- Testing Gemini Connection (Batch) ---");
	var mockBatch = [
		{
			id: "msg_1",
			from: "boss@example.com",
			subject: "Urgent: Server Down",
			body: "The production server is down. Please fix ASAP."
		},
		{
			id: "msg_2",
			from: "newsletter@example.com",
			subject: "Weekly Update",
			body: "Here is your weekly update on tech news."
		}
	];

	var mockContext = "Active Project: Infrastructure stability";

	try {
		var decisionMap = callGeminiTriageBatch(mockBatch, mockContext);
		Logger.log("Decisions Received: " + JSON.stringify(decisionMap, null, 2));
	} catch (e) {
		Logger.log("❌ Error calling Gemini: " + e.toString());
	}
}

function testWebhook() {
	Logger.log("--- Testing Webhook ---");

	if (!CONFIG.WEBHOOK_URL || CONFIG.WEBHOOK_URL.includes('YOUR_WEBHOOK_URL')) {
		Logger.log("⚠️ Webhook URL not configured in Script Properties or updated in Config.js");
		return;
	}

	Logger.log(`Target URL: ${CONFIG.WEBHOOK_URL}`);
	Logger.log(`Mode: ${CONFIG.WEBHOOK_MODE}`);

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
