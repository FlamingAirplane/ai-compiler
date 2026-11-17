# AI Compiler

One local endpoint for every free AI tier you have a key for.

You add your free API keys (Google Gemini, Groq, OpenRouter, Mistral, GitHub Models and others). AI Compiler sends each prompt to a provider that still has free quota, tracks what you have used, rests any provider that hits its limit until the limit resets, and moves on to the next one. A harness on top (ensemble, draft-critique-revise, an agent with tools, and 36 skills) gets better answers out of free models than any one of them gives alone.

People use it through a chat page or the terminal. AI tools use it through an OpenAI-compatible API, an Anthropic-format API, or an MCP server.

It has no dependencies beyond Node.js 22 or newer.

**Website:** https://flamingairplane.github.io/ai-compiler/ · **How it works, and how it could be improved:** [docs/design.md](docs/design.md)

## Start

```bash
git clone https://github.com/FlamingAirplane/ai-compiler.git
cd ai-compiler
npm start
```

Open http://localhost:4141. Open a provider on the right, follow "Get a free key", paste the key into the card and press Save. One key is enough to start. Every extra provider adds more free quota.

To try everything first without any keys:

```bash
npm run demo
```

That runs three pretend providers on your computer so you can watch routing, rate limits, fallback and the harness work.

Once you have added keys, check that each one really works (this sends one tiny request per provider):

```bash
node src/cli.js check
```

## Using it

### Chat page

`npm start`, then http://localhost:4141. Pick an effort level, optionally a skill, and type. The panel on the right shows each provider's state, what you have used today, and what is left where the provider reports it.

### Terminal

```bash
node src/cli.js ask "Explain DNS in two sentences"
node src/cli.js ask --mode boost "Compare SQLite and Postgres for a small web app"
git diff | node src/cli.js ask -s code-review "Review this diff"
node src/cli.js chat
node src/cli.js status
node src/cli.js check
```

Run `npm link` once if you would rather type `aic` than `node src/cli.js`. `aic help` lists everything.

### From code or any OpenAI-compatible tool

Point the tool at `http://localhost:4141/v1` with any API key (it is ignored). Aider, Cline, Continue, OpenCode and the OpenAI SDKs all work this way.

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:4141/v1", api_key="unused")
reply = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello"}],
)
print(reply.choices[0].message.content)
```

The model name chooses the route:

| Model name | What happens |
| --- | --- |
| `auto` | Best free model available now, with automatic fallback. Unknown names such as `gpt-4o` also mean this. |
| `auto:smart`, `auto:fast` | Same, preferring larger or quicker models. |
| `groq`, `gemini/<model>` | One provider, or one exact model. |
| `gpt-oss-120b` | A model several providers serve: tried on each of them first, then anything else. |
| `boost` | The default harness (ensemble), or the one a skill prefers. |
| `ensemble`, `refine`, `agent`, `panel` | A specific harness mode. |
| `skill:code-review` | A skill on its own. |
| `boost@code-review` | A harness mode together with a skill. |

Streaming, function calling and images pass straight through to the provider. Every response says who answered: `x-aic-provider` and `x-aic-model` headers, and an `aic` field in the JSON.

### As the model behind Anthropic-format tools

The server also speaks the Anthropic Messages API at `http://localhost:4141/v1/messages`, including streaming and tool use. To run Claude Code on free models:

```bash
ANTHROPIC_BASE_URL=http://localhost:4141 ANTHROPIC_AUTH_TOKEN=unused claude
```

Free models are much weaker at long tool-using sessions than Claude, so expect this to work for small tasks and struggle on big ones. This path is tested against simulated providers only, not yet against real ones.

### As a helper inside Claude Code (MCP)

This folder already contains `.mcp.json`, so Claude Code offers the `ai-compiler` server when you open a session here (approve it once). To have it in every project, run this from the project folder:

```bash
claude mcp add --scope user ai-compiler -- node "$(pwd)/src/cli.js" mcp
```

