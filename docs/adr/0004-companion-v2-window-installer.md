# 0004 — The robot, the Bookwyrm window, one-line install on macOS and Windows

Status: proposed, 2026-10-06. Builds on [0003](0003-voice-companion.md).

## Context

The first companion did what it was for (call it, it rings, it talks), but the owner's first
week with it surfaced five problems:

1. It couldn't be moved, so it covered things.
2. There was no obvious way to close it; it lived until the terminal that started it closed.
3. Setup was eleven terminal steps.
4. Clicking it dialled straight away. Settings like the caller and repo were command-line flags,
   and there was nowhere to see past conversations.
5. The dragon stood out on a work desktop.

On top of that, Bookwyrm should also run on Windows. Hermes runs natively there
(`%LOCALAPPDATA%\hermes`), as do the speech engines, WebRTC and Electron.

## Decision

1. **A small robot, drawn in the OS's own terms.**
   - The companion is a 64-point aluminium robot (space grey in dark mode). Its eyes and its
     bookmark ribbon take the user's system accent colour, which Electron reads on macOS and
     Windows.
   - The card uses the system font and the system's light and dark colours, with call buttons
     and message bubbles in the style of FaceTime and Messages.
   - Motion is reserved for state: a blink when idle, a shake and antenna light when ringing,
     wide eyes when listening, a mouth that follows its voice when speaking.
2. **Drag anywhere; click for a menu.**
   - Dragging is done by the main process following the cursor. That stays smooth even when
     the window is moved under the pointer.
   - The position is kept in `~/.bookwyrm/companion.json`, and the robot is pulled back on
     screen when displays change.
   - The card opens toward the middle of the screen, whichever corner the robot is in.
   - A click opens a native menu: Call, Send a message, Open Bookwyrm, Library, Let Bookwyrm
     call me, Hide robot, Quit. Native menus look right on each OS for free. During a call, the
     menu offers Hang up and Mute instead.
3. **Always a way out.**
   - A menu-bar icon (a template image on macOS) or tray icon (Windows, Linux) has Quit, Show
     robot, Call and Settings.
   - Bookwyrm is single-instance, so opening it again from Applications or the Start menu opens
     its window.
   - Quitting stops the voice service it started.
4. **The Bookwyrm window instead of a chat platform.** OpenWebUI and Jan were options, but each
   is a second app with its own accounts, model settings and storage, and neither knows about
   calls, the knowledge repo or Bookwyrm's setup. The window is a page of the same Electron app:
   - **Conversations.** Each conversation's id is its Hermes session id, so reopening one and
     typing, or pressing Call, carries on the same Hermes session. History lives in
     `~/.bookwyrm/history.db` (SQLite): only what the app lists. Hermes keeps its own memory as
     before (ADR 0001).
   - **Library.** Quarantine and gap issues, classified the same way the call-you watcher
     classifies them, plus open pull requests tagged Bookwyrm, Archivist or People. Each has
     *Ask Bookwyrm*.
   - **Settings.** Name, team and voice are in `~/.bookwyrm/settings.json`; the keys stay in the
     Hermes profile's `.env`. Changing the repo or a key re-runs the setup wizard's `profile`,
     `api`, `check` and `settings` steps with Electron's own Node, so it works without a
     terminal. Keys travel to it in the environment, never on a command line.
   - macOS vibrancy and Windows Mica give the sidebar the OS material.
5. **One line to install.**
   - The commands are `install.sh` (`curl … | bash`) and `install.ps1` (`irm … | iex`).
   - Each fetches a checksum-verified Node 22 into `~/.bookwyrm/node` when needed, then gets
     the source, then runs an **Ink** wizard in `setup/`.
   - The wizard asks four things, checks the keys live, then works through a re-runnable
     checklist (uv, Hermes, GitHub MCP, profile, Hermes API, connection check, voice, models,
     app, launcher, settings) with retry, skip or quit on failure.
   - The launcher is an `Applications` wrapper app on macOS (with a microphone usage
     string), a Start-menu shortcut on Windows and a `.desktop` file on Linux. "Open at login"
     uses a LaunchAgent, a Startup-folder shortcut or an autostart file respectively, so it works
     without a packaged, signed build.
6. **CI on all three systems.**
   - GitHub Actions runs the real one-line installers on macOS (Apple Silicon), Windows
     (Windows PowerShell 5.1) and Linux.
   - It then runs: the installer, launcher and voice unit tests; a speech round trip (Kokoro
     speaks, Parakeet hears); start-up of the voice service; a smoke test of the app's main
     process (shapes, drag, clamping, window, hide and show); and native screenshots.
   - Hermes and GitHub need real keys, so those stay in `docs/live-proof`.

## Consequences

- Nothing is code-signed. The app runs from the user's own install (Electron from npm, wrapped
  or shortcut), so there's no download quarantine or SmartScreen prompt. A packaged, signed
  build for wider rollout is separate work.
- The macOS wrapper launches Electron. The microphone prompt should name Bookwyrm, but whether
  it does is only verifiable on a Mac.
- Linux desktops without a tray (stock GNOME) still have the robot's own menu, which has Quit.
- The voice service now reads settings live, so voice, speed and calls-you changes apply
  without a restart. The repo and keys go through setup because they change the Hermes profile.
