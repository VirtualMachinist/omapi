#!/usr/bin/env bun
/**
 * HedronDB one-tool stdio MCP — PLANES G5a.
 *
 * Exposes a single read-only MCP tool `hql` with argument `pipeline: string`.
 * On call, spawns `hedron hql --db $HEDRON_DB --format json <pipeline>` when
 * `hedron` is on PATH and returns its JSON stdout. If `hedron` is missing the
 * tool returns an MCP `isError: true` result with an error STRING — the server
 * process stays up (fail-visible, not crash). READ-ONLY: no Store/reconcile.
 *
 * Law: [[foundry/omapilot/SPEC-planes]] G5a, [[foundry/omapilot/PLANES]].
 * Wired as the `hedron` server command in
 * `.omp/profiles/omapilot/agent/mcp.json` (fullstack G5b).
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio (the same shape the
 * G2 fixture server and omapi's stdio transport speak). Run directly:
 *   bun packages/coding-agent/src/mcp/hedron-hql-stdio.ts
 */
import * as readline from "node:readline";

const SERVER_NAME = "hedron";
const SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2025-03-26";

/** The single advertised tool. Read-only; no Store/reconcile. */
const HQL_TOOL = {
	name: "hql",
	description:
		"Run a read-only HQL pipeline against HedronDB and return JSON rows. " +
		"Never writes; nixos-rebuild still reads the G0 flake. " +
		"Spawns: hedron hql --db $HEDRON_DB --format json <pipeline>.",
	inputSchema: {
		type: "object",
		properties: {
			pipeline: {
				type: "string",
				description:
					"HQL pipeline string, e.g. 'lathe-desktop | history'. Passed as the " +
					"trailing positional argument to `hedron hql`.",
			},
		},
		required: ["pipeline"],
		additionalProperties: false,
	},
};

/** Resolve the --db flag value from $HEDRON_DB (may be unset). */
function hedronDbArgs(): string[] {
	const db = process.env.HEDRON_DB;
	return db ? ["--db", db] : [];
}

/** Spawn `hedron hql ... <pipeline>` and capture stdout. Returns
 * { ok, stdout } on success, { ok: false, error } on failure (missing
 * binary, non-zero exit, or spawn error). Never throws. */
async function runHql(pipeline: string): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
	const args = ["hql", ...hedronDbArgs(), "--format", "json", pipeline];
	try {
		const proc = Bun.spawn({
			cmd: ["hedron", ...args],
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (exitCode !== 0) {
			const detail = stderr.trim() || `hedron exited with code ${exitCode}`;
			return { ok: false, error: `hedron hql failed (exit ${exitCode}): ${detail}` };
		}
		return { ok: true, stdout };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		// ENOENT when `hedron` is not on PATH — the canonical G5a "missing
		// binary" case. Report as a tool error string, do not crash.
		if (/ENOENT|not found|command not found/i.test(msg)) {
			return { ok: false, error: "hedron binary not found on PATH; install hedron or add it to PATH to use hql." };
		}
		return { ok: false, error: `failed to spawn hedron: ${msg}` };
	}
}

/** Build an MCP tools/call result. */
function toolResult(content: string, isError: boolean) {
	return {
		content: [{ type: "text", text: content }],
		isError,
	};
}

function send(msg: unknown): void {
	process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResponse(id: unknown, result: unknown, error?: unknown): void {
	const resp: Record<string, unknown> = { jsonrpc: "2.0", id };
	if (error !== undefined) resp.error = error;
	else resp.result = result;
	send(resp);
}

async function handleRequest(msg: { id?: unknown; method: string; params?: any }): Promise<void> {
	const { id, method, params } = msg;
	// Notifications have no id and get no response.
	if (id === undefined || id === null) return;

	if (method === "initialize") {
		sendResponse(id, {
			protocolVersion: PROTOCOL_VERSION,
			serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
			capabilities: { tools: {} },
		});
		return;
	}

	if (method === "ping") {
		sendResponse(id, {});
		return;
	}

	if (method === "tools/list") {
		sendResponse(id, { tools: [HQL_TOOL] });
		return;
	}

	if (method === "tools/call") {
		const pipeline = params?.arguments?.pipeline;
		if (typeof pipeline !== "string" || pipeline.length === 0) {
			sendResponse(id, toolResult("hql requires a non-empty 'pipeline' string argument.", true));
			return;
		}
		const res = await runHql(pipeline);
		if (res.ok) {
			sendResponse(id, toolResult(res.stdout, false));
		} else {
			// Missing binary / non-zero exit / spawn error: tool error STRING,
			// not a JSON-RPC error. Process stays up.
			sendResponse(id, toolResult(res.error, true));
		}
		return;
	}

	// Unknown method: JSON-RPC error (method not found), not a crash.
	sendResponse(id, undefined, { code: -32601, message: `Method not found: ${method}` });
}

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", line => {
	const trimmed = line.trim();
	if (!trimmed) return;
	let msg: { id?: unknown; method: string; params?: any } | null = null;
	try {
		msg = JSON.parse(trimmed);
	} catch {
		return; // ignore malformed lines
	}
	if (!msg || typeof msg.method !== "string") return;
	// Handle async without blocking the readline loop.
	handleRequest(msg).catch(error => {
		const errMsg = error instanceof Error ? error.message : String(error);
		if (msg?.id !== undefined && msg?.id !== null) {
			sendResponse(msg.id, undefined, { code: -32603, message: `internal error: ${errMsg}` });
		}
	});
});

rl.on("close", () => process.exit(0));
