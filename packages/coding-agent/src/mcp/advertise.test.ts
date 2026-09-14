/**
 * Unit tests for the advertise-filter (PLANES G1).
 *
 * Law: [[foundry/omapilot/SPEC-planes]] G1c.
 *   - MUST call the shipped `filterAdvertisedMcpTools`.
 *   - 20-tool fixture: allowlist subset matches; empty allowlist → []; mode
 *     `all` → all remain.
 *   - No hard-coded expected names that skip the function: expected names are
 *     minted through `createMCPToolName` (the same sanitizer the filter uses)
 *     so the test asserts behavior, not a baked string list.
 */
/**
 * Unit tests for the advertise-filter (PLANES G1).
 *
 * Law: [[foundry/omapilot/SPEC-planes]] G1c.
 *   - MUST call the shipped `filterAdvertisedMcpTools`.
 *   - 20-tool fixture: allowlist subset matches; empty allowlist → []; mode
 *     `all` → all remain.
 *   - No hard-coded expected names that skip the function: expected names are
 *     minted through `createMCPToolName` (the same sanitizer the filter uses)
 *     so the test asserts behavior, not a baked string list.
 *
 * pi-natives is mocked: the advertise-filter path never calls native code, but
 * the import chain (tool-bridge -> pi-utils / pi-ai) loads the native addon at
 * module scope, and the Rust addon is not built on apiary. Mock satisfies
 * imports only — same approach as the G0 fixture driver.
 */
import { afterEach, describe, expect, it, mock, vi } from "bun:test";

// Absorb any access/call/construct — import-time stand-in for pi-natives.
const absorb: unknown = new Proxy(() => ({}), {
	get: (_t, p) => (p === Symbol.toPrimitive ? () => 0 : absorb),
	construct: () => ({}),
	apply: () => ({}),
});

// Bun validates named imports against the mock's keys, so mirror the real
// export surface from the package .d.ts (values never actually run on this
// path).
const nativesDts = await Bun.file(
	`${import.meta.dir}/../../../natives/native/index.d.ts`,
).text();
const nativesNames = [
	...nativesDts.matchAll(/export declare (?:class|function|const|enum|let|var) ([A-Za-z0-9_]+)/g),
].map(m => m[1]);
const nativesNs: Record<string, unknown> = {};
for (const n of nativesNames) nativesNs[n] = absorb;
mock.module("@oh-my-pi/pi-natives", () => nativesNs);

import type { AdvertiseFilterableTool } from "./advertise";

const { logger } = await import("@oh-my-pi/pi-utils");
const { createMCPToolName } = await import("./tool-bridge");
const { filterAdvertisedMcpTools } = await import("./advertise");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal tool shape satisfying `AdvertiseFilterableTool`. Real `MCPTool` /
 * `DeferredMCPTool` carry more fields, but the filter only reads `name`,
 * `mcpServerName`, `mcpToolName` — so a plain object is a faithful stand-in.
 */
function makeTool(server: string, tool: string): AdvertiseFilterableTool {
	return {
		name: createMCPToolName(server, tool),
		mcpServerName: server,
		mcpToolName: tool,
	};
}

/** 20-tool server mirroring the G0 `fixture-large` shape (tool_aa .. tool_at). */
function makeLargeServer(server: string, count: number): AdvertiseFilterableTool[] {
	const tools: AdvertiseFilterableTool[] = [];
	for (let i = 0; i < count; i++) {
		// G0 spelling: tool_aa, tool_ab, ... tool_at (second letter increments).
		const suffix = "a" + String.fromCharCode(97 + (i % 26));
		tools.push(makeTool(server, `tool_${suffix}`));
	}
	return tools;
}

const LARGE_SERVER = "fixture-large";
const SMALL_SERVER = "fixture-small";
const LARGE_TOOLS = makeLargeServer(LARGE_SERVER, 20);
const SMALL_TOOLS = [
	makeTool(SMALL_SERVER, "list"),
	makeTool(SMALL_SERVER, "read"),
	makeTool(SMALL_SERVER, "search"),
	makeTool(SMALL_SERVER, "status"),
];
const ALL_TOOLS = [...LARGE_TOOLS, ...SMALL_TOOLS];

afterEach(() => {
	vi.restoreAllMocks();
});

function spyWarn(): ReturnType<typeof vi.spyOn> {
	return vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
}

// ---------------------------------------------------------------------------
// mode: "all" / missing — stock omp pass-through
// ---------------------------------------------------------------------------