It gives Claude Code four tools: `ask` (one answer), `panel` (several models' answers side by side, for Claude to judge), `quota_status` and `list_skills`. The skill in `.claude/skills/ai-compiler` tells Claude Code when these help and what must never be sent.

## The harness

Harness modes spend several free requests on one question, so they only run when a request asks for them.

| Mode | What it does | Requests |
| --- | --- | --- |
| `ensemble` | Three different models answer in parallel, then a strong model compiles one answer from the best parts. | about 4 |
| `refine` | One model drafts, a different model looks for mistakes, the draft is corrected. Stops early if the reviewer finds nothing. | 2 or 3 |
| `agent` | The model works in a loop and calls tools before answering. | 1 per round |
| `panel` | The same parallel answers, returned side by side without compiling. | 1 per model |

If only one model is available, `ensemble` runs as `refine`. If a request brings its own tools (an outside agent loop), it is passed through as a single request, because that caller expects tool calls back.

### Skills

A skill is a set of instructions for one kind of task. There are 36, in `skills/`: coding (`code`, `debug`, `code-review`, `refactor`, `write-tests`, `sql`, `regex`, and more), writing (`write`, `edit`, `summarize`, `translate`, `email`), research (`research`, `fact-check`, `compare`), analysis (`data-analysis`, `math`, `extract`, `decide`, `critique`), and thinking and learning (`brainstorm`, `plan`, `tutor`, `flashcards`). `aic skills` lists them all, and `skill:auto` lets a fast model pick one.

To add your own, drop a Markdown file in `skills/`:

```markdown
---
name: release-notes
description: Turn a list of changes into release notes for users.
category: writing
boost: refine
---
Write release notes for people who use the product...
```

`mode` sets the mode the skill uses by default (most are `single`; tool-driven ones are `agent`). `boost` sets the harness used when a caller asks for boost with it. `tools` limits which agent tools it may call. `tier` is `smart` or `fast`.

### Agent tools

| Tool | On by default | To turn on |
| --- | --- | --- |
| `wikipedia`, `fetch_url`, `calculator`, `current_time` | Yes | |
| `web_search` | No | Add a free Tavily key in the dashboard |
| `list_files`, `read_file`, `search_files` | No | Set `harness.agent.workspace` in `config.json`, or pass `--workspace <dir>` |
| `write_file` | No | Also set `allowWrite` |
| `run_code` | No | Set `allowCode` (macOS only) |

The defaults are deliberately cautious, because the models are third parties reading untrusted web pages:

- Web tools cannot reach your own computer or home network.
- File tools only see the workspace folder you name, and refuse `.env` files, keys and `.git`.
- `run_code` runs inside the macOS sandbox with no network, no access to your home folder, and a 20 second limit.
- These permissions can only be changed in `config.json` or on the command line, never through the web API.

If you give the agent both a workspace and web access, a malicious web page could in principle talk a model into reading a workspace file and sending its contents out in a URL. Do not point the workspace at anything you would not want leaked.

## How routing and quota work

- **Order.** Providers are tried in the order they appear in `providers.json`. Set `"strategy": "round-robin"` in `config.json` to rotate between them instead.
- **Models are discovered, not hardcoded.** Model names change monthly, so each provider's own model list is fetched and ranked with the `prefer` patterns in `providers.json`. Pin exact models by adding a `"models": [...]` list to a provider.
- **Limits are learned.** Published free-tier numbers disagree with each other and change often, so nothing depends on them. The real limits come from the rate-limit headers and 429 responses providers send. A provider that says it is out of quota is rested until the time it gave, or until its daily reset.
- **Best models first, then deeper.** For `auto`, every provider's two best models are tried before any provider's third.
- **Failures fall through.** Rate limits, server errors, timeouts, rejected keys, retired models, empty answers and requests too large for one model all move the request to the next candidate. A request that three providers reject as malformed stops there.
- **Short waits instead of errors.** If everything is resting but something is back within 15 seconds, the request waits for it.
- **Usage is saved** in `data/usage.json`, so counters survive a restart, and the server, the command line and the MCP server can run at once without overwriting each other's counts.

The full design, with diagrams, is in [docs/design.md](docs/design.md).

## Files

| File | What it is |
| --- | --- |
| `.env` | Your API keys. Created when you save a key. Never commit it. |
| `providers.json` | The provider catalog: URLs, key names, model preferences, free-tier notes. |
| `config.json` | Routing strategy, timeouts, harness settings, agent tool permissions. |
| `skills/` | One Markdown file per skill. |
| `data/` | Usage counters and cached model lists. Safe to delete. |
| `src/` | The program. `gateway.js` is the core; `router.js` does the fallback; `harness.js` holds the modes. |

Environment variables: `AIC_PORT` (default 4141), `AIC_ENV_FILE`, `AIC_DATA_DIR`, `AIC_CATALOG`, `AIC_CONFIG`, `AIC_SKILLS_DIR`.

## Fair use and privacy

- **One key per provider, from your own account.** AI Compiler adds up the free tiers of different providers. It does not rotate several accounts on one provider to multiply a quota, which breaks providers' terms.
- **Only refilling free tiers are included.** No provider here needs a payment method, so nothing can be charged. A few (Cerebras, Mistral) have tightened their free access during 2026; if a key from one of them has no free quota, it is simply skipped.
- **Free tiers often keep your prompts.** Google's free tier and some OpenRouter free models may use prompts for training. Do not send secrets or private data.
- **The server only listens on your computer.** It refuses requests from other websites open in your browser and from other hosts. Keys are stored in `.env` with owner-only permissions, are sent only to the provider they belong to, and are never returned by the API.

## Tests

```bash
npm test
```

66 tests run the router, harness, tools, sandbox, server and MCP server against simulated providers. What has not been tested is each real provider with a real key, because that needs your keys. The first request you send to each provider is that test; anything a provider does differently from the OpenAI-compatible standard will show up as an error on its card in the dashboard.
