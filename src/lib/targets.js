import os from 'node:os';
import path from 'node:path';

const home = os.homedir();

/**
 * One entry per tool we can configure.
 *
 * kind:
 *   file — we can write the config ourselves (`--write`)
 *   env  — the tool reads environment variables
 *   ui   — the tool is configured in its own settings screen; we print what to type
 */
export const TARGETS = {
  'claude-code': {
    name: 'Claude Code',
    kind: 'file',
    format: 'json-merge',
    file: () => path.join(home, '.claude', 'settings.json'),
    docs: 'https://apimaster.ai/docs/cli/claude-code',
    note: 'The Anthropic-compatible base URL is the site root — it must NOT end with /v1.',
    render: (cfg) => ({
      env: {
        ANTHROPIC_BASE_URL: cfg.anthropicBaseUrl,
        ANTHROPIC_AUTH_TOKEN: cfg.key,
      },
    }),
    verify: 'claude   # then: /model claude-sonnet-4-6',
  },

  codex: {
    name: 'Codex CLI',
    kind: 'file',
    format: 'toml',
    file: () => path.join(home, '.codex', 'config.toml'),
    docs: 'https://apimaster.ai/docs/cli/codex',
    render: (cfg) => `model_provider = "apimaster"
model = "gpt-5.5"

[model_providers.apimaster]
name = "APIMaster"
base_url = "${cfg.baseUrl}"
env_key = "APIMASTER_API_KEY"
wire_api = "chat"
`,
    verify: 'codex "print hello"',
  },

  opencode: {
    name: 'OpenCode',
    kind: 'file',
    format: 'json-merge',
    file: () => path.join(home, '.config', 'opencode', 'opencode.json'),
    docs: 'https://apimaster.ai/docs/agents/opencode',
    render: (cfg) => ({
      $schema: 'https://opencode.ai/config.json',
      provider: {
        apimaster: {
          npm: '@ai-sdk/openai-compatible',
          name: 'APIMaster',
          options: { baseURL: cfg.baseUrl, apiKey: '{env:APIMASTER_API_KEY}' },
          models: {
            'gpt-5.5': { name: 'GPT-5.5' },
            'claude-sonnet-4-6': { name: 'Claude Sonnet 4.6' },
          },
        },
      },
    }),
    verify: 'opencode run "say hi"',
  },

  'gemini-cli': {
    name: 'Gemini CLI',
    kind: 'env',
    docs: 'https://apimaster.ai/docs/cli/gemini',
    render: (cfg) => ({
      GOOGLE_GEMINI_BASE_URL: cfg.baseUrl,
      GEMINI_API_KEY: cfg.key,
    }),
  },

  cline: {
    name: 'Cline (VS Code)',
    kind: 'ui',
    docs: 'https://apimaster.ai/docs/agents/cline',
    steps: (cfg) => [
      'Open the Cline panel → settings gear → API Provider',
      'Choose "OpenAI Compatible"',
      `Base URL: ${cfg.baseUrl}`,
      'API Key: your APIMaster key',
      'Model ID: any id from `apimaster models` (for example gpt-5.5)',
      'Tick "supports images" only for a vision-capable model id',
    ],
  },

  roo: {
    name: 'Roo Code (VS Code)',
    kind: 'ui',
    docs: 'https://apimaster.ai/docs/agents/cline',
    steps: (cfg) => [
      'Roo Code panel → Settings → Providers → OpenAI Compatible',
      `Base URL: ${cfg.baseUrl}`,
      'API Key: your APIMaster key',
      'Model: pick from `apimaster models --ids`',
    ],
  },

  continue: {
    name: 'Continue.dev',
    kind: 'file',
    format: 'yaml',
    file: () => path.join(home, '.continue', 'config.yaml'),
    docs: 'https://docs.continue.dev/customize/model-providers/openai',
    render: (cfg) => `name: apimaster
version: 0.0.1
schema: v1
models:
  - name: GPT-5.5 (APIMaster)
    provider: openai
    model: gpt-5.5
    apiBase: ${cfg.baseUrl}
    apiKey: \${{ secrets.APIMASTER_API_KEY }}
    roles: [chat, edit, apply]
  - name: Claude Sonnet 4.6 (APIMaster)
    provider: openai
    model: claude-sonnet-4-6
    apiBase: ${cfg.baseUrl}
    apiKey: \${{ secrets.APIMASTER_API_KEY }}
    roles: [chat, edit, apply]
`,
  },

  'open-webui': {
    name: 'Open WebUI',
    kind: 'env',
    docs: 'https://apimaster.ai/docs/platforms/openwebui',
    note: 'Or add it at runtime: Settings → Connections → OpenAI API.',
    render: (cfg) => ({
      OPENAI_API_BASE_URL: cfg.baseUrl,
      OPENAI_API_KEY: cfg.key,
    }),
  },

  litellm: {
    name: 'LiteLLM proxy',
    kind: 'file',
    format: 'yaml',
    file: () => path.join(process.cwd(), 'litellm.config.yaml'),
    docs: 'https://apimaster.ai/docs/platforms/litellm',
    render: (cfg) => `model_list:
  - model_name: gpt-5.5
    litellm_params:
      model: openai/gpt-5.5
      api_base: ${cfg.baseUrl}
      api_key: os.environ/APIMASTER_API_KEY
  - model_name: claude-sonnet-4-6
    litellm_params:
      model: openai/claude-sonnet-4-6
      api_base: ${cfg.baseUrl}
      api_key: os.environ/APIMASTER_API_KEY
`,
    verify: 'litellm --config litellm.config.yaml',
  },

  aider: {
    name: 'Aider',
    kind: 'env',
    docs: 'https://aider.chat/docs/llms/openai-compat.html',
    render: (cfg) => ({
      OPENAI_API_BASE: cfg.baseUrl,
      OPENAI_API_KEY: cfg.key,
    }),
    verify: 'aider --model openai/gpt-5.5',
  },

  'openai-python': {
    name: 'OpenAI Python SDK',
    kind: 'snippet',
    docs: 'https://apimaster.ai/docs/guides/openai-compatible-api',
    render: (cfg) => `from openai import OpenAI

client = OpenAI(
    base_url="${cfg.baseUrl}",
    api_key=os.environ["APIMASTER_API_KEY"],
)

resp = client.chat.completions.create(
    model="gpt-5.5",
    messages=[{"role": "user", "content": "hello"}],
)
print(resp.choices[0].message.content)
`,
  },

  'openai-node': {
    name: 'OpenAI Node SDK',
    kind: 'snippet',
    docs: 'https://apimaster.ai/docs/guides/openai-compatible-api',
    render: (cfg) => `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${cfg.baseUrl}",
  apiKey: process.env.APIMASTER_API_KEY,
});

const res = await client.chat.completions.create({
  model: "gpt-5.5",
  messages: [{ role: "user", content: "hello" }],
});
console.log(res.choices[0].message.content);
`,
  },

  langchain: {
    name: 'LangChain (Python)',
    kind: 'snippet',
    docs: 'https://apimaster.ai/docs/platforms/langchain',
    render: (cfg) => `from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="gpt-5.5",
    base_url="${cfg.baseUrl}",
    api_key=os.environ["APIMASTER_API_KEY"],
)
print(llm.invoke("hello").content)
`,
  },

  'cherry-studio': {
    name: 'Cherry Studio',
    kind: 'ui',
    steps: (cfg) => [
      'Settings → Model Providers → Add Provider → OpenAI type',
      `API Host: ${cfg.baseUrl}`,
      'API Key: your APIMaster key',
      'Click "Manage" to pull the model list',
    ],
  },

  chatbox: {
    name: 'Chatbox',
    kind: 'ui',
    steps: (cfg) => [
      'Settings → Model Provider → Add Custom Provider (OpenAI API compatible)',
      `API Host: ${cfg.baseUrl}`,
      'API Key: your APIMaster key',
    ],
  },

  sillytavern: {
    name: 'SillyTavern',
    kind: 'ui',
    steps: (cfg) => [
      'API → Chat Completion → Custom (OpenAI-compatible)',
      `Custom Endpoint: ${cfg.baseUrl}`,
      'Custom API Key: your APIMaster key',
      'Click Connect, then pick a model from the dropdown',
    ],
  },
};

export function listTargets() {
  return Object.entries(TARGETS).map(([id, t]) => ({ id, name: t.name, kind: t.kind }));
}