describe("filterAdvertisedMcpTools — pass-through", () => {
	it("returns all tools when mode is 'all'", () => {
		const kept = filterAdvertisedMcpTools(ALL_TOOLS, { mode: "all", tools: [] });
		expect(kept).toHaveLength(ALL_TOOLS.length);
		// Same set of minted names, order preserved.
		expect(kept.map(t => t.name)).toEqual(ALL_TOOLS.map(t => t.name));
	});

	it("returns all tools when mode is missing", () => {
		const kept = filterAdvertisedMcpTools(ALL_TOOLS, { tools: [{ server: LARGE_SERVER, tool: "tool_aa" }] });
		expect(kept).toHaveLength(ALL_TOOLS.length);
		expect(kept.map(t => t.name)).toEqual(ALL_TOOLS.map(t => t.name));
	});

	it("returns all tools when config is undefined", () => {
		const kept = filterAdvertisedMcpTools(ALL_TOOLS, undefined);
		expect(kept).toHaveLength(ALL_TOOLS.length);
	});

	it("returns all tools when config is null", () => {
		const kept = filterAdvertisedMcpTools(ALL_TOOLS, null);
		expect(kept).toHaveLength(ALL_TOOLS.length);
	});

	it("does not mutate the input array reference (returns a copy)", () => {
		const kept = filterAdvertisedMcpTools(ALL_TOOLS, { mode: "all" });
		expect(kept).not.toBe(ALL_TOOLS);
		expect(kept).toEqual(ALL_TOOLS);
	});
});

// ---------------------------------------------------------------------------
// mode: "allowlist" — fail-closed
// ---------------------------------------------------------------------------

