/**
 * Advertise-filter for MCP tools.
 *
 * PLANES (foundry/omapilot/PLANES) keeps the model-facing tool list small by
 * advertising only an allowlist of connected MCP tools. Connected-but-hidden
 * tools stay available to `/mcp` humans; they never enter `customTools` or the
 * Qwen system-turn `# Tools` dump.
 *
 * This module is a pure filter. Wiring (`refreshMCPTools`, initial
 * `customTools`) is owned by fullstack and calls `filterAdvertisedMcpTools`.
 *
 * Law: [[foundry/omapilot/SPEC-planes]] G1.
 *   - `mode: "all"` or missing  → tools unchanged (stock omp behavior).
 *   - `mode: "allowlist"` + empty `tools[]` → ZERO tools (fail-closed).
 *   - Match `server` + `tool` after the same sanitizing omapi uses for `mcp__`
 *     names (`createMCPToolName`): lowercase, `[^a-z_]+` → `_`, redundant server
 *     prefix stripped, 64-char cap with deterministic hash suffix.
 *   - Unknown allowlist entries (matched no connected tool): warn, do not
 *     advertise extras.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { createMCPToolName } from "./tool-bridge";

/**
 * Allowlist entry. `server` and `tool` are matched against a connected tool's
 * origin (`mcpServerName` + `mcpToolName`) after `createMCPToolName`
 * sanitizing, so `"lapis"` / `"search-and-read"` and `"Lapis"` / `"search_and_read"`
 * both resolve to the same minted `mcp__lapis_search_and_read`.
 */
export interface AdvertiseAllowlistEntry {
	readonly server: string;
	readonly tool: string;
}

/**
 * Advertise configuration. Lives under `advertise` in mcp.json
 * (`packages/coding-agent/src/config/mcp-schema.json`).
 */
export interface AdvertiseConfig {
	/** `"all"` (default, stock behavior) or `"allowlist"` (filter). */
	readonly mode?: "all" | "allowlist";
	/** Allowlist entries. Ignored unless `mode === "allowlist"`. */
	readonly tools?: readonly AdvertiseAllowlistEntry[];
}

/**
 * Minimal shape `filterAdvertisedMcpTools` needs from a connected MCP tool.
 * Both `MCPTool` and `DeferredMCPTool` satisfy this: they expose the minted
 * registry `name` plus the raw `mcpServerName` / `mcpToolName` origin.
 */
export interface AdvertiseFilterableTool {
	/** Minted registry name (`mcp__<server>_<tool>`). */
	readonly name: string;
	/** Raw server name (pre-sanitizing). */
	readonly mcpServerName: string;
	/** Raw tool name (pre-sanitizing). */
	readonly mcpToolName: string;
}

/**
 * Default missing/`"all"` config to the no-op pass-through shape so the hot
 * path avoids re-allocating the input array.
 */
function isPassThrough(advertise: AdvertiseConfig | undefined | null): boolean {
	if (advertise === undefined || advertise === null) return true;
	return advertise.mode !== "allowlist";
}

/**
 * Mint the registry name an allowlist entry resolves to, using the exact same
 * sanitizing omapi applies to connected tools. Returns `null` only if both
 * parts sanitize to empty (the `fallback` paths in `createMCPToolName` cover
 * this, so in practice never `null`).
 */
function mintAllowlistName(entry: AdvertiseAllowlistEntry): string {
	return createMCPToolName(entry.server, entry.tool);
}

/**
 * Filter `tools` to the advertised allowlist.
 *
 * @param tools    Connected MCP tools (minted `.name`, raw origin fields).
 * @param advertise Advertise config from mcp.json. `undefined` / `null` /
 *                  `mode: "all"` / `mode` missing → tools returned unchanged.
 * @returns A new array (never the input reference) of advertised tools.
 *
 * Fail-closed: `mode: "allowlist"` with empty/missing `tools[]` returns `[]`.
 * Unknown allowlist entries (no connected tool matches) emit a single
 * `logger.warn` per entry; they never cause extras to be advertised.
 */
export function filterAdvertisedMcpTools<T extends AdvertiseFilterableTool>(
	tools: readonly T[],
	advertise: AdvertiseConfig | undefined | null,
): T[] {
	if (isPassThrough(advertise)) {
		// Stock omp: every connected tool is advertised.
		return [...tools];
	}

	const allowlist = advertise?.tools ?? [];
	if (allowlist.length === 0) {
		// Fail-closed: an allowlist mode with no entries advertises nothing.
		return [];
	}

	// Build the set of minted names the operator asked to advertise. Dedupe
	// entries that mint to the same name (e.g. hyphen vs underscore spelling)
	// so the unknown-entry warn fires once per distinct minted name.
	const allowedNames = new Set<string>();
	for (const entry of allowlist) {
		const minted = mintAllowlistName(entry);
		if (allowedNames.has(minted)) continue;
		allowedNames.add(minted);
	}

	// Keep only tools whose minted registry name is in the allowlist. Tools
	// carry their own minted `.name`, so we compare directly — sanitizing is
	// already baked into both sides by `createMCPToolName`.
	const matchedNames = new Set<string>();
	const kept: T[] = [];
	for (const tool of tools) {
		if (allowedNames.has(tool.name)) {
			matchedNames.add(tool.name);
			kept.push(tool);
		}
	}

	// Warn about unknown entries: the operator asked for a tool no connected
	// server provides. Do not advertise extras to compensate.
	for (const minted of allowedNames) {
		if (!matchedNames.has(minted)) {
			logger.warn("advertise: allowlist entry matched no connected MCP tool", { minted });
		}
	}

	return kept;
}
