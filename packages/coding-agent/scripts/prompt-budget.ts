#!/usr/bin/env bun
/**
 * PLANES prompt-budget — advertised-tool JSON token budget for the omapilot
 * profile (SPEC G3). Qwen merges every advertised tool's schema into the
 * system turn on every request, so the advertised set has a per-turn token
 * cost compaction cannot shrink. This script measures it and fails CI when
 * it exceeds the frozen cap.
 *
 * Estimator (SPEC G3; same as evidence/planes/g0-baseline.json): chars/4 over
 * JSON.stringify of per-tool { name, description, parameters }; tokens =
 * ceil(totalBytes / 4). Not tiktoken; a simple reproducible upper bound.
 *
 * Inputs: the omapilot profile allowlist (.omp/profiles/omapilot/agent/mcp.json
 * advertise block) + MOCKED tool schemas embedded below (SPEC G3a allows
 * "mocked/live schemas"). The G0 baseline measured the LIVE schemas (1363
 * tokens for the 7-tool projected allowlist); this script re-measures the
 * post-G2 advertised set against MOCKED schemas and sets the cap 15% over
 * that (SPEC G3b allows re-measure post-G2). Mocked schemas keep the script
 * hermetic and CI-portable; the cap still catches allowlist growth because
 * every advertised tool contributes bytes.
 *
 * Filter: the SHIPPED filterAdvertisedMcpTools from src/mcp/advertise.ts —
 * the same function sdk.ts and AgentSession.refreshMCPTools call. Names minted
 * with createMCPToolName (same sanitizer), so the allowlist match is identical
 * to the runtime match.
 *
 * Exit: 0 if count <= cap; 1 if count > cap (CI fail); 2 bad usage/missing
 * profile. Flags: --cap N, --profile path, --json, --measure-only.
 */
import * as fs from "node:fs";
import * as path from "node:path";

// pi-natives is NOT built on CI runners / apiary (Rust addon; cmake absent).
// The advertise path never calls native code, but the import chain
// (tool-bridge -> pi-utils -> pi-natives) loads the addon at module scope and
// throws "Failed to load pi_natives native addon" before the filter runs.
// `mock.module` is a bun:test API unavailable under `bun run`, so we register
// a Bun runtime plugin (at the top of this entry file, before the dynamic
// imports below) that substitutes packages/natives/native/index.js with a
// mock exporting every real runtime export name (read from index.js) as an
// absorb proxy. This keeps the script self-contained: `bun <this-file>` works
// with no --preload and no native build.
const _nativesDir = path.resolve(import.meta.dir, "..", "..", "natives", "native");
let _nativesNames: string[] = [];
try {
	const js = fs.readFileSync(path.join(_nativesDir, "index.js"), "utf8");
	// index.js: `export const <Name> = nativeBindings.<Name>;` and enum objects
	// `export const <Name> = {`. Catch every `export const <Name> ` line.
	_nativesNames = [...js.matchAll(/^export const ([A-Za-z0-9_]+) /gm)].map(m => m[1]);
	if (_nativesNames.length === 0) {
		const dts = fs.readFileSync(path.join(_nativesDir, "index.d.ts"), "utf8");
		_nativesNames = [...dts.matchAll(/export declare (?:class|function|const|enum|let|var) ([A-Za-z0-9_]+)/g)].map(m => m[1]);
	}
} catch {
	_nativesNames = ["FileLock", "Process", "ProcessStatus", "summarizeCode", "Tokenizer", "NativeOAuthCallback"];
}
const _mockCode =
	"const absorb = new Proxy(function(){}, { get:(t,p)=> p===Symbol.toPrimitive?()=>0:absorb, construct:()=>({}), apply:()=>({}) });\n" +
	[...new Set(_nativesNames)].map(n => `export const ${n} = absorb;`).join("\n") +
	"\nexport default absorb;\n";
Bun.plugin({
	name: "prompt-budget-natives-mock",
	setup(builder) {
		builder.onLoad({ filter: /packages[\\/]natives[\\/]native[\\/]index\.js$/ }, () => ({
			contents: _mockCode,
			loader: "js",
		}));
	},
});

const { createMCPToolName } = await import("../src/mcp/tool-bridge");
const { filterAdvertisedMcpTools } = await import("../src/mcp/advertise");
import type { AdvertiseConfig, AdvertiseFilterableTool } from "../src/mcp/advertise";

