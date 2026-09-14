/**
 * PLANES G3c — prompt-budget unit test.
 *
 * Asserts the budget logic flags over-cap when the advertised token count
 * exceeds the cap, and that the shipped omapilot profile is within the frozen
 * cap. Uses the SHIPPED measureBudget (which calls filterAdvertisedMcpTools
 * from src/mcp/advertise.ts) against the shipped profile + mocked schemas.
 *
 * The over-cap exit path is verified by spawning the script with --cap 0 (any
 * non-empty advertised set exceeds 0) and asserting exit code 1 — this is the
 * CI guarantee the GHA workflow enforces. The script is self-contained (the
 * pi-natives mock is inlined), so no --preload is needed.
 *
 * Run: bun test packages/coding-agent/scripts/prompt-budget.test.ts
 */
import { describe, expect, mock, test } from "bun:test";
import * as path from "node:path";

// pi-natives mock — same pattern as advertise.test.ts. The budget path never
// calls native code, but the import chain loads the addon at module scope.
const absorb: unknown = new Proxy(() => ({}), {
	get: (_t, p) => (p === Symbol.toPrimitive ? () => 0 : absorb),
	construct: () => ({}),
	apply: () => ({}),
});
// scripts -> coding-agent -> packages -> packages/natives/native
const nativesDts = await Bun.file(
	path.resolve(import.meta.dir, "..", "..", "natives", "native", "index.d.ts"),
).text();
const nativesNames = [
	...nativesDts.matchAll(/export declare (?:class|function|const|enum|let|var) ([A-Za-z0-9_]+)/g),
].map(m => m[1]);
const nativesNs: Record<string, unknown> = {};
for (const n of nativesNames) nativesNs[n] = absorb;
mock.module("@oh-my-pi/pi-natives", () => nativesNs);

const { DEFAULT_CAP_TOKENS, measureBudget } = await import("./prompt-budget");

// scripts -> coding-agent -> packages -> repo root
const PROFILE = path.resolve(import.meta.dir, "..", "..", "..", ".omp", "profiles", "omapilot", "agent", "mcp.json");

describe("prompt-budget — G3c", () => {
	test("shipped omapilot profile advertises exactly the 7 allowlisted tools", async () => {
		const { report } = await measureBudget(PROFILE);
		expect(report.allowlistCount).toBe(7);
		expect(report.advertisedCount).toBe(7);
		expect(report.advertisedNames).toEqual([
			"mcp__facet_history_get",
			"mcp__facet_history_list",
			"mcp__hedron_hql",
			"mcp__lapis_neighbors",
			"mcp__lapis_search",
			"mcp__lapis_search_and_read",
			"mcp__lapis_tree_retrieve",
		]);
	});

	test("the advertised set is within the frozen cap (CI would pass)", async () => {
		const { report } = await measureBudget(PROFILE);
		expect(report.tokens).toBeLessThanOrEqual(DEFAULT_CAP_TOKENS);
		expect(report.tokens > DEFAULT_CAP_TOKENS).toBe(false);
	});

	test("over-cap exits non-zero: script spawned with --cap 0 expects exit 1", async () => {
		// Monkeypatch the cap to 0 by passing --cap 0; any advertised tool makes
		// the count (1149) exceed 0, so the script must exit 1. This is the
		// exact CI fail path the GHA workflow enforces.
		const script = path.resolve(import.meta.dir, "prompt-budget.ts");
		const proc = Bun.spawn({
			cmd: [process.execPath, script, "--cap", "0"],
			stdout: "ignore",
			stderr: "ignore",
		});
		const exitCode = await proc.exited;
		expect(exitCode).toBe(1);
	});

	test("within-cap exits zero: script spawned with the default cap expects exit 0", async () => {
		const script = path.resolve(import.meta.dir, "prompt-budget.ts");
		const proc = Bun.spawn({
			cmd: [process.execPath, script],
			stdout: "ignore",
			stderr: "ignore",
		});
		const exitCode = await proc.exited;
		expect(exitCode).toBe(0);
	});

	test("estimator is chars/4 and reproducible", async () => {
		const a = await measureBudget(PROFILE);
		const b = await measureBudget(PROFILE);
		expect(a.report.totalBytes).toBe(b.report.totalBytes);
		expect(a.report.tokens).toBe(b.report.tokens);
		expect(a.report.tokens).toBe(Math.ceil(a.report.totalBytes / 4));
		expect(a.report.estimator).toContain("chars/4");
	});
});
