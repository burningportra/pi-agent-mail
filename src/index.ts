/**
 * pi-agent-mail — Agent Mail coordination tools for every pi session.
 *
 * On session_start, bootstraps an agent identity via macro_start_session.
 * Registers tools for messaging, inbox, file reservations, and thread ops.
 * Injects urgent unread messages into before_agent_start.
 * Releases file reservations on session_shutdown.
 *
 * Requires: Agent Mail server running at http://127.0.0.1:8765
 *   Start with: am
 *
 * Install globally:
 *   Add "/path/to/pi-agent-mail" to packages in ~/.pi/agent/settings.json
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const AM_URL = "http://127.0.0.1:8765/api";

// ─── State ───────────────────────────────────────────────────

let agentName = "";
let projectKey = "";
let currentModel = "auto";
let bootstrapped = false;
let urgentMessages: string[] = [];

// ─── RPC helper ──────────────────────────────────────────────

interface RpcResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function amRpc(
  toolName: string,
  args: Record<string, unknown>
): Promise<RpcResult> {
  const res = await fetch(AM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { result?: RpcResult; error?: { message: string } };
  if (data.error) throw new Error(data.error.message);
  return data.result!;
}

function rpcText(result: RpcResult): string {
  return result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

async function isServerUp(): Promise<boolean> {
  try {
    // /health returns 404 on some versions — probe via JSON-RPC instead
    const res = await fetch(AM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "health_check", arguments: {} } }),
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Extension ───────────────────────────────────────────────

export default function piAgentMailExtension(pi: ExtensionAPI) {

  // Track current model for macro_start_session
  pi.on("model_select", async (event) => {
    currentModel = (event as unknown as { modelId?: string }).modelId ?? currentModel;
  });

  // ── Session bootstrap ─────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    projectKey = ctx.cwd;
    bootstrapped = false;
    agentName = "";
    urgentMessages = [];

    if (!(await isServerUp())) {
      if (ctx.hasUI) ctx.ui.notify("pi-agent-mail: server not running — start with `am`", "warning");
      return;
    }

    try {
      const result = await amRpc("macro_start_session", {
        human_key: projectKey,
        program: "pi",
        model: currentModel,
        task_description: "",
        inbox_limit: 5,
      });

      const sc = result.structuredContent as {
        agent?: { name?: string };
        inbox?: Array<{ importance?: string; subject?: string; id?: number }>;
      } | undefined;

      agentName = sc?.agent?.name ?? "";
      bootstrapped = !!agentName;

      // Collect urgent unread messages for before_agent_start injection
      if (sc?.inbox) {
        urgentMessages = sc.inbox
          .filter((m) => m.importance === "urgent")
          .map((m) => `• [#${m.id}] ${m.subject}`);
      }

      process.stderr.write(
        `[pi-agent-mail] ${agentName || "anonymous"} @ ${projectKey}\n`
      );
    } catch (e) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `pi-agent-mail: bootstrap failed — ${e instanceof Error ? e.message : String(e)}`,
          "warning"
        );
      }
    }
  });

  // ── Urgent mail → system prompt ───────────────────────────
  pi.on("before_agent_start", async (event) => {
    if (urgentMessages.length === 0) return undefined;
    const block = urgentMessages.join("\n");
    urgentMessages = []; // only inject once per wave
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n---\n\n## ⚠️ Urgent Agent Mail\n\nYou have urgent unread messages. Check your inbox with \`am_inbox\`:\n\n${block}\n`,
    };
  });

  // ── Cleanup on exit ───────────────────────────────────────
  pi.on("session_shutdown", async () => {
    if (!bootstrapped) return;
    try {
      await amRpc("release_file_reservations", {
        project_key: projectKey,
        agent_name: agentName,
      });
    } catch {
      // best-effort
    }
  });

  // ─── Tools ─────────────────────────────────────────────────

  function requireBootstrap(): string | null {
    if (!bootstrapped) return "Agent Mail not bootstrapped. Is the server running? (`am`)";
    return null;
  }

  // ── am_inbox ─────────────────────────────────────────────
  pi.registerTool({
    name: "am_inbox",
    label: "Agent Mail Inbox",
    description:
      "Fetch your Agent Mail inbox. Shows recent messages from other agents or the human overseer.",
    promptSnippet: "Fetch Agent Mail inbox",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Max messages to return (default 20)" })),
      urgent_only: Type.Optional(Type.Boolean({ description: "Only show urgent messages" })),
      include_bodies: Type.Optional(Type.Boolean({ description: "Include full message bodies" })),
    }),
    async execute(_id, params) {
      const err = requireBootstrap();
      if (err) return { content: [{ type: "text", text: err }], details: {} };
      const result = await amRpc("fetch_inbox", {
        project_key: projectKey,
        agent_name: agentName,
        limit: params.limit ?? 20,
        urgent_only: params.urgent_only ?? false,
        include_bodies: params.include_bodies ?? false,
      });
      return { content: [{ type: "text", text: rpcText(result) }], details: {} };
    },
  });

  // ── am_send ──────────────────────────────────────────────
  pi.registerTool({
    name: "am_send",
    label: "Agent Mail Send",
    description:
      'Send a message to one or more agents. Use to: "all" to broadcast. Use thread_id to group messages (e.g. bead ID).',
    promptSnippet: "Send a message to agents via Agent Mail",
    parameters: Type.Object({
      to: Type.Array(Type.String(), {
        description: 'Recipient agent names, or ["all"] to broadcast',
      }),
      subject: Type.String({ description: "Message subject" }),
      body: Type.String({ description: "Message body (markdown)" }),
      thread_id: Type.Optional(Type.String({ description: "Thread ID to group messages (e.g. bead ID)" })),
      importance: Type.Optional(Type.String({ description: '"normal" or "urgent"' })),
      ack_required: Type.Optional(Type.Boolean({ description: "Require acknowledgment" })),
    }),
    async execute(_id, params) {
      const err = requireBootstrap();
      if (err) return { content: [{ type: "text", text: err }], details: {} };
      const result = await amRpc("send_message", {
        project_key: projectKey,
        sender_name: agentName,
        to: params.to,
        subject: params.subject,
        body_md: params.body,
        thread_id: params.thread_id ?? null,
        importance: params.importance ?? "normal",
        ack_required: params.ack_required ?? false,
      });
      return { content: [{ type: "text", text: rpcText(result) }], details: {} };
    },
  });

  // ── am_reply ─────────────────────────────────────────────
  pi.registerTool({
    name: "am_reply",
    label: "Agent Mail Reply",
    description: "Reply to a message by its ID. Stays in the same thread.",
    promptSnippet: "Reply to an Agent Mail message",
    parameters: Type.Object({
      message_id: Type.Number({ description: "ID of the message to reply to" }),
      body: Type.String({ description: "Reply body (markdown)" }),
    }),
    async execute(_id, params) {
      const err = requireBootstrap();
      if (err) return { content: [{ type: "text", text: err }], details: {} };
      const result = await amRpc("reply_message", {
        project_key: projectKey,
        message_id: params.message_id,
        sender_name: agentName,
        body_md: params.body,
      });
      return { content: [{ type: "text", text: rpcText(result) }], details: {} };
    },
  });

  // ── am_ack ───────────────────────────────────────────────
  pi.registerTool({
    name: "am_ack",
    label: "Agent Mail Acknowledge",
    description: "Acknowledge a message that required acknowledgment.",
    promptSnippet: "Acknowledge an Agent Mail message",
    parameters: Type.Object({
      message_id: Type.Number({ description: "ID of the message to acknowledge" }),
    }),
    async execute(_id, params) {
      const err = requireBootstrap();
      if (err) return { content: [{ type: "text", text: err }], details: {} };
      const result = await amRpc("acknowledge_message", {
        project_key: projectKey,
        agent_name: agentName,
        message_id: params.message_id,
      });
      return { content: [{ type: "text", text: rpcText(result) }], details: {} };
    },
  });

  // ── am_search ────────────────────────────────────────────
  pi.registerTool({
    name: "am_search",
    label: "Agent Mail Search",
    description: "Full-text search across all Agent Mail messages in this project.",
    promptSnippet: "Search Agent Mail messages",
    parameters: Type.Object({
      query: Type.String({ description: "Search query (FTS5 syntax supported)" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
    }),
    async execute(_id, params) {
      const err = requireBootstrap();
      if (err) return { content: [{ type: "text", text: err }], details: {} };
      const result = await amRpc("search_messages", {
        project_key: projectKey,
        query: params.query,
        limit: params.limit ?? 20,
      });
      return { content: [{ type: "text", text: rpcText(result) }], details: {} };
    },
  });

  // ── am_reserve ───────────────────────────────────────────
  pi.registerTool({
    name: "am_reserve",
    label: "Agent Mail Reserve Files",
    description:
      "Reserve files before editing to prevent conflicts with other agents. Use glob patterns. Call am_release when done.",
    promptSnippet: "Reserve files via Agent Mail before editing",
    parameters: Type.Object({
      paths: Type.Array(Type.String(), {
        description: 'File paths or globs to reserve, e.g. ["src/auth/**/*.ts"]',
      }),
      reason: Type.Optional(Type.String({ description: "Reason / bead ID (e.g. bd-42)" })),
      ttl_seconds: Type.Optional(Type.Number({ description: "Reservation TTL in seconds (default 3600)" })),
    }),
    async execute(_id, params) {
      const err = requireBootstrap();
      if (err) return { content: [{ type: "text", text: err }], details: {} };
      const result = await amRpc("file_reservation_paths", {
        project_key: projectKey,
        agent_name: agentName,
        paths: params.paths,
        ttl_seconds: params.ttl_seconds ?? 3600,
        exclusive: true,
        reason: params.reason ?? "",
      });
      return { content: [{ type: "text", text: rpcText(result) }], details: {} };
    },
  });

  // ── am_release ───────────────────────────────────────────
  pi.registerTool({
    name: "am_release",
    label: "Agent Mail Release Files",
    description:
      "Release file reservations when done editing. Omit paths to release all your reservations.",
    promptSnippet: "Release Agent Mail file reservations",
    parameters: Type.Object({
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description: "Specific paths to release. Omit to release all.",
        })
      ),
    }),
    async execute(_id, params) {
      const err = requireBootstrap();
      if (err) return { content: [{ type: "text", text: err }], details: {} };
      const result = await amRpc("release_file_reservations", {
        project_key: projectKey,
        agent_name: agentName,
        paths: params.paths ?? null,
      });
      return { content: [{ type: "text", text: rpcText(result) }], details: {} };
    },
  });

  // ── am_whoami ────────────────────────────────────────────
  pi.registerTool({
    name: "am_whoami",
    label: "Agent Mail Identity",
    description: "Show your current Agent Mail identity (agent name and project key).",
    promptSnippet: "Show your Agent Mail identity",
    parameters: Type.Object({}),
    async execute() {
      if (!bootstrapped) {
        return { content: [{ type: "text", text: "Not bootstrapped. Agent Mail server may be down." }], details: {} };
      }
      return {
        content: [{ type: "text", text: `Agent: ${agentName}\nProject: ${projectKey}\nModel: ${currentModel}` }],
        details: {},
      };
    },
  });

  // ── am_prepare_thread ────────────────────────────────────
  pi.registerTool({
    name: "am_prepare_thread",
    label: "Agent Mail Prepare Thread",
    description:
      "Join an existing thread and get a summary of its history. Useful when picking up work started by another agent.",
    promptSnippet: "Join and summarize an Agent Mail thread",
    parameters: Type.Object({
      thread_id: Type.String({ description: "Thread ID to join (e.g. bead ID)" }),
      task_description: Type.Optional(Type.String({ description: "What you plan to do in this thread" })),
    }),
    async execute(_id, params) {
      const err = requireBootstrap();
      if (err) return { content: [{ type: "text", text: err }], details: {} };
      const result = await amRpc("macro_prepare_thread", {
        project_key: projectKey,
        thread_id: params.thread_id,
        program: "pi",
        model: currentModel,
        agent_name: agentName,
        task_description: params.task_description ?? "",
        inbox_limit: 10,
      });
      return { content: [{ type: "text", text: rpcText(result) }], details: {} };
    },
  });
}
