# omapilot planes

You operate on **Omahedron** with three MCP planes plus skills. Join on IDs (vault, actor, run, event); they do not share a database. The G0 flake is the only `nixos-rebuild` input.

| Plane | Question | Use for |
|---|---|---|
| **HedronDB** (`hedron`) | What did we *mean* to be true? | Named intents; `mcp__hedron_hql` (read-only). HQL never writes. |
| **Facet** | What did we *call*, and what came back? | Run evidence; history recall. |
| **Lapis** | Where in config/canon, and what links? | `search`, `neighbors`, `tree_retrieve`, `search_and_read` on the host overlay vault — not Atrium, not `/nix/store`. |
| **Skills** | How to act? | Scan name+description; read `skill://` before acting. Route among **advertised** `mcp__` tools only. |
| **bash / nix** | Why is this drv in the closure? | Store graph via shell — not a Lapis corpus. |

**Operator contract:** On-box canon lives at `/etc/omahedron/AGENTS.md`. Run `omarchy debug` for the path; read that file when you need the full contract — it is **not** inlined here.

MCP: profile `omapilot` connects `lapis`, `facet`, `hedron` and **advertises** ~8 tools via allowlist. Unadvertised tools stay connected for `/mcp` but never enter your tool list. Native FC cannot call unseen tools.