// ---------------------------------------------------------------------------
// Mocked tool schemas — representative superset of the live surfaces.
// ---------------------------------------------------------------------------
interface MockedTool { name: string; description: string; inputSchema: object; }
function obj(properties: Record<string, unknown>, required: string[] = []): object {
	return { type: "object", properties, required, additionalProperties: false };
}
function s(d: string): { type: string; description: string } { return { type: "string", description: d }; }
function i(d: string): { type: string; description: string; format: string; minimum: number } {
	return { type: "integer", description: d, format: "uint32", minimum: 0 };
}
function b(d: string): { type: string; description: string } { return { type: "boolean", description: d }; }
function arr(): { type: string; items: { type: string } } { return { type: "array", items: { type: "string" } }; }

const MOCK_LAPIS: MockedTool[] = [
	{ name: "analytics", description: "Named read-only analytics over the index: inventory, priority, tags, health, recent, hubs, density, degree, dangling. Returns {columns, rows}.", inputSchema: obj({ query: s("One of: inventory, priority, tags, health, recent, hubs, density, degree, dangling.") }, ["query"]) },
	{ name: "append_to_note", description: "Append markdown to a note (bumps updated, keeps all other frontmatter), then kick the index. dry_run / if_mtime / if_hash guard the write.", inputSchema: obj({ path: s("Vault-relative note path."), text: s("Markdown to append."), dry_run: b("Report without writing."), if_mtime: i("Refuse if updatedAt (ms) no longer matches."), if_hash: s("Refuse if hash no longer matches.") }, ["path", "text"]) },
	{ name: "create_note", description: "Create a note with a HAL create-set, then kick the lattice index. Returns the path. dry_run=true writes nothing.", inputSchema: obj({ title: s("Title; becomes HAL name and the slugged filename."), path: s("Folder or file path. Default: inbox."), template: s("Template name from .lapis/templates/."), doc_type: s("HAL type/doc_type."), domain: s("HAL domain."), tags: arr(), body: s("Body markdown."), dry_run: b("Write nothing.") }, ["title"]) },
	{ name: "health", description: "Lattice /healthz.", inputSchema: obj({}) },
	{ name: "list_notes", description: "List notes from the lattice documents table (metadata only). Never walks the vault. Page with limit / offset.", inputSchema: obj({ prefix: s("Vault-relative folder prefix."), domain: s("Filter by HAL domain."), doc_type: s("Filter by doc_type."), status: s("Filter by status."), tag: s("Filter by tag."), limit: i("Max rows (default 50, max 1000)."), offset: i("Skip this many rows.") }) },
	{ name: "list_tasks", description: "List checkbox tasks and file tasks. Unscoped returns summary counts; with path or full=true returns rows.", inputSchema: obj({ status: s("open, done, in-progress, cancelled, forwarded, waiting."), due: s("today, overdue, or YYYY-MM-DD."), tag: s("Filter by tag."), path: s("Restrict to this folder or file."), full: b("Return every row even when unscoped."), limit: i("Rows per page (default 500)."), offset: i("Skip this many rows.") }) },
	{ name: "neighbors", description: "Hop-1 wikilink neighbors of a note from the lattice edges table. Dangling rows have path=null and dst_raw.", inputSchema: obj({ path: s("Vault-relative note path."), direction: s("out, in, or both. Default both."), dangling: b("Include dangling links."), hop: i("1 = direct neighbors; 2 = ego graph.") }, ["path"]) },
	{ name: "read_note", description: "Read one note: body plus parsed HAL frontmatter. Slice with heading / chunk, clip with max_chars, or meta_only.", inputSchema: obj({ path: s("Vault-relative note path."), heading: s("Only the section under this heading."), chunk: i("Only the N-th heading section."), max_chars: i("Clip body to this many chars."), meta_only: b("HAL and metadata only.") }, ["path"]) },
	{ name: "resolve_link", description: "Resolve a [[wikilink]] or a neighbors dst_raw to a vault path: exact path, unique basename, collision, or dangling.", inputSchema: obj({ link: s("[[Name]], [[Name|alias#anchor]], or a raw target.") }, ["link"]) },
	{ name: "search", description: "Hybrid lattice search (BM25 + vectors + title). Hits carry rank, domain, doc_type; meta has per-arm latency and paging.", inputSchema: obj({ query: s("Query text."), limit: i("Result count (1..50), default 10."), offset: i("Skip this many hits."), domain: s("Filter by HAL domain."), mode: s("hybrid (default), bm25, or vector."), per_doc: b("Collapse to best chunk per doc.") }, ["query"]) },
	{ name: "search_and_read", description: "Search, then read the top hits: per hit the HAL meta and a body snippet. One call instead of search + N read_note.", inputSchema: obj({ query: s("Query text."), limit: i("Top-k notes to read (1..20), default 5."), domain: s("Filter by HAL domain."), mode: s("hybrid (default), bm25, or vector."), snippet_chars: i("Max body snippet chars per hit, default 600.") }, ["query"]) },
	{ name: "toggle_task", description: "Toggle one task by id (open <-> done). Rewrites only that checkbox line, then kicks the index. dry_run / if_mtime / if_hash guard the write.", inputSchema: obj({ id: s("Task id path#index or path#task."), dry_run: b("Report without writing."), if_mtime: i("Refuse if updatedAt no longer matches."), if_hash: s("Refuse if hash no longer matches.") }, ["id"]) },
	{ name: "tree_retrieve", description: "Hub-routed link walk from a seed note (or the hub nearest to query): {seed, hubs, nodes, edges, truncated}.", inputSchema: obj({ path: s("Seed note. Omit to start at the hub nearest to query."), query: s("Rank children by nomic similarity; picks seed hub when path omitted."), depth: i("Walk depth 1..3 (default 2)."), max_nodes: i("Node cap 1..200 (default 60).") }) },
	{ name: "vault_info", description: "Vault root, overlay buckets, and lattice health. Call once per session.", inputSchema: obj({}) },
];

