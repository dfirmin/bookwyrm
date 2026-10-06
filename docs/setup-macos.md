# Setting up Bookwyrm on macOS

For an Apple Silicon Mac (M1–M4) on macOS 14 Sonoma or later.

- **Part 1** (about 15 minutes): Hermes and the Bookwyrm profile. Text chat in the terminal.
- **Part 2** (about 15 minutes, mostly downloading): the Bookwyrm companion. The dragon on the
  edge of your screen that you call and talk to.

You need: your Anthropic API key, and a fine-grained GitHub token scoped to the knowledge repo
only (Contents, Issues, Pull requests: read and write).

# Part 1: Hermes and the Bookwyrm profile

## 1. Install Hermes

Open **Terminal** and run:

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

Close Terminal and open a new window, then check:

```bash
hermes --version
```

When the installer's setup asks which AI provider to use, you don't need a Nous account: pick
Anthropic and paste your key, or skip it. Bookwyrm has its own settings. If it asks about running
on your machine or in Docker, choose your machine.

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

# Part 2: the Bookwyrm companion

## 7. Get the latest Bookwyrm and Node.js

```bash
cd ~/bookwyrm && git pull
node --version
```

You need **v22.12 or newer** (the app's Electron requires it). If `node` isn't found or is older,
install **Node 22 LTS** from [nodejs.org](https://nodejs.org) (the macOS installer), then open a
new Terminal window. If an earlier attempt failed with `ERR_REQUIRE_ESM`, delete
`~/bookwyrm/app/node_modules` before step 8.

## 8. Set up the voice

```bash
cd ~/bookwyrm
./scripts/setup-voice.sh --caller "Dee Firmin, Data Engineering" --repo dfirmin/archivist-knowledge-01
```

Use your own name and team for `--caller`: it's how Bookwyrm greets you and knows who's on the
call. `--repo` is only needed if you want Bookwyrm to be able to call you (step 11). The script:

- installs the voice service into `voice/.venv`;
- turns on Hermes' local API for the Bookwyrm profile and restarts Hermes' background service;
- downloads the speech models once (~1 GB, from GitHub), which is the slow part;
- builds the companion app.

It finishes with a "One thing needs attention" note if anything went wrong, with the fix.

## 9. Start Bookwyrm

```bash
cd ~/bookwyrm/app && npm start
```

The dragon appears at the bottom right of your screen and stays on top of other windows. macOS
asks for **microphone** access the first time: allow it. (In this development build the app shows
up as "Electron" in the permission prompt.)

## 10. Call it

**Click the dragon.** It rings, picks up and says hello. Then just talk.

- **Interrupt it** by talking over it. It stops and listens.
- **Mute**, **Type** (send a written message mid-call) and **Hang up** are on the card. Esc also
  hangs up.
- After a call, click the dragon (or **Close**) to put the card away.
- Wait for the hello before you start talking: speech over Bookwyrm's own voice can lose its
  first words.
- **Headphones are best for the first few calls.** On the laptop's speakers, Bookwyrm relies on
  macOS echo cancellation not to hear itself. If it ever cuts itself off, tell me; that's the one
  thing that couldn't be tested from the cloud.

## 11. Let Bookwyrm call you (optional)

**Right-click the dragon** → *Let Bookwyrm call me about new quarantine and gaps*. When a new
document lands in quarantine or a new gap is filed, the dragon rings and the card says why;
**Answer** or **Not now**. It checks every five minutes, only calls about things that are new
since you switched it on, and never about the backlog. Right-click again to switch it off.

## If something's off

| Symptom | Try |
|---|---|
| "I can't reach the repo" | Step 5; check the token in `.env` and that it covers the repo |
| Card says it can't reach the voice service | Re-run step 8; check `~/bookwyrm/voice/.venv` exists |
| Card says Bookwyrm's brain isn't running | `hermes gateway restart`, then try again |
| Card says it's still loading its voice | The first start after setup loads ~1 GB of models; give it a minute |
| No sound from Bookwyrm | Check the Mac's output device; the card's captions show what it's saying |
| It cuts itself off on speakers | Use headphones, and tell me |
| Changed something in this repo | `git pull`, re-run steps 3 and 8, then `npm start` again |
