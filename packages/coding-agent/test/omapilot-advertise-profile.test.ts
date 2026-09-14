/**
 * PLANES G2c — omapilot profile advertise check.
 *
 * Proves that with the shipped `.omp/profiles/omapilot/agent/mcp.json`, the
 * tools advertised to the model after the current wrap
 * (`discoverAndLoadMCPTools` → `filterAdvertisedMcpTools`, the same
 * composition sdk.ts and `AgentSession.refreshMCPTools` use) are exactly the
 * G0-frozen allowlist — and nothing else.
 *
 * Layers:
 *  1. Static: the shipped profile declares exactly the servers
 *     lapis/facet/hedron (no GitHub-scale server) and `advertise.mode` is
 *     "allowlist" with the seven G0-frozen entries.
 *  2. Runtime: fixture stdio MCP servers named lapis/facet/hedron advertise
 *     SUPERSETS of the live tool names (lapis 14, facet 11 — recorded in
 *     foundry/omapilot/evidence/planes/g0-baseline.json — plus a hedron
 *     fixture with hql and two write-ish extras). The shipped profile file is
 *     installed at a temp agent dir activated via pi-utils `setAgentDir`
 *     (bun caches os.homedir() at process start, so HOME mutation cannot
 *     reach the profile-dir resolver in-process; the OMP_PROFILE →
 *     ~/.omp/profiles/<name>/agent mapping itself is pi-utils machinery
 *     covered by upstream tests). The advertised `mcp__` names must equal
 *     the seven minted allowlist names; stock pass-through (no advertise)
 *     must keep all 28.
 *
 * pi-natives is mocked: never called on this path, and the Rust addon is not
 * built on the G0/G2 host. Run: bun test test/omapilot-advertise-profile.test.ts
 */
