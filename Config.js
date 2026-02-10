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
	GEMINI_MODEL: scriptProperties.getProperty('GEMINI_MODEL') || 'gemini-3-flash',

	// Safety Flag: If false, actions like ARCHIVE/BLOCK will only label the email.
	ENABLE_DESTRUCTIVE_ACTIONS: scriptProperties.getProperty('ENABLE_DESTRUCTIVE_ACTIONS') === 'true',

	// How many emails to process per execution (keep low to avoid timeout)
	MAX_EMAILS_TO_PROCESS: 30,

	// ---------------- SOURCES & LABELS ----------------
	// Search queries to find emails to triage
	// UPDATED: Exclude already processed emails to save tokens
	SOURCE_LABELS: [
		'is:unread in:inbox -label:ai_processed',
		'is:unread label:@SaneLater -label:ai_processed'
	],

	// Labels to apply based on outcome
	LABELS: {
		STAR: "ai_star",
		DRAFT: "ai_draft",
		NOTIFY: "ai_notify",
		ARCHIVE: "ai_archive",
		BLOCK: "ai_block",
		UNSURE: "ai_unsure",
		PROCESSED: "ai_processed" // Applied to ALL processed emails
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
	// ---------------- PROMPTS ----------------
	SYSTEM_PROMPT: `
    You are an executive email triage assistant. Your goal is to review incoming mail and decide multiple independent actions based on the user's "Active Context" (what they have been working on recently).

    ASSESSMENT 1: IMPORTANCE (Pick ONE)
    - ARCHIVE: Low value, newsletters, cold outreach, or irrelevant notifications.
    - BLOCK: Obvious spam or malicious.
    - STAR: High priority. Needs to be read (or requires offline action).
    - NEITHER: Normal priority, read later.
    - UNSURE: You are truly uncertain.

    ASSESSMENT 2: DRAFT REPLY (Boolean)
    - Set to TRUE if the email requires a response from me, or a request for status.
    - PROVIDE DRAFT TEXT if TRUE.
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

    VOICE & TONE GUIDELINES (CRITICAL for DRAFT_REPLY):
    - MIMIC THE USER: Use the provided "Writing Style Examples" as your guide. 
    - PROFESSIONALISM: Use standard capitalization and punctuation.
    - NO AI TELLALES: Do NOT use words like "delve", "tapestry", "complex landscape", "ensure", "kindly".
    - BE BRIEF: Executives write short, direct emails. No fluff. 8th grade reading level.
    - NO WEIRD FORMATTING: Do not use bold/markdown in the email body unless explicitly necessary.

    INPUT DATA:
    1. Active Contexts: Recent projects, board names, and *Writing Style Examples*.
    2. Incoming Email: The sender, subject, and body.

    OUTPUT FORMAT:
    Return strictly JSON:
    {
      "msg_id": {
        "importance": "ARCHIVE" | "BLOCK" | "STAR" | "NEITHER" | "UNSURE",
        "draft_reply": true | false,
        "draft_text": "Email body if draft_reply is true",
        "notify": true | false,
        "notification_text": "Short alert text if notify is true",
        "reason": "Short explanation of your decisions"
      }
    }
  `
};