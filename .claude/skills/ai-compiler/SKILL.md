---
name: ai-compiler
description: Get second opinions, independent reviews, or cheap first drafts from free-tier AI models through the ai-compiler MCP tools (ask, panel, quota_status, list_skills). Use when a decision is uncertain enough that independent views would help, when the user asks what other models think, or for bulk low-stakes text work that does not need your own attention.
---

# Using AI Compiler from Claude Code

AI Compiler routes prompts to whichever free AI tier still has quota (Gemini, Groq, OpenRouter and others), using the user's own free API keys. Its MCP server gives you four tools.

## When it helps

- **Independent second opinions.** Before committing to a design, a tricky fix, or a claim you are unsure of, call `panel` with a self-contained description. You get several models' answers side by side. Read them as input from colleagues of mixed reliability: agreement between them is weak evidence, a point only one raises may still be the important one, and you remain responsible for checking anything you act on.
- **Extra reviewers on a diff or a plan.** `panel` with `skill: "code-review"` gives several independent reviews. Verify each reported bug against the code before repeating it to the user.
- **Cheap first drafts and bulk text work.** Summaries, rewording, boilerplate docs, test-case ideas: `ask` (mode `auto`, or `fast`) costs the user nothing and keeps your own effort for the parts that need it.
- **A quick outside check on a fact.** `ask` with mode `agent` and `skill: "research"` or `"fact-check"` can look things up on the web and on Wikipedia.

Skip it when you already know the answer, when the task needs the repository context you have and the models do not, or when the material is sensitive (see below).

## How to call it

- Write the prompt so it stands alone. The models see only what you send: include the relevant code, the constraints, and the exact question.
- `panel` returns raw answers for you to judge. `ask` with mode `boost` has a free model compile the answers instead. You are usually the better judge, so prefer `panel` when the result feeds your own work, and `boost` when the user wants a finished answer from the free models.
- `list_skills` shows the task presets. `quota_status` shows what is left today. If a call fails because every tier is rate limited, say so and carry on without it. Do not retry in a loop.
- Tell the user when an answer you give leaned on these models.

## What must not be sent

Prompts leave this computer for third-party services, and several free tiers keep prompts to train on.

- Never send secrets, credentials, API keys, tokens, or `.env` contents.
- Never send personal data about the user or anyone else.
- Before sending proprietary or unreleased code, check that the user is comfortable with that. If they have not said, ask once, or reduce the question to a minimal example that reveals nothing private.

## Saving keys

If a call fails because no provider is set up, run `key_status` to see which keys are missing and where each free one comes from, and tell the user. When the user gives you a key and asks you to save it, call `save_api_key` with its name and value; it is stored in a private file on their computer and checked with the provider. Never repeat a key back in your reply. If the user would rather not paste a key into the chat, tell them to run `aic keys set <NAME>` in a terminal (or `node src/cli.js keys set <NAME>` in the project folder), which asks for it without showing it.

## If the tools are missing

The MCP server is declared in this project's `.mcp.json` and has to be approved once in Claude Code. It also needs at least one provider key: the user adds those by running `npm start` and opening the dashboard at http://localhost:4141.
