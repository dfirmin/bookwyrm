# Setting up Bookwyrm on macOS

For an Apple Silicon Mac (M1–M4) on macOS 14 Sonoma or later. Takes about 20 minutes.

> **Intel Mac?** Stop here and say so in an issue. Hermes' desktop app is Apple Silicon only,
> and its local speech-to-text and Piper voice are not available on Intel. Text chat still works
> from the terminal.

You need: your Anthropic API key, and a fine-grained GitHub token scoped to the knowledge repo
only (Contents, Issues, Pull requests: read and write).

## 1. Install Hermes

Open **Terminal** and run:

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

Close Terminal and open a new window, then check:

```bash
hermes --version
```

Then download the **Hermes desktop app** for macOS from
[hermes-agent.nousresearch.com](https://hermes-agent.nousresearch.com/), open the DMG and drag
`Hermes.app` into Applications. Don't open it yet. The app and the `hermes` command share the
same settings.

## 2. Install the GitHub server for Bookwyrm

```bash
mkdir -p ~/bin && cd ~/bin
curl -fsSL -o ghmcp.tgz https://github.com/github/github-mcp-server/releases/latest/download/github-mcp-server_Darwin_arm64.tar.gz
tar xzf ghmcp.tgz github-mcp-server && rm ghmcp.tgz
~/bin/github-mcp-server --version
```

## 3. Install Bookwyrm

```bash
cd ~ && git clone https://github.com/dfirmin/bookwyrm.git
cd ~/bookwyrm
./scripts/install.sh --repo dfirmin/archivist-knowledge-01 --github-mcp-bin ~/bin/github-mcp-server
```

## 4. Add your keys

```bash
open -e ~/.hermes/profiles/bookwyrm/.env
```

Fill in the two lines and save:

```
GITHUB_PERSONAL_ACCESS_TOKEN=github_pat_...
ANTHROPIC_API_KEY=sk-ant-...
```

## 5. Check it can reach the repo

```bash
hermes -p bookwyrm mcp test github
```

You want `✓ Connected` and a list of tools. If it says the **`mcp` Python SDK is not
installed**, run `hermes -p bookwyrm setup`, turn on MCP support, and run the test again.

## 6. Try it in text first

```bash
hermes -p bookwyrm chat
```

Ask: *"What's in the bundle right now?"* It should read `index.md` and tell you. Type `/exit`
to leave. (A `Warning: Unknown toolsets: mcp-github` line at start-up is harmless.)

## 7. Open the desktop app on the Bookwyrm profile

Open **Hermes** from Applications. If it starts an onboarding screen, choose to use your
existing installation. Then switch to the **bookwyrm** profile (the profile rail on the left,
or Settings → Profiles). Send one typed message to confirm it answers.

macOS will ask for **microphone** access the first time you use voice: allow it.

## 8. Talk to it

- **Push to talk:** click the microphone in the message box, speak, pause. The first time, Hermes
  downloads the speech model and the Piper voice (a minute or two).
- **Conversation:** use the voice-conversation button to the right of the mic. Bookwyrm answers
  aloud. Say **"stop"** (or "thanks bookworm") to end.
- **Wake word:** hover the mic and click the **ear** so it's solid. From any app, say
  **"hey bookworm"**, then your question. The first time, it downloads a small model (~13 MB).

## 9. Put it in the corner

1. Pick a mascot: Settings → Appearance → Pet (any for now; a Bookwyrm dragon comes later).
2. **Shift-click** the pet. It pops out of the window as a floating, always-on-top sprite.
3. Drag it to the bottom-right of your screen. It stays there across restarts.

From the corner: **click** to type a question, **double-click** to open or hide the full chat,
or just say **"hey bookworm"**.

## If something's off

| Symptom | Try |
|---|---|
| "I can't reach the repo" | Step 5; check the token in `.env` and that it covers the repo |
| Wake word never fires | Speak a little slower; Settings → Voice, lower the wake sensitivity; check the mic picked is the one you're using |
| Fires when you didn't say it | Raise the sensitivity |
| It mishears names | `stt.local.model: "small"` in `~/.hermes/profiles/bookwyrm/config.yaml` |
| Changed something in this repo | `git pull` then re-run the step 3 install command |
