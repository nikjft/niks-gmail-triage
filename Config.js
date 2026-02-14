/**
 * Configuration for the Email Triage Agent.
 * * NOTE: API Keys and specific settings are now pulled from Script Properties.
 * Run the 'setupEnvironmentVariables' function once to save your keys.
 */

var scriptProperties = PropertiesService.getScriptProperties();

var CONFIG = {
	// ---------------- SECURITY & API ----------------
	GEMINI_API_KEY: scriptProperties.getProperty('GEMINI_API_KEY'),
	WEBHOOK_URL: scriptProperties.getProperty('WEBHOOK_URL'),
	WEBHOOK_MODE: scriptProperties.getProperty('WEBHOOK_MODE') || 'JSON', // 'JSON', 'TEXT', 'URL_PARAM'
	WEBHOOK_PARAM_NAME: scriptProperties.getProperty('WEBHOOK_PARAM_NAME') || 'message',

	// ---------------- TUNING ----------------
	// UPDATED: Defaults to 'gemini-3-flash'
	// ---------------- TUNING ----------------
	GEMINI_MODEL_TRIAGE: 'gemini-2.5-flash-lite',
	// ---------------- BATCH OPTIMIZATION ----------------
	MIN_BATCH_SIZE: 5,         // Wait for 5 emails before running...
	MAX_WAIT_TIME_MINUTES: 120, // ...unless it's been 2 hours since last run.

	// Safety Flag: If false, actions like ARCHIVE/BLOCK will only label the email.
	ENABLE_DESTRUCTIVE_ACTIONS: scriptProperties.getProperty('ENABLE_DESTRUCTIVE_ACTIONS') === 'true',

	// How many emails to process per execution (keep low to avoid timeout)
	MAX_EMAILS_TO_PROCESS: 30,

	// ---------------- SOURCES & LABELS ----------------
	// Search queries to find emails to triage
	// UPDATED: Exclude already processed emails to save tokens
	SOURCE_LABELS: [
		'is:unread in:inbox -is:starred',
		'is:unread label:@SaneLater -is:starred'
	],

	// Labels to apply based on outcome
	LABELS: {
		STAR: "ai_star",
		DRAFT: "ai_draft",
		NOTIFY: "ai_notify",
		ARCHIVE: "ai_archive",
		BLOCK: "ai_block",
		UNSURE: "ai_unsure"
	},

	// ---------------- CONTEXT SOURCES ----------------
	TRELLO_LABEL: scriptProperties.getProperty('TRELLO_LABEL') || 'label:_🔜-Trello',
	MAX_HISTORY_DAYS: 14, // How far back to look for context
	MAX_EMAIL_LOOKBACK_DAYS: 14, // Only process emails newer than this (prevents processing backlog)

	// ---------------- EXCLUSIONS ----------------
	EXCLUDED_DOMAINS: [
		'calendar-notification@google.com',
		'notifications@trello.com',
		'noreply@',
		'linkedin.com',
		'docs.google.com',
		'harvest.com',
		'gong.io',
		'fathom.video',
		'zoom.us',
		'slack.com'
	],

	// ---------------- PROMPTS ----------------
	TRIAGE_PROMPT: `
    You are an executive email triage assistant. Your goal is to review incoming mail and decide actions.
    
    ASSESSMENT 1: IMPORTANCE (Pick ONE)
    - ARCHIVE: Low value, newsletters, cold outreach, or irrelevant notifications.
    - BLOCK: Obvious spam or malicious.
    - STAR: High priority. Needs to be read.
    - NEITHER: Normal priority, read later.
    - UNSURE: You are truly uncertain.

    ASSESSMENT 2: DRAFT REPLY (Boolean)
    - Set to TRUE if the email requests a response from me specifically.
    - IGNORE if Importance is ARCHIVE or BLOCK.

    ASSESSMENT 3: NOTIFY (Boolean)
    - Set to TRUE if extremely urgent or time-sensitive.
    - IGNORE if Importance is ARCHIVE or BLOCK.

    HIGH PRIORITY INDICATORS:
	- Related to a sales proposal, discovery meeting, or presentation
	- Issues with clients, including billing, delivery failures
	- Tone that may represent dissatisfaction, anger, frustration
	- Time sensitive requests for information or action
	- Requests for digital signatures (star, do not reply)

    INPUT DATA:
    1. Active Contexts: Recent projects and recent contacts.
    2. Incoming Email: The sender, subject, and preview.

    OUTPUT FORMAT:
    Return strictly JSON:
    {
      "msg_id": {
        "importance": "ARCHIVE" | "BLOCK" | "STAR" | "NEITHER" | "UNSURE",
        "draft_reply": true | false,
        "notify": true | false,
        "notification_text": "Short alert text if notify is true",
        "reason": "Short explanation of your decisions"
      }
    }
  `,

	DRAFTING_PROMPT: `
    You are an executive email triage assistant. Your goal is to DRAFT REPLIES for the provided emails.

    VOICE & TONE GUIDELINES:
    - MIMIC THE USER: Use the provided "Writing Style Examples" as your guide. 
	- Speak as an executive strategic consultant who balances efficiency with warmth
	- Write in micro-paragraphs (strictly 1-3 sentences max) separated by white space to ensure immediate scannability. Avoid walls of text.
	- Tone: Be direct but low-friction. Use polite softeners (e.g., "no worries," "happy to give you your time back," "y'all") to maintain a human connection, but get straight to the business value or blocker.
		- The Hook: State the update, "good news," or blocker immediately.
		- The Details: If technical, keep it high-level and punchy; link to external resources for deep dives.
		- The Close: Always end with a specific next step, approval request ("Please advise"), or time proposal.
		- Sign-off: "Best," followed by a line break and the name.
	- PROFESSIONALISM: Use standard capitalization and punctuation.
    - NO AI TELLALES: Do NOT use words like "delve", "tapestry", "complex landscape", "ensure", "kindly".
    - BE BRIEF: Executives write short, direct emails. No fluff. 8th grade reading level.
    - NO WEIRD FORMATTING: Do not use bold/markdown in the email body unless explicitly necessary.

    OUTPUT FORMAT:
    Return strictly JSON:
    {
      "msg_id": {
        "draft_text": "The draft reply body",
        "reason": "Reason for the drafted text"
      }
    }
  `
};