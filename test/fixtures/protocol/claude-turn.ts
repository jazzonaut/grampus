// A Claude Agent SDK exchange for one conversation turn: the control responses Grampus asks for before
// a turn (`accountInfo`, `mcpServerStatus`) and the message stream of the turn itself (system init, a
// streamed reply, the assistant message with usage and the result with the structured reply).
//
// Constructed, not captured: a real init and result need inference. Every value is typed against the
// pinned SDK (`satisfies`), so an SDK upgrade that changes these shapes fails the build here, and the
// replay test (test/protocol-replay.test.ts) fails when Grampus' validation in claude-protocol.ts no
// longer accepts them. Re-derive it from the SDK's sdk.d.ts and a live probe when upgrading the SDK.
// `<session>` is replaced by the session id the adapter chose. No account identity is included.
import type { AccountInfo, McpServerStatus, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export const recordedWith = { sdk: '0.3.302', claudeCode: '2.1.302' } as const;

/** The session placeholder the replay substitutes. */
export const sessionPlaceholder = '<session>';

export const accountInfo = {
  subscriptionType: 'Claude Team',
  apiProvider: 'firstParty',
  apiKeySource: 'none',
} satisfies AccountInfo;

export const mcpStatus = [
  { name: 'docs', status: 'connected', serverInfo: { name: 'docs', version: '1.2.0' }, scope: 'user' },
  { name: 'grampus_repository', status: 'connected', scope: 'dynamic' },
] satisfies McpServerStatus[];

/** The structured reply the turn returns, as the provider's JSON output. */
export const reply = {
  kind: 'message',
  text: 'The parser already rejects empty input; no change is needed.',
  questions: [],
  findings: [],
  lenses: null,
};

const usage = {
  input_tokens: 1200,
  output_tokens: 96,
  output_tokens_details: { thinking_tokens: 0 },
  cache_creation_input_tokens: 300,
  cache_read_input_tokens: 4000,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 300 },
  server_tool_use: null,
  service_tier: 'standard',
  inference_geo: null,
  iterations: null,
  fallback_credit: null,
  speed: null,
} as const;

const text = JSON.stringify(reply);
const half = Math.floor(text.length / 2);

export const turn = [
  {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'none',
    claude_code_version: '2.1.302',
    cwd: 'C:\\work\\repo',
    tools: ['ToolSearch', 'mcp__grampus_repository__grampus_read_file'],
    mcp_servers: [
      { name: 'docs', status: 'connected', source: 'user' },
      { name: 'grampus_repository', status: 'connected', source: 'sdk' },
    ],
    model: 'claude-opus-5-5',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: '00000000-0000-4000-8000-000000000001',
    session_id: sessionPlaceholder,
  },
  {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, half) } },
    parent_tool_use_id: null,
    uuid: '00000000-0000-4000-8000-000000000002',
    session_id: sessionPlaceholder,
  },
  {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(half) } },
    parent_tool_use_id: null,
    uuid: '00000000-0000-4000-8000-000000000003',
    session_id: sessionPlaceholder,
  },
  {
    type: 'assistant',
    message: {
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text, citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      container: null,
      context_management: null,
      diagnostics: null,
      usage,
    },
    parent_tool_use_id: null,
    uuid: '00000000-0000-4000-8000-000000000004',
    session_id: sessionPlaceholder,
  },
  {
    type: 'result',
    subtype: 'success',
    duration_ms: 8200,
    duration_api_ms: 7900,
    is_error: false,
    num_turns: 1,
    result: text,
    stop_reason: 'end_turn',
    total_cost_usd: 0.0425,
    // The result's main-loop usage never carries nulls.
    usage: {
      ...usage,
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
      inference_geo: 'eu',
      iterations: [],
      speed: 'standard',
    },
    modelUsage: {
      'claude-opus-5-5': {
        inputTokens: 1200,
        outputTokens: 96,
        cacheReadInputTokens: 4000,
        cacheCreationInputTokens: 300,
        webSearchRequests: 0,
        costUSD: 0.0425,
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
      },
    },
    permission_denials: [],
    structured_output: reply,
    uuid: '00000000-0000-4000-8000-000000000005',
    session_id: sessionPlaceholder,
  },
] satisfies SDKMessage[];
