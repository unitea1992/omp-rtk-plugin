import type { ExtensionAPI, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";

export type RtkAvailability =
  | { ok: true; version: string }
  | {
      ok: false;
      reason: "missing" | "too_old" | "invalid_version";
      version?: string;
      detail: string;
    };

export interface DisableState {
  rtkDisabled: boolean;
  ompRtkDisabled: boolean;
  disabled: boolean;
}

type RtkExecResult = {
  code?: number | null;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
};

const REWRITE_TIMEOUT_MS = 2_000;
const COMMAND_TIMEOUT_MS = 5_000;
const MIN_SUPPORTED_RTK: [number, number, number] = [0, 23, 0];
const CUSTOM_MESSAGE_TYPE = "omp-rtk-plugin.output";
const SAFE_GAIN_FLAGS = new Set([
  "--project",
  "-p",
  "--graph",
  "-g",
  "--history",
  "-H",
  "--daily",
  "-d",
  "--weekly",
  "-w",
  "--monthly",
  "-m",
  "--all",
  "-a",
  "--quota",
  "-q",
  "--failures",
  "-F",
]);
const GAIN_FORMAT_FLAGS = new Set(["--format", "-f"]);
const SAFE_GAIN_FORMATS = new Set(["text", "json", "csv"]);
const BLOCKED_GAIN_FLAGS = new Set(["--reset", "--yes", "-y"]);

export function parseRtkVersion(stdout: string): [number, number, number] | null {
  const match = stdout.trim().match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isSupportedRtkVersion(version: [number, number, number]): boolean {
  const [major, minor] = version;
  return major > MIN_SUPPORTED_RTK[0] || (major === MIN_SUPPORTED_RTK[0] && minor >= MIN_SUPPORTED_RTK[1]);
}

export function getDisableState(env: NodeJS.ProcessEnv = process.env): DisableState {
  const rtkDisabled = env.RTK_DISABLED === "1";
  const ompRtkDisabled = env.OMP_RTK_DISABLED === "1";
  return {
    rtkDisabled,
    ompRtkDisabled,
    disabled: rtkDisabled || ompRtkDisabled,
  };
}

export function sanitizeGainArgs(rawArgs: string): { ok: true; args: string[] } | { ok: false; error: string } {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  const args: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (BLOCKED_GAIN_FLAGS.has(token)) {
      return {
        ok: false,
        error: "/rtk-gain does not allow reset; run rtk gain --reset manually outside omp if needed.",
      };
    }

    if (GAIN_FORMAT_FLAGS.has(token)) {
      const format = tokens[++i];
      if (!format || !SAFE_GAIN_FORMATS.has(format)) {
        return { ok: false, error: "/rtk-gain --format only accepts text, json, or csv." };
      }
      args.push(token, format);
      continue;
    }

    if (!SAFE_GAIN_FLAGS.has(token)) {
      return { ok: false, error: `Unsupported /rtk-gain option: ${token}` };
    }
    args.push(token);
  }

  return { ok: true, args };
}

export function parseToggleArg(rawArgs: string): "on" | "off" | "toggle" | "status" | "invalid" {
  const arg = rawArgs.trim();
  if (arg === "") return "toggle";
  if (arg === "status") return "status";
  if (arg === "on" || arg === "off") return arg;
  return "invalid";
}

export function isBashToolCall(
  event: ToolCallEvent,
): event is ToolCallEvent & { toolName: "bash"; input: { command?: unknown } } {
  return event.toolName === "bash";
}

async function runRtk(pi: ExtensionAPI, args: string[], timeout: number, signal?: AbortSignal): Promise<RtkExecResult> {
  const options = signal ? { timeout, signal } : { timeout };
  return (await pi.exec("rtk", args, options)) as RtkExecResult;
}

async function checkRtkAvailability(pi: ExtensionAPI): Promise<RtkAvailability> {
  let result: RtkExecResult;
  try {
    result = await runRtk(pi, ["--version"], REWRITE_TIMEOUT_MS);
  } catch {
    return {
      ok: false,
      reason: "missing",
      detail: "rtk binary not found in PATH or not executable",
    };
  }

  if (result.code !== 0) {
    return {
      ok: false,
      reason: "missing",
      detail: "rtk binary not found in PATH or not executable",
    };
  }

  const rawVersion = (result.stdout ?? "").trim();
  const parsed = parseRtkVersion(rawVersion);
  if (!parsed) {
    return {
      ok: false,
      reason: "invalid_version",
      version: rawVersion,
      detail: "could not parse rtk --version output",
    };
  }

  const version = parsed.join(".");
  if (!isSupportedRtkVersion(parsed)) {
    return {
      ok: false,
      reason: "too_old",
      version,
      detail: "rtk rewrite requires rtk >= 0.23.0",
    };
  }

  return { ok: true, version };
}

function combineOutput(result: RtkExecResult, emptyMessage: string): string {
  const text = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n").trim();
  return text || emptyMessage;
}

function formatDisableState(state: DisableState): string {
  return [`RTK_DISABLED=1: ${state.rtkDisabled ? "yes" : "no"}`, `OMP_RTK_DISABLED=1: ${state.ompRtkDisabled ? "yes" : "no"}`].join(
    "\n",
  );
}

function formatAvailability(availability: RtkAvailability): string {
  if (availability.ok) return `RTK: ok (${availability.version})`;
  return `RTK: ${availability.reason}${availability.version ? ` (${availability.version})` : ""}\n${availability.detail}`;
}

function effectiveEnabled(localEnabled: boolean, availability: RtkAvailability, disableState: DisableState): boolean {
  return localEnabled && availability.ok && !disableState.disabled;
}

function notify(ctx: { ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void } }, message: string, type: "info" | "warning" | "error" = "info") {
  ctx.ui?.notify?.(message, type);
}