const MOCK_FACET: MockedTool[] = [
	{ name: "blob_get", description: "One stored body by SHA-256: { blob: { hash, sizeBytes, contentType, body } }. Bodies may contain secrets the redaction list cannot see.", inputSchema: obj({ hash: s("SHA-256 hex from a history row."), path: s("File or directory inside the workspace; Facet walks up to .facet/lattice.db.") }, ["hash"]) },
	{ name: "history_get", description: "One recorded run by id: { workspace, run }. run_not_found (exit 4) when unknown.", inputSchema: obj({ id: s("Run ULID."), bodies: b("Include inline bodies."), path: s("File or directory inside the workspace.") }, ["id"]) },
	{ name: "history_list", description: "Recorded runs, newest first, metadata only (bodies are explicit pulls). Filters AND together.", inputSchema: obj({ actor: s("Only runs by this actor."), bodies: b("Include inline bodies."), environment: s("Only runs resolved with this environment."), hash: s("Request hash, body hash, or response body hash."), limit: { type: "integer", description: "Maximum rows (default 50)." }, path: s("Workspace path; walks up to .facet/lattice.db."), request: s("Only runs of this selector."), session: s("Session ULID, or current for FACET_SESSION."), since: { type: "integer", description: "Only runs at or after this Unix ms." }, status: { type: "integer", description: "Only runs with this HTTP status." }, tag: arr() }) },
	{ name: "request_get", description: "Probe's request get: one request as stored, or resolved with an environment.", inputSchema: obj({ path: s("Collection path: OpenCollection YAML or workspace directory."), selector: s("Request selector from request_list."), environment: s("Environment name to resolve with."), strictVariables: b("Fail on unresolved variable.") }, ["path", "selector"]) },
	{ name: "request_list", description: "Probe's request list for a collection: { requests: [ { selector, name, method, url } ] }. Use selectors, never names.", inputSchema: obj({ path: s("Collection path: OpenCollection YAML or workspace directory.") }, ["path"]) },
	{ name: "request_run", description: "Execute a request through Facet and record it in Lattice. With dryRun the request is resolved and previewed, nothing sent or recorded.", inputSchema: obj({ path: s("Collection path."), selector: s("Request selector."), environment: s("Environment name; enables secret hydration."), dryRun: b("Preview only; do not send."), noRecord: b("Execute without writing to Lattice."), strictVariables: b("Fail on unresolved variable."), tag: arr(), var: { type: "object", additionalProperties: { type: "string" }, description: "Variable overrides (--var)." }, expect: { oneOf: [{ type: "string" }, { type: "array", items: { oneOf: [{ type: "integer" }, { type: "string" }] } }], description: "Assert status after a real run." } }, ["path", "selector"]) },
	{ name: "run_diff", description: "Hash-first comparison of two recorded runs: changes by field, request.hash, both bodies. durationMs, actor, and tags never flip equal.", inputSchema: obj({ a: s("Run ULID."), b: s("Run ULID."), bodies: b("Unified diff for differing UTF-8 response bodies."), path: s("Workspace path; walks up to .facet/lattice.db.") }, ["a", "b"]) },
	{ name: "run_replay", description: "Re-send a recorded run from the current YAML at the recorded environment; the new run carries replayedFrom. frozen refuses when the request hash changed.", inputSchema: obj({ id: s("Run ULID to replay."), environment: s("Override the recorded environment."), frozen: b("Refuse when resolved request differs from recorded hash."), path: s("Collection path (default: current directory)."), tag: arr(), var: { type: "object", additionalProperties: { type: "string" }, description: "Variable overrides." }, expect: { oneOf: [{ type: "string" }, { type: "array", items: { oneOf: [{ type: "integer" }, { type: "string" }] } }], description: "Assert status after a real run." } }, ["id"]) },
	{ name: "session_end", description: "End a session (default: FACET_SESSION). Idempotent: alreadyEnded says whether it was already closed.", inputSchema: obj({ id: s("Session ULID, or current.") }) },
	{ name: "session_start", description: "Start a session in the machine store and return it ({ session: { id, actor, startedAt, endedAt, meta, runs? } }). Export the id as FACET_SESSION.", inputSchema: obj({ actor: s("Agent name (default: FACET_ACTOR, else human)."), meta: { type: "object", description: "Pointers only (harness ids, cwd); never transcripts or secrets." } }) },
	{ name: "sql_query", description: "Read-only SQL over the workspace store (runs, blobs). Writes fail with sql_read_only. The machine store is never attached.", inputSchema: obj({ sql: s("One SELECT statement."), path: s("Workspace path; walks up to .facet/lattice.db.") }, ["sql"]) },
];