describe("filterAdvertisedMcpTools — fail-closed", () => {
	it("returns ZERO tools when allowlist is empty", () => {
		const warn = spyWarn();
		const kept = filterAdvertisedMcpTools(ALL_TOOLS, { mode: "allowlist", tools: [] });
		expect(kept).toEqual([]);
		// Empty allowlist is the operator's stated intent, not an unknown entry;
		// no warn fires.
		expect(warn).not.toHaveBeenCalled();
	});

	it("returns ZERO tools when tools array is missing", () => {
		const kept = filterAdvertisedMcpTools(ALL_TOOLS, { mode: "allowlist" });
		expect(kept).toEqual([]);
	});

	it("returns ZERO tools even when 24 are connected (no leak through)", () => {
		const kept = filterAdvertisedMcpTools(ALL_TOOLS, { mode: "allowlist", tools: [] });
		expect(kept).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// mode: "allowlist" — subset matching
// ---------------------------------------------------------------------------

describe("filterAdvertisedMcpTools — subset", () => {
	it("advertises only the allowlisted subset of the 20-tool server", () => {
		// Pick three real tools by their raw names; mint expected names through
		// the same sanitizer the filter uses.
		const wanted = ["tool_aa", "tool_ab", "tool_at"];
		const allowlist = wanted.map(tool => ({ server: LARGE_SERVER, tool }));
		const kept = filterAdvertisedMcpTools(ALL_TOOLS, { mode: "allowlist", tools: allowlist });
		const expectedNames = wanted.map(t => createMCPToolName(LARGE_SERVER, t));
		expect(kept.map(t => t.name).sort()).toEqual(expectedNames.sort());
		expect(kept).toHaveLength(3);
	});

	it("advertises a single tool from a 20-tool server (no extras leak)", () => {
		const allowlist = [{ server: LARGE_SERVER, tool: "tool_am" }];
		const kept = filterAdvertisedMcpTools(LARGE_TOOLS, { mode: "allowlist", tools: allowlist });
		expect(kept).toHaveLength(1);
		expect(kept[0].name).toBe(createMCPToolName(LARGE_SERVER, "tool_am"));
	});

	it("advertises across servers (lapis + facet + hedron projected shape)", () => {
		// Mirror the G0 projected allowlist shape without depending on live
		// servers: build local fixtures with those server names.
		const lapis = [makeTool("lapis", "search"), makeTool("lapis", "neighbors")];
		const facet = [makeTool("facet", "history_list"), makeTool("facet", "history_get")];
		const hedron = [makeTool("hedron", "hql")];
		const tools = [...lapis, ...facet, ...hedron];
		const allowlist = [
			{ server: "lapis", tool: "search" },
			{ server: "lapis", tool: "neighbors" },
			{ server: "facet", tool: "history_list" },
			{ server: "facet", tool: "history_get" },
			{ server: "hedron", tool: "hql" },
		];
		const kept = filterAdvertisedMcpTools(tools, { mode: "allowlist", tools: allowlist });
		expect(kept).toHaveLength(5);
		expect(kept.map(t => t.name).sort()).toEqual(
			allowlist.map(e => createMCPToolName(e.server, e.tool)).sort(),
		);
	});

	it("preserves input order of the kept tools", () => {
		const allowlist = [
			{ server: SMALL_SERVER, tool: "search" },
			{ server: LARGE_SERVER, tool: "tool_aa" },
		];
		const kept = filterAdvertisedMcpTools(ALL_TOOLS, { mode: "allowlist", tools: allowlist });
		// ALL_TOOLS is [large..., small...]; tool_aa precedes search in input.
		expect(kept.map(t => t.name)).toEqual([
			createMCPToolName(LARGE_SERVER, "tool_aa"),
			createMCPToolName(SMALL_SERVER, "search"),
		]);
	});
});

// ---------------------------------------------------------------------------
// Sanitizing — hyphen → underscore, case-insensitive
// ---------------------------------------------------------------------------

describe("filterAdvertisedMcpTools — sanitizing", () => {
	it("matches an allowlist entry spelled with hyphens to a tool minted with underscores", () => {
		// Live tool name is `tool_aa` on `fixture-large` → minted
		// `mcp__fixture_large_tool_aa`. Operator writes hyphens; both sides
		// sanitize to the same minted name.
		const allowlist = [{ server: "fixture-large", tool: "tool-aa" }];
		const kept = filterAdvertisedMcpTools(LARGE_TOOLS, { mode: "allowlist", tools: allowlist });
		expect(kept).toHaveLength(1);
		expect(kept[0].name).toBe("mcp__fixture_large_tool_aa");
	});

	it("matches a mixed-case allowlist entry to a lowercase tool", () => {
		const allowlist = [{ server: "Fixture-Large", tool: "Tool_AA" }];
		const kept = filterAdvertisedMcpTools(LARGE_TOOLS, { mode: "allowlist", tools: allowlist });
		expect(kept).toHaveLength(1);
		expect(kept[0].name).toBe("mcp__fixture_large_tool_aa");
	});

	it("dedupes allowlist entries that mint to the same name", () => {
		// Two spellings, one minted name. The kept list has one tool; the
		// duplicate does not double-advertise.
		const allowlist = [
			{ server: "fixture-large", tool: "tool_aa" },
			{ server: "fixture_large", tool: "tool-aa" },
		];
		const kept = filterAdvertisedMcpTools(LARGE_TOOLS, { mode: "allowlist", tools: allowlist });
		expect(kept).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Unknown allowlist entries — warn, no extras
// ---------------------------------------------------------------------------

describe("filterAdvertisedMcpTools — unknown entries", () => {
	it("warns once per unknown entry and advertises no extras", () => {
		const warn = spyWarn();
		const allowlist = [
			{ server: LARGE_SERVER, tool: "tool_aa" },
			{ server: LARGE_SERVER, tool: "tool_zz" }, // not connected
			{ server: "ghost", tool: "nope" }, // server not connected
		];
		const kept = filterAdvertisedMcpTools(ALL_TOOLS, { mode: "allowlist", tools: allowlist });
		expect(kept).toHaveLength(1);
		expect(kept[0].name).toBe(createMCPToolName(LARGE_SERVER, "tool_aa"));
		// Two unknowns → two warns.
		expect(warn).toHaveBeenCalledTimes(2);
		for (const call of warn.mock.calls) {
			const payload = call[1] as { minted: string } | undefined;
			expect(payload).toBeDefined();
			expect(["mcp__fixture_large_tool_zz", "mcp__ghost_nope"]).toContain(payload!.minted);
		}
	});

	it("does not warn when every entry matches a connected tool", () => {
		const warn = spyWarn();
		const allowlist = [
			{ server: LARGE_SERVER, tool: "tool_aa" },
			{ server: SMALL_SERVER, tool: "search" },
		];
		filterAdvertisedMcpTools(ALL_TOOLS, { mode: "allowlist", tools: allowlist });
		expect(warn).not.toHaveBeenCalled();
	});

	it("does not advertise an extra to compensate for an unknown entry", () => {
		const allowlist = [{ server: LARGE_SERVER, tool: "tool_zz" }];
		const kept = filterAdvertisedMcpTools(LARGE_TOOLS, { mode: "allowlist", tools: allowlist });
		expect(kept).toEqual([]);
	});
});
