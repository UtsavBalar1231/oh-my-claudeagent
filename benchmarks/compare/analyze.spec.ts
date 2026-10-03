import { describe, expect, test } from "bun:test";
import {
  blockedBy,
  breakdown,
  diffSnapshots,
  dnsName,
  humanBytes,
  median,
  pairedDiffs,
  parseConnectTrace,
  parseExecveTrace,
  parseSnapshot,
  stats,
  tokens,
  totalChars,
  unescapeStrace,
} from "./analyze.ts";

describe("tokens", () => {
  test("rounds characters over four up", () => {
    expect([0, 1, 4, 5, 8, 9].map(tokens)).toEqual([0, 1, 1, 2, 2, 3]);
  });
});

describe("stats", () => {
  test("has no answer for an empty sample", () => {
    expect(stats([])).toBeNull();
    expect(median([])).toBeNull();
  });

  test("interpolates quartiles and takes the nearest rank for p95", () => {
    expect(stats([5, 1, 3, 2, 4])).toEqual({ n: 5, median: 3, p25: 2, p75: 4, p95: 5, min: 1, max: 5 });
  });

  test("reports the 19th of 20 runs as p95", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(stats(twenty)).toEqual({ n: 20, median: 10.5, p25: 5.75, p75: 15.25, p95: 19, min: 1, max: 20 });
  });

  test("leaves the caller's array unsorted", () => {
    const xs = [3, 1, 2];
    expect(median(xs)).toBe(2);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe("pairedDiffs", () => {
  test("pairs by position and skips a pair with a missing side", () => {
    expect(pairedDiffs([5, null, 9, 4], [3, 1, null, 4])).toEqual([2, 0]);
  });

  test("ignores arm entries that have no baseline counterpart", () => {
    expect(pairedDiffs([5, 6], [1])).toEqual([4]);
  });
});

describe("unescapeStrace", () => {
  test("decodes named, octal, hex and backslash escapes", () => {
    expect(unescapeStrace("a\\n\\101\\x42\\\\\\0")).toEqual([97, 10, 65, 66, 92, 0]);
  });
});

describe("dnsName", () => {
  const header = Array.from({ length: 12 }, () => 0);
  const label = (text: string): number[] => [text.length, ...[...text].map((c) => c.charCodeAt(0))];

  test("joins the labels of the first question", () => {
    expect(dnsName([...header, ...label("registry"), ...label("npmjs"), ...label("org"), 0])).toBe("registry.npmjs.org");
  });

  test("refuses a name with no labels", () => {
    expect(dnsName([...header, 0])).toBeNull();
  });

  test("refuses a label past the packet and an over-long label", () => {
    expect(dnsName([...header, 9, 97, 98])).toBeNull();
    expect(dnsName([...header, 64, ...Array.from({ length: 64 }, () => 97), 0])).toBeNull();
  });
});

describe("parseConnectTrace", () => {
  const dnsQuery = 'sendto(5, "\\0\\2\\1\\0\\0\\1\\0\\0\\0\\0\\0\\0\\7example\\3com\\0\\0\\1\\0\\1", 29, MSG_NOSIGNAL, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("10.0.0.2")}, 16) = 29';
  const dnsAnswer = 'sendto(5, "\\0\\2\\201\\0\\0\\1\\0\\1\\0\\0\\0\\0\\3bad\\0", 14, 0, NULL, 0) = 14';
  const connect = (address: string, port: number): string => `connect(3, {sa_family=AF_INET, sin_port=htons(${port}), sin_addr=inet_addr("${address}")}, 16) = -1 ENETUNREACH`;

  test("decodes queried names and lists connect targets", () => {
    const trace = [dnsQuery, dnsAnswer, connect("93.184.216.34", 443), connect("93.184.216.34", 443), connect("10.1.2.3", 80)].join("\n");
    expect(parseConnectTrace(trace, [])).toEqual({ hosts: ["example.com"], connects: ["10.1.2.3:80", "93.184.216.34:443"] });
  });

  test("drops the ignored gateway, loopback and DNS-port connects", () => {
    const trace = [connect("172.31.77.1", 8080), connect("127.0.0.53", 53), connect("127.0.0.1", 9000), connect("10.0.0.2", 53)].join("\n");
    expect(parseConnectTrace(trace, ["172.31.77.1"])).toEqual({ hosts: [], connects: [] });
  });
});

describe("parseExecveTrace", () => {
  test("counts successful execs by executable name", () => {
    const trace = [
      '100 execve("/usr/bin/git", ["git", "status"], 0x7ffd /* 20 vars */) = 0',
      '101 execve("/usr/local/bin/bun", ["bun"], 0x7ffd /* 20 vars */) = 0',
      '102 execve("/usr/bin/git", ["git", "log"], 0x7ffd /* 20 vars */) = 0',
      '103 execve("/usr/bin/missing", ["missing"], 0x7ffd /* 20 vars */) = -1 ENOENT (No such file or directory)',
    ].join("\n");
    expect(parseExecveTrace(trace)).toEqual({ total: 3, byExe: { git: 2, bun: 1 } });
  });
});

describe("snapshots", () => {
  const before = parseSnapshot(["d\t4096\t-\t/work", "f\t10\taaaa\t/work/keep", "f\t10\tbbbb\t/work/edit", "f\t5\tcccc\t/work/gone", ""].join("\n"));
  const after = parseSnapshot(["d\t8192\t-\t/work", "f\t10\taaaa\t/work/keep", "f\t10\tdddd\t/work/edit", "f\t1\teeee\t/work/new", ""].join("\n"));

  test("parses type, size, checksum and the whole remaining path", () => {
    expect(parseSnapshot("f\t3\tabc\t/a\tb\n").get("/a\tb")).toEqual({ type: "f", size: 3, sum: "abc" });
  });

  test("reports created, modified and deleted paths and ignores directory size changes", () => {
    expect(diffSnapshots(before, after)).toEqual({ created: ["/work/new"], modified: ["/work/edit"], deleted: ["/work/gone"] });
  });
});

describe("humanBytes", () => {
  test("switches unit at 1024", () => {
    expect([1023, 1024, 1536, 1048576].map(humanBytes)).toEqual(["1023 B", "1.0 KiB", "1.5 KiB", "1.0 MiB"]);
  });
});

describe("blockedBy", () => {
  test("names the blocker the denial text points at", () => {
    expect(blockedBy("Bash denied by plugin ecc-guard: no")).toBe("plugin ecc-guard");
    expect(blockedBy("Dangerous rm operation detected")).toBe("Claude Code built-in check");
    expect(blockedBy("PreToolUse:Bash hook error: failed")).toBe("PreToolUse:Bash hook script");
    expect(blockedBy("something else")).toBe("unattributed");
    expect(blockedBy("")).toBe("");
  });
});

describe("breakdown", () => {
  const reminder = "<system-reminder>\nAs you answer the user's questions\n# Environment\nenv text</system-reminder>";
  const body = {
    system: [{ type: "text", text: "abcd" }],
    tools: [{ name: "Bash" }, { name: "mcp__srv__tool" }],
    messages: [
      { role: "user", content: [{ type: "text", text: reminder }, { type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", content: "out" }] },
    ],
  };
  const result = breakdown(body);

  test("counts the system prompt and splits built-in from MCP tools", () => {
    expect(result.chars.system_prompt).toBe(4);
    expect(result.chars.tools_builtin).toBe('{"name":"Bash"}'.length);
    expect(result.chars.tools_mcp).toBe('{"name":"mcp__srv__tool"}'.length);
    expect([result.tools_builtin_n, result.tools_mcp_n, result.mcp_servers]).toEqual([1, 1, { srv: 1 }]);
  });

  test("cuts message text at the environment marker and keeps the prompt apart", () => {
    const at = reminder.indexOf("\n# Environment\n");
    expect(result.chars.context_reminder).toBe(at);
    expect(result.chars.environment).toBe(reminder.length - at);
    expect(result.prompt_chars).toBe(5);
  });

  test("counts tool calls and results as conversation", () => {
    expect(result.chars.conversation).toBe('Bash{"command":"ls"}'.length + 3);
  });

  test("adds every category to the total", () => {
    expect(totalChars(result)).toBe(4 + 15 + 25 + reminder.length + 20 + 3);
  });
});