// hedron: G5a one-tool hql shim (read-only) + two write-ish extras that prove
// non-allowlisted tools hide.
const MOCK_HEDRON: MockedTool[] = [
	{ name: "hql", description: "Run a read-only HQL pipeline against HedronDB and return JSON rows. Never writes; nixos-rebuild still reads the G0 flake.", inputSchema: obj({ pipeline: s("HQL pipeline string, e.g. 'lathe-desktop | history'."), db: s("HedronDB path (default: $HEDRON_DB).") }, ["pipeline"]) },
	{ name: "reconcile", description: "Reconcile named intent verdicts against live state. Write-ish; NOT advertised by the omapilot profile.", inputSchema: obj({ intent: s("Named intent to reconcile."), dry_run: b("Report without writing.") }, ["intent"]) },
	{ name: "store_snapshot", description: "Store a policy snapshot for a named intent. Write-ish; NOT advertised by the omapilot profile.", inputSchema: obj({ intent: s("Named intent."), verdict: s("Verdict text.") }, ["intent", "verdict"]) },
];

const MOCK_SERVERS: Record<string, MockedTool[]> = {
	lapis: MOCK_LAPIS,
	facet: MOCK_FACET,
	hedron: MOCK_HEDRON,
};

// ---------------------------------------------------------------------------
// Budget logic.
// ---------------------------------------------------------------------------

/** Frozen cap (tokens). Mirrors evidence/planes/g0-baseline.json cap_tokens.
 * Set post-G2 to ceil(measured_advertised_tokens * 1.15). Override with --cap. */
export const DEFAULT_CAP_TOKENS = 1322; // ceil(1149 * 1.15); post-G2 re-measure vs MOCKED schemas. Mirrors evidence/planes/g0-baseline.json cap_tokens.

// scripts -> coding-agent -> packages -> repo root
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const DEFAULT_PROFILE = path.join(REPO_ROOT, ".omp", "profiles", "omapilot", "agent", "mcp.json");

/** Build AdvertiseFilterableTool[] from mocked schemas, minting names with
 * the same sanitizer the runtime uses. */
function buildMockTools(): AdvertiseFilterableTool[] {
	const tools: AdvertiseFilterableTool[] = [];
	for (const [server, mocked] of Object.entries(MOCK_SERVERS)) {
		for (const t of mocked) {
			tools.push({
				name: createMCPToolName(server, t.name),
				mcpServerName: server,
				mcpToolName: t.name,
			});
		}
	}
	return tools;
}

