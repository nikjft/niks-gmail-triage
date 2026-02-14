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
-   **Timestamp Tracking**: Tracks the last processed time to ensure no new messages in threads are missed.
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
    -   `Prompts.js`

### 2. Configure Environment Variables (Script Properties)
The script uses **Script Properties** to securely store your API keys. Using files like `Setup.js` is deprecated.

1.  In the Apps Script Editor, click the **Project Settings** (gear icon) in the left sidebar.
2.  Scroll down to **Script Properties** and click **Edit script properties**.
3.  Add the following properties:
    -   `GEMINI_API_KEY`: Your API key from [aistudio.google.com](https://aistudio.google.com/).
    -   `WEBHOOK_URL` (Optional): A webhook URL for urgent notifications.

### 3. Customize Configuration
-   **`Config.js`**:
    -   Update `SOURCE_LABELS` to define which emails to check (e.g., `is:unread in:inbox`).
    -   Adjust `GEMINI_MODEL_TRIAGE` or `GEMINI_MODEL_DRAFT` if you want to use different models.
    -   Set `ENABLE_DESTRUCTIVE_ACTIONS` to `true` if you trust the AI to Archive/Delete for you (default is `false`).
-   **`Prompts.js`**:
    -   Edit `PROMPTS.TRIAGE` to change how the AI prioritizes emails.
    -   Edit `PROMPTS.DRAFTING` to change the tone/voice of the replies. Uses the "Writing Style Examples" pulled from your sent folder.

### 4. Test It
1.  Open `Main.js`.
2.  Run `processIncomingMail()`.
3.  Check the "Execution Transcript" log to see what it did.
4.  Check your Gmail to see the labels applied (`ai_draft`, `ai_star`, etc.).

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
