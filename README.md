# apimaster CLI

Test any OpenAI-compatible LLM endpoint from the terminal.

```bash
npx @apimaster/cli check
```

No dependencies, no build step, Node 18.17+. Works against [APIMaster](https://apimaster.ai/docs)
by default and against any other OpenAI-compatible gateway with `--base-url`.

![what it does](#) <!-- replace with an asciinema cast before publishing -->

## Why

Debugging an OpenAI-compatible gateway usually means pasting curl commands and guessing.
The same handful of problems come up every time:

- the key is fine but the base URL has (or is missing) `/v1`
- the model id in your config does not exist on that endpoint any more
- the endpoint is up but slow, and you have no baseline to compare against
- a model id answers, but nothing proves it is the model it claims to be
- a proxy or VPN is silently eating the connection

This CLI checks all of that in one command, and prints machine-readable JSON when you
need it in CI.

## Install

```bash
npm install -g @apimaster/cli
# or run it without installing
npx @apimaster/cli check
```

## Quick start

```bash
export APIMASTER_API_KEY=sk-...        # or: apimaster login --key sk-...
apimaster check
```

```
APIMaster key check
  OpenAI base:       https://apimaster.ai/v1
  Anthropic base:    https://apimaster.ai
  Key:               sk-abc…9f2e (51 chars) from env:APIMASTER_API_KEY

  ✔ GET /models         944 ms  61 models
  ✔ POST /chat/completions 1950 ms  glm-5.3-flash → "ok"
  ✔ POST /v1/messages     2982 ms  Anthropic protocol reachable

  Key works. Try: apimaster models | apimaster ping glm-5.3-flash
```

## Commands

### `check` — does this key actually work

Runs three probes: the model list, a minimal chat completion, and the Anthropic
Messages endpoint (which uses a *different* base URL — the root, without `/v1`).

```bash
apimaster check
apimaster check --skip-chat        # reachability + auth only, spends nothing
apimaster check --json             # for CI
```

Exit codes: `0` ok · `2` auth failure · `3` insufficient balance · `4` unreachable.

### `models` — what is actually served right now

Aggregator catalogs change weekly. Never hardcode an id you have not listed.

```bash
apimaster models                   # full table, grouped by family
apimaster models claude            # regex filter
apimaster models --kind image      # chat | image | video | embedding | audio
apimaster models --ids | fzf       # pipe-friendly
```

### `ping` — one request, timed

```bash
apimaster ping gpt-5.5
apimaster ping claude-sonnet-4-6 --stream    # reports time-to-first-token
```

### `bench` — compare models on the same endpoint

```bash
apimaster bench gpt-5.5 claude-sonnet-4-6 glm-5.3-flash --runs 5
apimaster bench gpt-5.5 --markdown           # paste-ready table for an issue or PR
```

```
| Model | TTFT p50 | TTFT p95 | Total p50 | chunks/s |
| --- | ---: | ---: | ---: | ---: |
| `gpt-5.5` | failed | | | HTTP 502: upstream stream ended abnormally … |
| `glm-5.3-flash` | 4698 ms | 4698 ms | 4698 ms | — |
```

That is a real run (2026-09-22, `--runs 1 --markdown`), kept because it shows two things
you will meet in practice: a transient upstream 502 is reported per model instead of
aborting the whole benchmark, and a model that returns its whole answer in one chunk has
no meaningful chunk rate, so the column shows `—` rather than a misleading number.

Throughput is counted in stream chunks rather than tokens, so treat it as a relative
number. It needs no tokenizer and stays honest across model families.

### `verify` — does this model behave like what it claims to be

```bash
apimaster verify gpt-5.5 --samples 5
```

Four probes, reported as signals rather than a verdict you should trust blindly:

| probe | what it catches |
| --- | --- |
| `echo` | the response reports a different model id than you requested |
| `determinism` | the same prompt at `temperature: 0` returning divergent completions — the signature of a rotating pool of different backends |
| `capability` | tool calling / JSON schema / logprobs missing, which a cheaper stand-in usually cannot fake |
| `self-report` | what the model says it is (weakest signal; models get this wrong constantly) |

**This is a heuristic and the tool says so.** No client-side probe can prove authenticity.
What it reliably does is catch the common failure modes before they reach production.

### `image` / `video` — generate and save

```bash
apimaster image "a corgi astronaut on the moon" --size 16:9 --resolution 2k
apimaster image "swap the background for a desert sunset" --ref https://…/photo.png
apimaster image "…" --resolution 4k --async      # long jobs: submit + poll

apimaster video "a waterfall forming a rainbow, cinematic" --duration 4
apimaster video "slow push-in, hair moving in the breeze" --ref https://…/face.jpg --aspect 9:16
```

Both commands download the result into `./out` and print the elapsed time. For
image-to-video, always pass `--aspect` explicitly: a portrait reference with no aspect
flag is treated as 16:9 by the gateway.

### `use` — configure your tools

```bash
apimaster use                      # list supported tools
apimaster use claude-code --write  # writes ~/.claude/settings.json, backing up the old one
apimaster use codex
apimaster use open-webui
```

Supported: Claude Code, Codex CLI, OpenCode, Gemini CLI, Cline, Roo Code, Continue,
Open WebUI, LiteLLM, Aider, Cherry Studio, Chatbox, SillyTavern, plus copy-paste
snippets for the OpenAI Python/Node SDKs and LangChain.

### `doctor` — find the misconfiguration

```bash
apimaster doctor
```

Checks Node version, key hygiene (quotes and whitespace inside keys break more setups
than anything else), conflicting environment variables, `ANTHROPIC_BASE_URL` ending in
`/v1`, Claude Code and Codex config files, proxy variables, `.env` not being gitignored,
clock skew, and endpoint reachability — then tells you what to change.

## Use it in CI

```yaml
- run: npx @apimaster/cli check --json > health.json
  env:
    APIMASTER_API_KEY: ${{ secrets.APIMASTER_API_KEY }}
```

Or use the ready-made action: [`apimaster-ai/api-health-action`](https://github.com/apimaster-ai/api-health-action).

## Configuration

Resolution order, highest first:

1. `--key` / `--base-url` flags
2. `APIMASTER_API_KEY`, then `OPENAI_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`
3. a `.env` file in the working directory
4. `~/.apimaster/config.json` (written by `apimaster login`, mode `600`)

`check` always tells you which source the key came from, because "it works in one shell
but not the other" is almost always two different keys.

### Pointing at another provider

```bash
apimaster --base-url https://api.openai.com/v1 --key $OPENAI_API_KEY models
apimaster --base-url http://localhost:11434/v1 --key ollama models
```

## Development

```bash
npm test          # node:test, no dependencies
node bin/apimaster.js --help
```

## Related

- [`api-health-action`](https://github.com/apimaster-ai/api-health-action) — scheduled availability, latency and model-identity checks as a GitHub Action
- [`ComfyUI-APIMaster`](https://github.com/apimaster-ai/ComfyUI-APIMaster) — image and video nodes for ComfyUI
- [APIMaster docs](https://apimaster.ai/docs) — endpoint reference

## License

MIT
