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
	WEBHOOK_MODE: 'URL_PARAM',
	WEBHOOK_PARAM_NAME: 'message',

	// ---------------- TUNING ----------------
	// UPDATED: Defaults to 'gemini-3-flash'
	// ---------------- TUNING ----------------
	GEMINI_MODEL_TRIAGE: 'gemini-2.5-flash-lite',
	// ---------------- BATCH OPTIMIZATION ----------------
	MIN_BATCH_SIZE: 5,         // Wait for 5 emails before running...
	MAX_WAIT_TIME_MINUTES: 120, // ...unless it's been 2 hours since last run.

	// Safety Flag: If false, actions like ARCHIVE/BLOCK will only label the email.
	ENABLE_DESTRUCTIVE_ACTIONS: false,

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
	TRELLO_LABEL: 'label:_🔜-Trello',
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
	// Now imported from PROMPTS.js through PROMPTS global object
};