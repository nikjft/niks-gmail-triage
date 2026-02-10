# Gmail Triage Agent (Gemini Powered)

A "vibe coded" Google Apps Script that uses Google's Gemini AI to triage your inbox. It mimics your writing style to draft replies, prioritizes emails, and can send webhook notifications for urgent matters.

**⚠️ DISCLAIMER: This code was "vibe coded". Use at your own risk. Always verify AI actions before enabling destructive settings.**

## Features

-   **Smart Triage**: Categorizes emails into `STAR` (Important), `DRAFT_REPLY` (Needs Response), `ARCHIVE`, `BLOCK`, or `UNSURE`.
-   **Context Aware**: analyzing your recent sent emails and Trello board (optional) to understand what's currently important to you.
-   **Style Mimicry**: analyzing your recent sent emails to match your tone and capitalization style in draft replies.
-   **Safety Mode**: By default, "destructive" actions (Archive/Block) only apply a label (`ai_archive`, `ai_block`) so you can review them.
-   **Non-Exclusive Actions**: An email can be Starred, Drafted, AND trigger a Notification simultaneously.
-   **Batch Processing**: Processes emails in batches to save costs and time.
-   **Webhooks**: Can trigger a generic webhook (e.g., Zapier, Pushover) for urgent notifications.

## Setup Guide

### 1. Create the Script
1.  Go to [script.google.com](https://script.google.com/).
2.  Create a new project.
3.  Copy the contents of the `.js` files in this repo into corresponding files in the Apps Script editor:
    -   `Config.js`
    -   `ContextBuilder.js`
    -   `GeminiOrchestrator.js`
    -   `Main.js`
    -   `Setup.js`

### 2. Configure Environment Variables
1.  Open `Setup.js`.
2.  Enter your **Gemini API Key** (get one from [aistudio.google.com](https://aistudio.google.com/)).
3.  (Optional) Enter a **Webhook URL** for notifications.
4.  Run the function `setupEnvironmentVariables()` **once**. This saves your keys to the secure "Script Properties" store.
    -   *Note: If you leave a field blank or wrapped in `[]` (like `[YOUR_KEY]`), the script will skip updating that value, preserving existing settings.*

### 3. Customize `Config.js`
Open `Config.js` and tweak:
-   **`SOURCE_LABELS`**: The Gmail search queries to find emails to triage (default: `is:unread in:inbox`).
-   **`LABELS`**: The label names the AI will apply (e.g., `ai_star`, `ai_draft`).
-   **`MAX_EMAIL_LOOKBACK_DAYS`**: How far back to check for new mail (default: 3 days).
-   **`SYSTEM_PROMPT`**: The core personality and rules for the AI.

### 4. Test It
1.  Open `Main.js`.
2.  Run `processIncomingMail()`.
3.  Check the "Execution Transcript" log to see what it did.
4.  Check your Gmail to see the labels applied (`ai_processed`, `ai_draft`, etc.).

### 5. Automate It
1.  Go to **Triggers** (clock icon) in Apps Script.
2.  Add a Trigger for `refreshContextCache`:
    -   Event Source: Time-driven
    -   Type: Minutes timer -> Every 30 minutes
3.  Add a Trigger for `processIncomingMail`:
    -   Event Source: Time-driven
    -   Type: Minutes timer -> Every 10 minutes (or as frequent as you like).

## License

MIT License

Copyright (c) 2024

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