function showCommandOutput(
  pi: ExtensionAPI,
  ctx: { ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void } },
  title: string,
  body: string,
  type: "info" | "warning" | "error" = "info",
) {
  pi.sendMessage(
    {
      customType: CUSTOM_MESSAGE_TYPE,
      content: `${title}\n\n${body}`,
      display: true,
      attribution: "user",
    },
    { triggerTurn: false },
  );
  notify(ctx, title, type);
}

function formatStatus(localEnabled: boolean, availability: RtkAvailability): string {
  const disableState = getDisableState();
  return [
    `Local toggle: ${localEnabled ? "on" : "off"}`,
    `Effective rewrite: ${effectiveEnabled(localEnabled, availability, disableState) ? "enabled" : "disabled"}`,
    formatAvailability(availability),
    formatDisableState(disableState),
  ].join("\n");
}

async function runDoctor(pi: ExtensionAPI): Promise<string> {
  const lines: string[] = [];
  const availability = await checkRtkAvailability(pi);
  lines.push(formatAvailability(availability));
  lines.push(formatDisableState(getDisableState()));

  try {
    const gain = await runRtk(pi, ["gain"], COMMAND_TIMEOUT_MS);
    if (gain.code === 0 || (gain.stdout ?? "").trim() || (gain.stderr ?? "").trim()) {
      lines.push(`rtk gain: ok (exit ${gain.code ?? "unknown"})`);
    } else {
      lines.push("rtk gain: error — possible rtk name collision; verify this is rtk-ai/rtk, not another rtk package.");
    }
  } catch (error) {
    lines.push(
      `rtk gain: error — possible rtk name collision; verify this is rtk-ai/rtk, not another rtk package. ${String(error)}`,
    );
  }

  try {
    const rewrite = await runRtk(pi, ["rewrite", "git status"], COMMAND_TIMEOUT_MS);
    const rewritten = (rewrite.stdout ?? "").trim();
    if ((rewrite.code === 0 || rewrite.code === 3) && rewritten.includes("rtk git status")) {
      lines.push(`rtk rewrite "git status": ok (${rewritten})`);
    } else {
      lines.push(
        `rtk rewrite "git status": error (exit ${rewrite.code ?? "unknown"}) ${combineOutput(rewrite, "no output")}`,
      );
    }
  } catch (error) {
    lines.push(`rtk rewrite "git status": error ${String(error)}`);
  }

  try {
    const unsupported = await runRtk(pi, ["rewrite", "htop"], COMMAND_TIMEOUT_MS);
    const output = (unsupported.stdout ?? "").trim();
    if (unsupported.code === 1 && output === "") {
      lines.push('rtk rewrite "htop": ok passthrough');
    } else {
      lines.push(
        `rtk rewrite "htop": warning — registry behavior changed or htop is now supported (exit ${unsupported.code ?? "unknown"}) ${combineOutput(unsupported, "no output")}`,
      );
    }
  } catch (error) {
    lines.push(`rtk rewrite "htop": warning ${String(error)}`);
  }

  return lines.join("\n");
}

