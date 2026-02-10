/**
 * MockTriageTest.js
 * 
 * Simulates the logic we just added to Main.js to verify it correctly
 * handles threads with multiple messages.
 */

// --- MOCK CLASSES ---
class MockMessage {
	constructor(from, subject, body) {
		this.from = from;
		this.subject = subject;
		this.body = body;
	}
	getFrom() { return this.from; }
	getSubject() { return this.subject; }
	getPlainBody() { return this.body; }
	getId() { return Math.random().toString(36).substring(7); }
}

class MockThread {
	constructor(messages) {
		this.messages = messages; // Array of MockMessage (oldest to newest)
	}
	getMessages() { return this.messages; }
	getId() { return "thread_" + Math.random().toString(36).substring(7); }
}

// --- TEST FUNCTION ---
function testThreadLogic() {
	console.log("=== STARTING THREAD LOGIC TEST ===\n");

	// 1. Setup Data: A conversation with 3 messages
	// Msg 1: Client -> Me (Initial)
	// Msg 2: Me -> Client (Reply)
	// Msg 3: Client -> Me (Closure "Great thanks")

	var msg1 = new MockMessage("client@example.com", "Project Update", "Can you send the deck?");
	var msg2 = new MockMessage("me@company.com", "Re: Project Update", "Sure, here it is.");
	var msg3 = new MockMessage("client@example.com", "Re: Project Update", "Great thanks! received.");

	var thread = new MockThread([msg1, msg2, msg3]);
	var uniqueThreads = [thread];
	var emailBatch = [];
	var threadMap = {};

	// --- LOGIC FROM MAIN.JS (PASTED/ADAPTED) ---
	for (var i = 0; i < uniqueThreads.length; i++) {
		var thread = uniqueThreads[i];
		var allMessages = thread.getMessages(); // result is oldest to newest
		var msgCount = allMessages.length;

		if (msgCount === 0) continue;

		var lastMsg = allMessages[msgCount - 1]; // The latest message
		var msgId = "msg_" + i;

		// --- BUILD HISTORY CONTEXT ---
		var historyBody = "";
		if (msgCount > 1) {
			// Start from the message before the last one, go back up to 2 steps
			var historyLimit = Math.max(0, msgCount - 3);
			for (var h = msgCount - 2; h >= historyLimit; h--) {
				var histMsg = allMessages[h];
				var histFrom = histMsg.getFrom();
				var histBodyShort = histMsg.getPlainBody().substring(0, 800)
					.replace(/\n\s*\n/g, '\n');

				historyBody = `\n--- PREVIOUS MESSAGE (From: ${histFrom}) ---\n${histBodyShort}` + historyBody;
			}
		}

		// --- PROCESS LATEST MESSAGE ---
		var rawBody = lastMsg.getPlainBody();

		// Clean the latest message body (Mock cleaning logic)
		var cleanBody = rawBody.replace(/On .* wrote:[\s\S]*$/, '')
			.replace(/^>.*$/gm, '')
			.replace(/From:.*[\s\S]*?Subject:.*/, '')
			.replace(/\n\s*\n/g, '\n')
			.trim()
			.substring(0, 3000);

		// --- COMBINE FOR GEMINI ---
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
	}

	// --- VERIFICATION ---
	var result = emailBatch[0];

	console.log("Subject:", result.subject);
	console.log("From:", result.from);
	console.log("\n--- GENERATED BODY FOR GEMINI ---\n");
	console.log(result.body);
	console.log("\n---------------------------------\n");

	// Assertions
	if (result.from !== "client@example.com") console.error("FAIL: Incorrect 'From'. Expected client@example.com");
	else console.log("PASS: 'From' is correct.");

	if (!result.body.includes("[LATEST MESSAGE]")) console.error("FAIL: Missing [LATEST MESSAGE] tag.");
	else console.log("PASS: Found [LATEST MESSAGE] tag.");

	if (!result.body.includes("Great thanks! received.")) console.error("FAIL: Latest message content missing.");
	else console.log("PASS: Latest message content found.");

	if (!result.body.includes("[THREAD HISTORY]")) console.error("FAIL: Missing [THREAD HISTORY] tag.");
	else console.log("PASS: Found [THREAD HISTORY] tag.");

	if (!result.body.includes("Can you send the deck?")) console.error("FAIL: History (Msg 1) missing.");
	else console.log("PASS: History (Msg 1) found.");

	if (!result.body.includes("Sure, here it is.")) console.error("FAIL: History (Msg 2) missing.");
	else console.log("PASS: History (Msg 2) found.");
}

testThreadLogic();
