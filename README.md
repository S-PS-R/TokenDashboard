# Codex Plus Dashboard

A local dashboard for Codex activity under a ChatGPT Plus plan. Uses your existing Codex ChatGPT sign-in. No API key, external dependencies, or model requests are needed.

## Start

Install Node.js 20 or newer if needed, then run in this folder:

```powershell
node server.mjs
```

Open the local URL printed in the terminal, normally http://127.0.0.1:8787. Stop with Ctrl+C. `Start Dashboard.cmd` also starts the server on Windows and supports the bundled Codex Node runtime when Node is absent from PATH. The terminal must stay open while the dashboard is in use.

## What you get

- ChatGPT account allowance percentages and reset times through the documented `account/rateLimits/read` Codex app-server request. Multiple allowance buckets are displayed when returned.
- Account token-activity summary when `account/usage/read` is supported and available for your account.
- Local session token totals split into input, cached input, output, and reasoning output.
- A dark theme, hourly/daily charts, a GitHub-style 365-day heatmap, project/model filters, per-session and per-project totals, inferred running status, and CSV export. Heatmap squares show token usage through four green intensity levels, with month/weekday labels and exact details on hover or keyboard focus.
- Account refresh every 60 seconds, local log reads every 2.5 seconds, and automatic browser updates.

## Data and accuracy

Allowance comes from Codex services through a separate local app-server process using the existing CLI sign-in. This does not start tasks, send prompts, buy credits, or redeem resets. Codex itself handles authentication. The dashboard never reads `auth.json`, sends tokens to the browser, or displays account email. The process may use the network to fetch account information; the dashboard is served only on `127.0.0.1`.

If the CLI is missing, disconnected, or does not support an endpoint, the dashboard shows the latest plan-limit snapshots in local logs. Every meter includes its source and observation time. A snapshot whose reset time has passed is explicitly marked; the dashboard never assumes it reset to zero. Account limits can include shared activity outside the logs collected here.

Task and project analytics cover only `sessions` and `archived_sessions` in the selected Codex directory, with session names from `session_index.jsonl`. They do not include all ChatGPT chats, other computers, or cloud tasks whose logs are absent locally. Other providers are excluded. If you switch between API-key and ChatGPT authentication, local session files may not reliably distinguish the billing mode; use this directory for your plan-based Codex activity.

The collector calculates increments from session cumulative counters to avoid repeatedly adding the same `last_token_usage`. The first event uses its last-turn counters to avoid counting inherited usage. Repeated history from forks is deduplicated by event timestamp and counters. Counter resets begin a new baseline. If logs start midway through a session, omit usage records, or change schema, counts can be incomplete. Reasoning output is already included in output; cached input is already included in input. Total = input + output.

Running status is inferred from task lifecycle records. An unfinished turn with no logged activity for 10 minutes is marked unconfirmed. Token counts update when Codex records them; the tool does not measure individual generated tokens live. CSV exports respect the current period and project/model filters. Pause freezes browser updates while collection continues.

Local token totals are not a conversion to Plus allowance or a subscription invoice. The dashboard deliberately does not attach API dollar estimates to Plus usage.

## Configuration

```powershell
$env:CODEX_DIR = 'C:\Users\you\.codex'
$env:CODEX_BIN = 'C:\path\to\codex.exe'
$env:PORT = '8787'
node server.mjs
```

The server automatically tries the next port if its preferred port is occupied. The Codex CLI must be available on PATH or set with `CODEX_BIN` for direct account readings. On Windows, the dashboard also detects the desktop app's bundled CLI under `%LOCALAPPDATA%\OpenAI\Codex\bin`. Account and log readings are held in memory; historical token trends are reconstructed from local logs on restart. A fresh account allowance reading takes priority over logged snapshots for two minutes.

## Checks

```powershell
node --test
```

Official app-server interface: https://learn.chatgpt.com/docs/app-server
