/**
 * Regression Test for "Direct Mention" Scenario
 * 
 * Scenario:
 * Sender: Laura Pynn
 * Recipients: Aayush, me, Daniel, sjhowell, mwilks
 * Body: "Hi Aayush, this looks good to me, looping in @Nik Friedman TeBockhorst in case he wants to weigh in"
 * 
 * EXPECTED: 
 * - Importance: STAR
 * - Draft Reply: TRUE
 */

function testDirectMentionScenario() {
	Logger.log("=== REGRESSION TEST: Direct Mention ===");

	// 1. Mock Context (Minimal)
	var mockContext = {
		triageContext: "ACTIVE PROJECTS:\n- Project Alpha\n\nRECENT CONTACTS:\n- Laura Pynn\n- Aayush",
		draftingContext: "..."
	};

	// 2. Mock Email
	var mockEmail = {
		id: "msg_regression_1",
		from: "Laura Pynn <laura@example.com>",
		subject: "Re: Project Alpha Update",
		body: "Hi Aayush, this looks good to me, looping in @Nik Friedman TeBockhorst in case he wants to weigh in",
		labels: []
	};

	// 3. Call Stage 1 (we need to expose this or mock the orchestrator)
	// Since callGeminiStage1Triage is in GeminiOrchestrator.js, we can call it directly if we're in the same project.

	try {
		var decisionMap = callGeminiStage1Triage([mockEmail], mockContext.triageContext);
		var decision = decisionMap["msg_regression_1"];

		Logger.log("DECISION:");
		Logger.log(JSON.stringify(decision, null, 2));

		// Assertions
		if (decision.importance === 'STAR') {
			Logger.log("✅ PASS: Importance is STAR");
		} else {
			Logger.log("❌ FAIL: Importance is " + decision.importance + " (Expected: STAR)");
		}

		if (decision.draft_reply === true) {
			Logger.log("✅ PASS: Draft Reply is TRUE");
		} else {
			Logger.log("❌ FAIL: Draft Reply is " + decision.draft_reply + " (Expected: TRUE)");
		}

	} catch (e) {
		Logger.log("❌ ERROR: " + e.toString());
	}
}