/** Serialize one advertised tool the way the Qwen system-turn dump does per
 * tool: { name, description, parameters }. parameters = inputSchema. */
function serializeAdvertised(
	advertised: AdvertiseFilterableTool[],
): { name: string; description: string; parameters: object }[] {
	const byKey = new Map<string, MockedTool>();
	for (const [server, mocked] of Object.entries(MOCK_SERVERS)) {
		for (const t of mocked) byKey.set(`${server}\u0000${t.name}`, t);
	}
	return advertised.map(tool => {
		const mock = byKey.get(`${tool.mcpServerName}\u0000${tool.mcpToolName}`);
		if (!mock) throw new Error(`prompt-budget: no mocked schema for ${tool.mcpServerName}/${tool.mcpToolName}`);
		return { name: tool.name, description: mock.description, parameters: mock.inputSchema };
	});
}

export interface BudgetReport {
	profile: string;
	allowlistCount: number;
	advertisedCount: number;
	advertisedNames: string[];
	totalBytes: number;
	tokens: number;
	capTokens: number;
	over: boolean;
	estimator: string;
}

/** Read the advertise block from the omapilot profile mcp.json. */
async function readAdvertise(profilePath: string): Promise<AdvertiseConfig | undefined> {
	const raw = await fs.promises.readFile(profilePath, "utf8");
	const cfg = JSON.parse(raw) as { advertise?: AdvertiseConfig };
	return cfg.advertise;
}

/** Measure the advertised-tool token count for the omapilot profile. */
export async function measureBudget(
	profilePath: string,
): Promise<{ report: BudgetReport; advertised: AdvertiseFilterableTool[] }> {
	const advertise = await readAdvertise(profilePath);
	const allTools = buildMockTools();
	const advertised = filterAdvertisedMcpTools(allTools, advertise);
	const serialized = serializeAdvertised(advertised);
	const totalBytes = serialized.reduce((sum, t) => sum + Buffer.byteLength(JSON.stringify(t), "utf-8"), 0);
	const tokens = Math.ceil(totalBytes / 4);
	const allowlistCount = advertise?.tools?.length ?? 0;
	return {
		advertised,
		report: {
			profile: profilePath,
			allowlistCount,
			advertisedCount: advertised.length,
			advertisedNames: advertised.map(t => t.name).sort(),
			totalBytes,
			tokens,
			capTokens: 0,
			over: false,
			estimator: "chars/4 over JSON.stringify of per-tool {name, description, parameters}; tokens = ceil(bytes/4)",
		},
	};
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------
function usage(): never {
	process.stderr.write(
		"usage: bun run packages/coding-agent/scripts/prompt-budget.ts [--cap N] [--profile path] [--json] [--measure-only]\n",
	);
	process.exit(2);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	let cap: number | undefined;
	let profile = DEFAULT_PROFILE;
	let json = false;
	let measureOnly = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--cap") cap = Number(args[++i]);
		else if (a === "--profile") profile = args[++i];
		else if (a === "--json") json = true;
		else if (a === "--measure-only") measureOnly = true;
		else if (a === "--help" || a === "-h") usage();
		else usage();
	}
	if (cap !== undefined && !Number.isFinite(cap)) usage();

	const { report } = await measureBudget(profile);
	const capTokens = cap ?? DEFAULT_CAP_TOKENS;
	report.capTokens = capTokens;
	report.over = report.tokens > capTokens;

	if (json) {
		process.stdout.write(JSON.stringify(report, null, 2) + "\n");
	} else {
		process.stdout.write(
			`PLANES prompt-budget (omapilot profile)\n` +
			`  profile:          ${report.profile}\n` +
			`  allowlist entries: ${report.allowlistCount}\n` +
			`  advertised tools: ${report.advertisedCount}\n` +
			`  advertised names: ${report.advertisedNames.join(", ")}\n` +
			`  total bytes:      ${report.totalBytes}\n` +
			`  tokens (chars/4): ${report.tokens}\n` +
			`  cap tokens:       ${capTokens}\n` +
			`  estimator:        ${report.estimator}\n` +
			`  over cap:         ${report.over}\n`,
		);
	}

	if (measureOnly) {
		process.exit(0);
	}
	process.exit(report.over ? 1 : 0);
}

// Only run the CLI when this file is the entrypoint. When imported (e.g. by
// the unit test), `import.meta.main` is false and the module just exports.
if (import.meta.main) {
	await main();
}
