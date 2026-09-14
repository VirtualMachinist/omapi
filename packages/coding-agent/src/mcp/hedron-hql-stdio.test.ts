/**
 * PLANES G5a — hedron-hql-stdio unit test.
 *
 * Drives the stdio MCP shim over its real stdio (newline-delimited JSON-RPC)
 * and asserts:
 *  - initialize + tools/list expose exactly the one `hql` tool (read-only).
 *  - tools/call with a pipeline when `hedron` is NOT on PATH returns an MCP
 *   `isError: true` result with an error STRING (missing binary), and the
 *   server process STAYS UP (a subsequent tools/list still answers).
 *  - a missing/empty pipeline returns an isError result (not a crash).
 *
 * `hedron` is absent on apiary and CI runners, so the missing-binary path is
 * the default under test. The happy path (real hedron) is not asserted here —
 * it requires a box with hedron installed and is out of the G5a gate (the
 * shim's contract is to fail visibly when hedron is missing).
 *
 * Run: bun test packages/coding-agent/src/mcp/hedron-hql-stdio.test.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";

const SHIM = path.resolve(import.meta.dir, "hedron-hql-stdio.ts");

interface JsonRpcResponse {
	jsonrpc: string;
	id: unknown;
	result?: any;
	error?: any;
}

/** Spawn the shim and drive a sequence of JSON-RPC requests, collecting
 * responses by id. Returns the responses and the child process so the caller
 * can check it is still alive. */
async function drive(
	requests: Array<{ id: number; method: string; params?: any }>,
): Promise<{ responses: Map<number, JsonRpcResponse>; proc: any }> {
	const proc = Bun.spawn({
		cmd: [process.execPath, SHIM],
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const encoder = new TextEncoder();
	const responses = new Map<number, JsonRpcResponse>();

	// Send all requests, then close stdin so the shim exits (rl "close").
	for (const req of requests) {
		proc.stdin.write(encoder.encode(JSON.stringify(req) + "\n"));
	}
	// Give the shim a moment to process before closing stdin.
	await new Promise(r => setTimeout(r, 250));
	proc.stdin.end();

	const text = await new Response(proc.stdout).text();
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const msg = JSON.parse(t) as JsonRpcResponse;
			if (msg.id !== undefined && msg.id !== null) responses.set(Number(msg.id), msg);
		} catch {
			// ignore non-JSON lines
		}
	}
	return { responses, proc };
}

afterEach(() => {
	// no global state to reset; the shim is a fresh subprocess per test
});

describe("hedron-hql-stdio — G5a", () => {
	test("initialize + tools/list expose exactly the one read-only hql tool", async () => {
		const { responses } = await drive([
			{ id: 1, method: "initialize" },
			{ id: 2, method: "tools/list" },
		]);
		const init = responses.get(1);
		expect(init).toBeDefined();
		expect(init!.result.serverInfo.name).toBe("hedron");
		expect(init!.result.protocolVersion).toBe("2025-03-26");

		const list = responses.get(2);
		expect(list).toBeDefined();
		expect(list!.result.tools).toHaveLength(1);
		const tool = list!.result.tools[0];
		expect(tool.name).toBe("hql");
		// Read-only: no Store/reconcile tool advertised.
		expect(list!.result.tools.map((t: any) => t.name)).toEqual(["hql"]);
		// pipeline is the required string argument.
		expect(tool.inputSchema.properties.pipeline.type).toBe("string");
		expect(tool.inputSchema.required).toEqual(["pipeline"]);
	}, 10_000);

	test("missing hedron on PATH: tools/call returns isError string, not a crash", async () => {
		// hedron is not on PATH in the test environment (apiary/CI). The shim
		// must return an MCP tool error (isError: true) with a message string,
		// NOT a JSON-RPC error and NOT a process crash.
		const { responses } = await drive([
			{ id: 1, method: "initialize" },
			{ id: 2, method: "tools/call", params: { name: "hql", arguments: { pipeline: "lathe-desktop | history" } } },
		]);
		const call = responses.get(2);
		expect(call).toBeDefined();
		expect(call!.result.isError).toBe(true);
		expect(call!.result.content[0].type).toBe("text");
		const text = call!.result.content[0].text as string;
		// Error string mentions the missing binary, not a stack trace.
		expect(/hedron.*(not found|PATH)|not found.*hedron|PATH/i.test(text)).toBe(true);
		expect(text).not.toContain("at "); // no stack-trace dump in the error string
	}, 10_000);

	test("process stays up after a missing-binary tool error (subsequent call still answers)", async () => {
		// The G5a contract: a missing hedron is a tool error, not a process
		// crash. A second tools/list after the failed call must still respond.
		const { responses } = await drive([
			{ id: 1, method: "initialize" },
			{ id: 2, method: "tools/call", params: { name: "hql", arguments: { pipeline: "x" } } },
			{ id: 3, method: "tools/list" },
		]);
		expect(responses.get(2)?.result.isError).toBe(true);
		const list = responses.get(3);
		expect(list).toBeDefined();
		expect(list!.result.tools).toHaveLength(1);
		expect(list!.result.tools[0].name).toBe("hql");
	}, 10_000);

	test("missing/empty pipeline returns an isError result, not a crash", async () => {
		const { responses } = await drive([
			{ id: 1, method: "initialize" },
			{ id: 2, method: "tools/call", params: { name: "hql", arguments: { pipeline: "" } } },
			{ id: 3, method: "tools/call", params: { name: "hql", arguments: {} } },
		]);
		const empty = responses.get(2);
		expect(empty!.result.isError).toBe(true);
		expect(/pipeline/i.test(empty!.result.content[0].text)).toBe(true);
		const missing = responses.get(3);
		expect(missing!.result.isError).toBe(true);
		expect(/pipeline/i.test(missing!.result.content[0].text)).toBe(true);
	}, 10_000);
});