export default async function ompRtkPlugin(pi: ExtensionAPI): Promise<void> {
  let localEnabled = true;
  let availability: RtkAvailability = await checkRtkAvailability(pi);

  pi.on("tool_call", async (event, ctx) => {
    try {
      if (!isBashToolCall(event)) return;

      const cmd = event.input.command;
      if (typeof cmd !== "string" || cmd.trim() === "") return;
      if (!localEnabled) return;
      if (getDisableState().disabled) return;
      if (!availability.ok) return;
      if (cmd.trimStart().startsWith("rtk ") || cmd.trim() === "rtk") return;

      const result = await runRtk(pi, ["rewrite", cmd], REWRITE_TIMEOUT_MS);
      if (result.killed) return;
      if (result.code !== 0 && result.code !== 3) return;

      const rewritten = (result.stdout ?? "").trim();
      if (rewritten && rewritten !== cmd) {
        event.input.command = rewritten;
      }
    } catch (error) {
      pi.logger.warn("[omp-rtk-plugin] unexpected error in tool_call handler; passing through command", { error });
    }
  });

  pi.registerCommand("rtk-gain", {
    description: "Show RTK token savings",
    handler: async (args, ctx) => {
      const sanitized = sanitizeGainArgs(args);
      if (!sanitized.ok) {
        showCommandOutput(pi, ctx, "RTK gain", sanitized.error, "error");
        return;
      }

      try {
        const result = await runRtk(pi, ["gain", ...sanitized.args], COMMAND_TIMEOUT_MS);
        showCommandOutput(pi, ctx, "RTK gain", combineOutput(result, "rtk gain produced no output."), result.code === 0 ? "info" : "warning");
      } catch (error) {
        showCommandOutput(pi, ctx, "RTK gain", `Failed to run rtk gain: ${String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("rtk-status", {
    description: "Show RTK rewrite status",
    handler: async (_args, ctx) => {
      availability = await checkRtkAvailability(pi);
      showCommandOutput(pi, ctx, "RTK status", formatStatus(localEnabled, availability));
    },
  });

  pi.registerCommand("rtk-doctor", {
    description: "Run RTK plugin diagnostics",
    handler: async (_args, ctx) => {
      const report = await runDoctor(pi);
      showCommandOutput(pi, ctx, "RTK doctor", report);
    },
  });

  pi.registerCommand("rtk-toggle", {
    description: "Toggle RTK rewrite for this omp session",
    handler: async (args, ctx) => {
      const command = parseToggleArg(args);
      if (command === "invalid") {
        showCommandOutput(pi, ctx, "RTK toggle", "Usage: /rtk-toggle [on|off|status]", "error");
        return;
      }
      if (command === "on") localEnabled = true;
      else if (command === "off") localEnabled = false;
      else if (command === "toggle") localEnabled = !localEnabled;
      else if (command === "status") {
        showCommandOutput(pi, ctx, "RTK status", formatStatus(localEnabled, availability));
        return;
      }
      showCommandOutput(pi, ctx, "RTK toggle", `RTK rewrite: ${localEnabled ? "enabled" : "disabled"}`);
    },
  });
}
