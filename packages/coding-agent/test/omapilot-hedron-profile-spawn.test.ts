/**
 * PLANES follow-up: the shipped omapilot profile must launch the hedron
 * hql shim through omapi's stdio spawn path.
 *
 * omapi `resolveStdioSpawnCommand` passes argv verbatim (no ${ENV} expansion
 * except plugin PLUGIN_ROOT). A `bun run ${OMAPI_REPO}/...` token never
 * starts the shim. The profile must use `sh -c` so the shell expands
 * $OMAPI_REPO, like lapis.
 *
 * This test loads the shipped mcp.json, resolves spawn via the same
 * function StdioTransport.connect uses, then actually spawns that argv
 * (not `bun <shim.ts>` directly) and drives initialize + tools/list.
 */
import { expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const PROFILE_PATH = path.join(REPO_ROOT, ".omp", "profiles", "omapilot", "agent", "mcp.json");
const SHIM_REL = "packages/coding-agent/src/mcp/hedron-hql-stdio.ts";

const absorb: unknown = new Proxy(() => {}, {
	get: (_t, p) => (p === Symbol.toPrimitive ? () => 0 : absorb),
	construct: () => ({}),
	apply: () => ({}),
});

interface JsonRpcResponse {
	jsonrpc: string;
	id: unknown;
	result?: { tools?: Array<{ name: string }>; serverInfo?: { name: string } };
	error?: unknown;
}

test("shipped omapilot hedron argv launches the hql shim via resolveStdioSpawnCommand", async () => {
	const dts = await Bun.file(path.join(REPO_ROOT, "packages", "natives", "native", "index.d.ts")).text();
	const ns: Record<string, unknown> = {};
	for (const m of dts.matchAll(/export declare (?:class|function|const|enum|let|var) ([A-Za-z0-9_]+)/g)) {
		ns[m[1]] = absorb;
	}
	mock.module("@oh-my-pi/pi-natives", () => ns);

	const { resolveStdioSpawnCommand } = await import("@oh-my-pi/pi-coding-agent/mcp/transports/stdio");

	const profile = JSON.parse(await fs.readFile(PROFILE_PATH, "utf8")) as {
		mcpServers: { hedron: MCPStdioServerConfig };
	};
	const hedron = profile.mcpServers.hedron;
	expect(hedron.command).toBe("sh");
	expect(hedron.args?.[0]).toBe("-c");
	const script = hedron.args?.[1] ?? "";
	expect(script).toContain("$OMAPI_REPO");
	expect(script).not.toContain("${OMAPI_REPO}");
	expect(script).toContain(SHIM_REL);

	const spawn = await resolveStdioSpawnCommand(hedron, { platform: process.platform });
	// Verbatim argv: if this were `bun run ${OMAPI_REPO}/...` the third token
	// would still contain the unexpanded ${} and Bun.spawn would miss the file.
	expect(spawn.cmd.some(tok => tok.includes("${OMAPI_REPO}"))).toBe(false);
	expect(spawn.cmd[0]).toBe("sh");
	expect(spawn.cmd[1]).toBe("-c");

	const proc = Bun.spawn({
		cmd: spawn.cmd,
		env: {
			...process.env,
			OMAPI_REPO: REPO_ROOT,
			OMAPI_BUN: process.execPath,
			PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}`,
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const encoder = new TextEncoder();
	proc.stdin.write(encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`));
	proc.stdin.write(encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`));
	await new Promise(r => setTimeout(r, 1500));
	proc.stdin.end();

	const text = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	const responses = new Map<number, JsonRpcResponse>();
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const msg = JSON.parse(t) as JsonRpcResponse;
			if (msg.id !== undefined && msg.id !== null) responses.set(Number(msg.id), msg);
		} catch {
			// ignore non-JSON
		}
	}

	expect(responses.get(1)?.result?.serverInfo?.name).toBe("hedron");
	const tools = responses.get(2)?.result?.tools ?? [];
	expect(tools.map(t => t.name)).toEqual(["hql"]);
	expect(exitCode).toBe(0);
	expect(stderr).not.toMatch(/Cannot find module|file not found|OMAPI_REPO is unset/i);
}, 15_000);
