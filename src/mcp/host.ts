// The AI connection at run time: runs the MCP server (src-tauri/src/mcp.rs) or not as the setting says, answers
// what AI apps send with the tools (read.ts, write.ts, trade.ts), refuses what the settings don't allow, and
// keeps the last calls for the settings window.

import { mcpNewToken, mcpReply, mcpStart, mcpStatus, mcpStop, onMcpCall, type McpCall, type McpStatus } from "../core/api.ts";
import type { Setting } from "../core/setting.ts";
import { allowed, ArgError, fail, type Level, type McpSettings, type ToolResult } from "./model.ts";
import { readTools } from "./read.ts";
import type { McpApp, Tool } from "./tools.ts";
import { tradeTools } from "./trade.ts";
import { writeTools } from "./write.ts";

/** One call, as the settings window lists it. */
export type CallEntry = { time: number; client: string; tool: string; level: Level; ok: boolean; text: string };

const MAX_LOG = 30;

const OFF: Record<Exclude<Level, "read">, string> = {
  write: "Changing the charts is off for AI apps: the user can allow it in QT Chart, 設定 → AI 連線.",
  trade: "Placing orders is off for AI apps: the user can allow it in QT Chart, 設定 → AI 連線.",
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export class McpHost {
  /** The server as last asked (null: not asked yet). */
  status: McpStatus | null = null;
  private readonly tools: Tool[];
  private readonly log: CallEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly setting: Setting<McpSettings>;
  private applying = Promise.resolve();

  constructor(app: McpApp, setting: Setting<McpSettings>) {
    this.setting = setting;
    this.tools = [...readTools(app), ...writeTools(app), ...tradeTools(app)];
  }

  async start() {
    await onMcpCall((c) => void this.answer(c));
    this.setting.watch(() => this.apply());
    await this.apply();
  }

  /** The tools, as tools/list describes them (every tool, also the ones the settings refuse: an app that lists
   *  them once still finds them after the user allows more). */
  list() {
    return this.tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.input, ...(t.annotations ? { annotations: { title: t.title, ...t.annotations } } : {}) }));
  }

  calls(): readonly CallEntry[] {
    return this.log;
  }

  /** A new token: apps set up with the old one have to be given this one. */
  async newToken() {
    this.status = await mcpNewToken();
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Run the server or not, on the port set (one change at a time, in order). */
  private apply(): Promise<void> {
    this.applying = this.applying.then(async () => {
      const s = this.setting.get();
      try {
        const st = await mcpStatus();
        if (!s.on) this.status = st.running ? await mcpStop() : st;
        else if (!st.running || st.port !== s.port) this.status = await mcpStart(s.port);
        else this.status = st;
      } catch (e) {
        this.status = { running: false, port: s.port, token: this.status?.token ?? "", error: String(e), config: this.status?.config ?? "", exe: this.status?.exe ?? "" };
      }
      this.emit();
    });
    return this.applying;
  }

  private async answer(c: McpCall) {
    let result: unknown = null;
    let error: string | null = null;
    try {
      if (c.method === "tools/list") result = { tools: this.list() };
      else if (c.method === "tools/call") result = await this.call(c);
      else error = `Method not found: ${c.method}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    await mcpReply(c.id, result, error).catch(() => undefined); // the app gave up on it already
  }

  private async call(c: McpCall): Promise<ToolResult> {
    const p = isObj(c.params) ? c.params : {};
    const name = typeof p.name === "string" ? p.name : "";
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const args = isObj(p.arguments) ? p.arguments : {};
    let r: ToolResult;
    if (tool.level !== "read" && !allowed(tool.level, this.setting.get())) r = fail(OFF[tool.level]);
    else {
      try {
        r = await tool.run(args, { client: c.client });
      } catch (e) {
        r = fail(e instanceof ArgError ? e.message : `QT Chart couldn't do it: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const { log, ...sent } = r;
    const first = r.content.find((x) => x.type === "text");
    this.log.unshift({
      time: Date.now() / 1000,
      client: c.client,
      tool: name,
      level: tool.level,
      ok: !r.isError,
      text: log ?? (r.isError && first?.type === "text" ? first.text.slice(0, 300) : ""),
    });
    if (this.log.length > MAX_LOG) this.log.pop();
    this.emit();
    return sent;
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}
