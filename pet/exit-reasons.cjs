// Shared between the Electron shell and its DSH supervisor. Watchdog exits
// still use Electron's normal exit status; only the user's Quit action opts out
// of recovery. Keep this below 128 so POSIX and Windows preserve the same code.
exports.USER_QUIT_EXIT_CODE = 64
