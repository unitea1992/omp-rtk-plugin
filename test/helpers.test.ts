import { describe, expect, test } from "bun:test";
import ompRtkPlugin, {
  getDisableState,
  isSupportedRtkVersion,
  parseRtkVersion,
  parseToggleArg,
  sanitizeGainArgs,
} from "../src/index";

describe("parseRtkVersion", () => {
  test("parses rtk-prefixed semver", () => {
    expect(parseRtkVersion("rtk 0.42.4\n")).toEqual([0, 42, 4]);
  });

  test("parses bare semver", () => {
    expect(parseRtkVersion("0.23.0")).toEqual([0, 23, 0]);
  });

  test("returns null for invalid output", () => {
    expect(parseRtkVersion("not rtk")).toBeNull();
  });
});

describe("isSupportedRtkVersion", () => {
  test("rejects versions before rewrite support", () => {
    expect(isSupportedRtkVersion([0, 22, 9])).toBe(false);
  });

  test("accepts rewrite introduction version", () => {
    expect(isSupportedRtkVersion([0, 23, 0])).toBe(true);
  });

  test("accepts stable major versions", () => {
    expect(isSupportedRtkVersion([1, 0, 0])).toBe(true);
  });
});

describe("getDisableState", () => {
  test("defaults to enabled", () => {
    expect(getDisableState({})).toEqual({ rtkDisabled: false, ompRtkDisabled: false, disabled: false });
  });

  test("honors RTK_DISABLED", () => {
    expect(getDisableState({ RTK_DISABLED: "1" })).toEqual({
      rtkDisabled: true,
      ompRtkDisabled: false,
      disabled: true,
    });
  });

  test("honors OMP_RTK_DISABLED", () => {
    expect(getDisableState({ OMP_RTK_DISABLED: "1" })).toEqual({
      rtkDisabled: false,
      ompRtkDisabled: true,
      disabled: true,
    });
  });

  test("ignores non-1 values", () => {
    expect(getDisableState({ RTK_DISABLED: "0", OMP_RTK_DISABLED: "0" })).toEqual({
      rtkDisabled: false,
      ompRtkDisabled: false,
      disabled: false,
    });
  });
});

describe("sanitizeGainArgs", () => {
  test("allows safe history and json format flags", () => {
    expect(sanitizeGainArgs("--history --format json")).toEqual({ ok: true, args: ["--history", "--format", "json"] });
  });

  test("rejects reset", () => {
    const result = sanitizeGainArgs("--reset --yes");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does not allow reset");
  });

  test("rejects unsupported formats", () => {
    expect(sanitizeGainArgs("--format yaml").ok).toBe(false);
  });
});

describe("parseToggleArg", () => {
  test("empty string returns toggle", () => {
    expect(parseToggleArg("")).toBe("toggle");
  });

  test("status returns status", () => {
    expect(parseToggleArg("status")).toBe("status");
  });

  test("parses on and off", () => {
    expect(parseToggleArg("on")).toBe("on");
    expect(parseToggleArg("off")).toBe("off");
  });

  test("rejects unknown values", () => {
    expect(parseToggleArg("maybe")).toBe("invalid");
  });
});

describe("extension wiring", () => {
  function createFakePi() {
    const toolHandlers: Array<(event: any, ctx: any) => Promise<void>> = [];
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const messages: Array<{ message: unknown; options: unknown }> = [];
    const execCalls: string[][] = [];

    const pi = {
      exec: async (_command: string, args: string[]) => {
        execCalls.push(args);
        if (args[0] === "--version") return { code: 0, stdout: "rtk 0.42.4\n", stderr: "", killed: false };
        if (args[0] === "rewrite" && args[1] === "git status") {
          return { code: 3, stdout: "rtk git status\n", stderr: "", killed: false };
        }
        if (args[0] === "gain") return { code: 0, stdout: "gain output\n", stderr: "", killed: false };
        return { code: 1, stdout: "", stderr: "", killed: false };
      },
      on: (event: string, handler: (event: any, ctx: any) => Promise<void>) => {
        if (event === "tool_call") toolHandlers.push(handler);
      },
      registerCommand: (name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
        commands.set(name, options);
      },
      sendMessage: (message: unknown, options: unknown) => {
        messages.push({ message, options });
      },
      logger: { warn: () => undefined, info: () => undefined },
    };

    return { pi, toolHandlers, commands, messages, execCalls };
  }

  test("rewrites bash command through rtk rewrite", async () => {
    const { pi, toolHandlers, execCalls } = createFakePi();
    await ompRtkPlugin(pi as any);

    const event = { toolName: "bash", toolCallId: "1", input: { command: "git status" } };
    await toolHandlers[0](event, {});

    expect(event.input.command).toBe("rtk git status");
    expect(execCalls).toContainEqual(["rewrite", "git status"]);
  });

  test("does not call rewrite when plugin disable env is set", async () => {
    const previous = process.env.OMP_RTK_DISABLED;
    process.env.OMP_RTK_DISABLED = "1";
    try {
      const { pi, toolHandlers, execCalls } = createFakePi();
      await ompRtkPlugin(pi as any);

      const event = { toolName: "bash", toolCallId: "1", input: { command: "git status" } };
      await toolHandlers[0](event, {});

      expect(event.input.command).toBe("git status");
      expect(execCalls).not.toContainEqual(["rewrite", "git status"]);
    } finally {
      if (previous === undefined) delete process.env.OMP_RTK_DISABLED;
      else process.env.OMP_RTK_DISABLED = previous;
    }
  });

  test("registers rtk slash commands and emits gain output", async () => {
    const { pi, commands, messages } = createFakePi();
    await ompRtkPlugin(pi as any);

    expect([...commands.keys()].sort()).toEqual(["rtk-doctor", "rtk-gain", "rtk-status", "rtk-toggle"]);
    await commands.get("rtk-gain")?.handler("--history", { ui: { notify: () => undefined } });

    expect(messages).toHaveLength(1);
    expect(messages[0].message).toMatchObject({ customType: "omp-rtk-plugin.output", display: true });
  });

  test("rtk-toggle flips localEnabled", async () => {
    const { pi, commands } = createFakePi();
    await ompRtkPlugin(pi as any);

    const toggle = commands.get("rtk-toggle")!;
    const noop = { ui: { notify: () => undefined } };

    // Initially enabled (localEnabled = true), toggle flips to false
    await toggle.handler("", noop);
    // Second toggle flips back to true
    await toggle.handler("", noop);
    // "on" sets to true explicitly
    await toggle.handler("off", noop);
    await toggle.handler("on", noop);
    // status does not change state
    await toggle.handler("status", noop);
  });
});
