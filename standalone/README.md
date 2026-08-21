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

With the standalone pet running, launch `连接Codex和OpenCode.cmd`, then restart Codex and OpenCode. The installer adds lifecycle hooks, the local OpenCode plugin, and a minimal chat-only Nori agent. The agent denies tool permissions; replace its prompt locally if you have permission to use a different character prompt.

The chat button is enabled only for `?standalone=1`, so existing DSH widget and pet behavior is unchanged.

Standalone chat keeps a scrollable history for the current app launch. The diary controls can summarize that history through OpenCode and save one Markdown diary per launch to a directory you choose, either manually or after one minute of inactivity. Recent diaries and an optional `Nori记忆.md` file in the same directory are supplied to later chat requests as untrusted reference memory.

Game commentary, diary summaries, and ordinary chat use separate internal OpenCode sessions. Internal game turns can drive the main thinking state without appearing as extra numbered task lamps.

Codex and OpenCode provide status and chat connections but do not host the DSH web widget; standalone therefore stays in desktop-pet mode.

## Troubleshooting

- `测试气泡.cmd` checks the authenticated local adapter path.
- The model panel can enable CPU rendering when a Windows GPU/driver combination flashes while moving a transparent window.
- Keep OpenCode running for chat. Long generations maintain a separate heartbeat while later messages wait in the local queue.
