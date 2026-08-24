# Standalone desktop companion

This directory runs the desktop pet without DeepSeek Harness. It reuses the repository's `public/` renderer and stores imported models and settings in Electron's user-data directory.

## License boundary

The standalone source does not distribute Live2D models, `live2dcubismcore.min.js`, Electron binaries, API keys, or third-party character prompts. Supply these items yourself under their respective licenses.

## Setup on Windows

1. Install Node.js 18 or later.
2. Obtain `live2dcubismcore.min.js` from Live2D's official distribution and place it in `public/vendor/`.
3. Run `standalone/setup.cmd`, then `standalone/start.cmd`.
4. On first launch, copy a complete Cubism 4/5 model folder into the model directory shown by the app.

The local server binds to a random `127.0.0.1` port. Mutating browser routes use a random HttpOnly cookie; Codex/OpenCode adapters use a separate per-launch bearer token stored in Electron's user-data directory.

## Codex and OpenCode

With the standalone pet running, launch `连接Codex和OpenCode.cmd`, then restart Codex and OpenCode. The installer adds lifecycle hooks, the local OpenCode plugin, and a minimal chat-only `live2d-companion` agent. The agent denies tool permissions. Customize its local prompt for the character you use; repeated installs preserve that customized prompt. Advanced users can select another agent with the `L2D_COMPANION_AGENT` environment variable before starting OpenCode.

The chat button is enabled only for `?standalone=1`, so existing DSH widget and pet behavior is unchanged.

Standalone chat keeps a scrollable history for the current app launch. Each imported model receives a character profile, and one model can have multiple profiles. Open the model panel's **角色** tab to name the character, paste or import a Markdown/TXT persona, import existing diary or memory files, and enable optional one-minute auto-save.

Profiles live under Electron's user-data directory rather than inside the model folder. Each profile owns its own `persona.md`, indexed `memories/`, and `diaries/` directory, so switching models or profiles does not mix identities or memories. New memories are stored separately, assigned a coarse category, and de-duplicated by a normalized content hash. Existing `memory.md` files remain readable as legacy memory. Manual and automatic diary summaries update one `diary-*.md` file per app launch; imported diary files remain separate.

The built-in local memory provider removes common query words, weights longer matches, ranks small chunks against the newest user message, and sends at most four related results (up to 1,200 characters) to OpenCode. Recalled text is explicitly treated as untrusted reference data and is placed before the newest message. The provider boundary is intentionally independent from the OpenCode/Codex adapters so a future plugin or MCP memory backend can be added without making this repository character-specific.

Profiles can optionally enable **OpenCode semantic reranking (experimental)**. The bundled OpenCode companion plugin asks the selected OpenCode model to choose up to four items from a bounded local candidate set, then injects only those items into chat. This costs one additional model request when candidates exist. Invalid output, timeouts, disconnection, or plugin errors fall back to the deterministic local result; no third-party memory service is required.

Game commentary, diary summaries, and ordinary chat use separate internal OpenCode sessions. Internal game turns can drive the main thinking state without appearing as extra numbered task lamps.

Codex and OpenCode provide status and chat connections but do not host the DSH web widget; standalone therefore stays in desktop-pet mode.

## Troubleshooting

- `测试气泡.cmd` checks the authenticated local adapter path.
- The model panel can enable CPU rendering when a Windows GPU/driver combination flashes while moving a transparent window.
- Keep OpenCode running for chat. Long generations maintain a separate heartbeat while later messages wait in the local queue.