import { afterAll, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Absorbs any access/call/construct — import-time stand-in for pi-natives.
const absorb: unknown = new Proxy(() => {}, {
	get: (_t, p) => (p === Symbol.toPrimitive ? () => 0 : absorb),
	construct: () => ({}),
	apply: () => ({}),
});

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const PROFILE_PATH = path.join(REPO_ROOT, ".omp", "profiles", "omapilot", "agent", "mcp.json");

/** Live tool-name supersets, frozen from evidence/planes/g0-baseline.json. */
const FIXTURE_TOOLS: Record<string, string[]> = {
	lapis: [
		"analytics", "append_to_note", "create_note", "health", "list_notes", "list_tasks",
		"neighbors", "read_note", "resolve_link", "search", "search_and_read", "toggle_task",
		"tree_retrieve", "vault_info",
	],
	facet: [
		"blob_get", "history_get", "history_list", "request_get", "request_list", "request_run",
		"run_diff", "run_replay", "session_end", "session_start", "sql_query",
	],
	// hql is the G5 one-tool shim; the extras prove non-allowlisted tools hide.
	hedron: ["hql", "reconcile", "store_snapshot"],
};

const EXPECTED_ADVERTISED = [
	"mcp__facet_history_get",
	"mcp__facet_history_list",
	"mcp__hedron_hql",
	"mcp__lapis_neighbors",
	"mcp__lapis_search",
	"mcp__lapis_search_and_read",
	"mcp__lapis_tree_retrieve",
];

/** Minimal newline-delimited JSON-RPC stdio MCP server, parameterized by argv. */
const FIXTURE_SERVER_SOURCE = `import * as readline from "node:readline";
const serverName = process.argv[2];
const toolNames = JSON.parse(process.argv[3]);
const tools = toolNames.map(name => ({
	name,
	description: "Fixture tool " + name + " for " + serverName + ".",
	inputSchema: { type: "object", properties: { query: { type: "string" } } },
}));
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", line => {
	const trimmed = line.trim();
	if (!trimmed) return;
	let msg;
	try { msg = JSON.parse(trimmed); } catch { return; }
	if (msg.id === undefined || msg.id === null) return;
	let result;
	if (msg.method === "initialize") {
		result = { protocolVersion: "2025-03-26", serverInfo: { name: serverName, version: "1.0.0" }, capabilities: { tools: {} } };
	} else if (msg.method === "tools/list") {
		result = { tools };
	} else {
		result = {};
	}
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
});
rl.on("close", () => process.exit(0));
`;

let tmpRoot: string | undefined;

afterAll(async () => {
	// Restore pi-utils dirs state mutated via setAgentDir.
	const piUtils = (await import("@oh-my-pi/pi-utils")) as { __resetDirsFromEnvForTests?: () => void };
	piUtils.__resetDirsFromEnvForTests?.();
	if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
});

test("omapilot profile: advertised mcp__ names ⊆ allowlist", async () => {
	// --- Layer 1: static profile assertions ---
	const profile = JSON.parse(await Bun.file(PROFILE_PATH).text()) as {
		mcpServers?: Record<string, unknown>;
		advertise?: { mode?: string; tools?: Array<{ server: string; tool: string }> };
	};
	const serverNames = Object.keys(profile.mcpServers ?? {}).sort();
	expect(serverNames).toEqual(["facet", "hedron", "lapis"]);
	expect(serverNames.some(name => /github/i.test(name))).toBe(false);
	expect(profile.advertise?.mode).toBe("allowlist");
	expect(profile.advertise?.tools).toHaveLength(7);

	// --- Layer 2: runtime through the wrap ---
	tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omapilot-g2c-"));
	const tmpCwd = path.join(tmpRoot, "project");
	await fs.mkdir(tmpCwd, { recursive: true });

	// Fixture servers named lapis/facet/hedron, each advertising a superset of
	// the live tool names.
	const fixtureServer = path.join(tmpRoot, "fixture-server.ts");
	await Bun.write(fixtureServer, FIXTURE_SERVER_SOURCE);
	const fixtureServers = Object.fromEntries(
		Object.entries(FIXTURE_TOOLS).map(([name, tools]) => [
			name,
			{ type: "stdio", command: process.execPath, args: ["run", fixtureServer, name, JSON.stringify(tools)] },
		]),
	);

	// Install the profile at a temp agent dir and point pi-utils at it. The
	// shipped file's `advertise` block is copied VERBATIM (that block is the
	// artifact under test); its `mcpServers` are rewritten to the fixtures —
	// the real lapis/facet/hedron commands are box-specific and cannot run in
	// a hermetic test, and server discovery is upstream machinery.
	const profileAgentDir = path.join(tmpRoot, "profile-agent");
	await fs.mkdir(profileAgentDir, { recursive: true });
	const installedProfile = { ...profile, mcpServers: fixtureServers };
	await Bun.write(path.join(profileAgentDir, "mcp.json"), `${JSON.stringify(installedProfile, null, 2)}\n`);

	// Mock pi-natives from the real export surface before importing the wrap.
	const dts = await Bun.file(
		path.join(REPO_ROOT, "packages", "natives", "native", "index.d.ts"),
	).text();
	const ns: Record<string, unknown> = {};
	for (const m of dts.matchAll(/export declare (?:class|function|const|enum|let|var) ([A-Za-z0-9_]+)/g)) {
		ns[m[1]] = absorb;
	}
	mock.module("@oh-my-pi/pi-natives", () => ns);

	const piUtils = (await import("@oh-my-pi/pi-utils")) as { setAgentDir?: (dir: string) => void };
	piUtils.setAgentDir?.(profileAgentDir);

	const { discoverAndLoadMCPTools } = await import("../src/mcp/loader");
	const { loadMCPAdvertiseConfig } = await import("../src/mcp/config");
	const { createMCPToolName } = await import("../src/mcp/tool-bridge");
	const { filterAdvertisedMcpTools } = await import("../src/mcp/advertise");

	const result = await discoverAndLoadMCPTools(tmpCwd, { cacheStorage: null });
	try {
		expect(result.errors).toEqual([]);
		expect([...result.connectedServers].sort()).toEqual(["facet", "hedron", "lapis"]);
		const allTools = result.tools.map(loaded => loaded.tool);
		expect(allTools).toHaveLength(28); // 14 + 11 + 3: superset really is bigger

		type McpCustomTool = (typeof allTools)[number] & { mcpServerName: string; mcpToolName: string };

		// Advertise config resolves through the active profile's agent dir.
		const advertise = await loadMCPAdvertiseConfig(tmpCwd);
		expect(advertise?.mode).toBe("allowlist");

		const advertised = filterAdvertisedMcpTools(allTools as McpCustomTool[], advertise);
		const advertisedNames = advertised.map(tool => tool.name).sort();
		expect(advertisedNames).toEqual(EXPECTED_ADVERTISED);

		// Subset of the profile allowlist, minted with the same sanitizing.
		const allowedNames = new Set(
			(profile.advertise?.tools ?? []).map(entry => createMCPToolName(entry.server, entry.tool)),
		);
		for (const name of advertisedNames) expect(allowedNames.has(name)).toBe(true);

		// Stock pass-through: no advertise config → every connected tool.
		expect(filterAdvertisedMcpTools(allTools as McpCustomTool[], undefined)).toHaveLength(28);
	} finally {
		await result.manager.disconnectAll();
	}
}, 60_000);
