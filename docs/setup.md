# Bookwyrm: install, use, fix, remove

For macOS 14 or later (Apple Silicon or Intel), Windows 10 or 11, and Linux desktops.

## Before you start

You need two keys. Setup asks for both and checks them before going on.

- **A way to reach Claude**, either of:
  - **an Anthropic API key**, from
    [console.anthropic.com](https://console.anthropic.com/settings/keys); or
  - **your company's gateway** (LiteLLM, or another OpenAI-compatible endpoint): its address
    (usually ending in `/v1`), the model name it uses for Claude, and your key for it. Ask
    whoever runs the gateway.
- **A fine-grained GitHub token for the knowledge repo.** Make one at
  [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new).
  - Under *Repository access*, choose *Only select repositories* and pick the knowledge repo.
    No other repo.
  - Under *Permissions*, set **Contents**, **Issues** and **Pull requests** to *Read and write*.
    Nothing else.

  This token is the real limit on what Bookwyrm can touch.
- **Merging.** When you approve a change in Bookwyrm, it opens a pull request and merges it for
  you. If the knowledge repo's `main` is protected (it should be), add the people who approve in
  Bookwyrm to the protection's **bypass list**; otherwise the pull request waits for a reviewer
  (Bookwyrm tells you when that happens).

## Install

**On a Mac**, open **Terminal** (press ⌘ Space and type "Terminal"), paste this line and press Return:

```bash
curl -fsSL https://raw.githubusercontent.com/dfirmin/bookwyrm/main/install.sh | bash
```

**On Windows**, open **PowerShell** from the Start menu, paste this line and press Enter:

```powershell
irm https://raw.githubusercontent.com/dfirmin/bookwyrm/main/install.ps1 | iex
```

A setup wizard opens in that window. It asks for:

- your name and team, so Bookwyrm knows who it's talking to;
- which knowledge repo to look after, picked from the repos Archivist runs on (its registry).
  Test repos are hidden unless you ask to see them, and repos your GitHub token can't reach are
  marked;
- the two keys.

Then it installs everything, ticking off each step as it goes:

- Hermes, Bookwyrm's brain;
- the GitHub connection;
- Bookwyrm's own settings;
- the voice, including about 1 GB of speech models (the slow part);
- the app itself.

On a Mac or Windows it doesn't need administrator rights and changes nothing outside your user
account (some Linux distributions ask for your password once, for a system library). If a step
fails, it tells you why and lets you retry or skip it.

At the end, setup asks whether Bookwyrm should start when you log in, then opens it. After that,
Bookwyrm is in **Applications** on a Mac, and in the **Start menu** on Windows.

The first time you call on a Mac, macOS asks whether Bookwyrm can use the microphone. Choose
**Allow**.

## Using it

The robot sits at the bottom right of your screen and stays on top of other windows.

- **Move it:** drag it anywhere. It remembers where you left it, and its card opens toward the
  middle of the screen.
- **Click it** for its menu:
  - **Call Bookwyrm.** It rings, picks up and says hello. Then talk. Interrupt it whenever you
    like: it stops and listens.
  - **Send a message.** Type instead of talking. Replies appear on the card.
  - **Open Bookwyrm.** The full window (below).
  - **Library.** What needs you in the repo (the window's Gaps page).
  - **Let Bookwyrm call me.** See below.
  - **Hide robot.** Bookwyrm keeps running (it can still call you). To bring the robot back, press
    **⌃⌥B** (Ctrl+Alt+B on Windows), open Bookwyrm again from Spotlight, Applications or the
    Start menu, or use its menu-bar / tray icon. Quitting and reopening always brings it back.
  - **Quit Bookwyrm.**
- **During a call**, the card has these buttons:
  - **mute**;
  - **type** (send a written message mid-call);
  - **open** (the conversation in the Bookwyrm window);
  - the red **hang up** button. **Esc** also hangs up.
- **After a call**, the card has these choices:
  - type to carry on in writing;
  - press the green button to call again;
  - close it with ×.

Wait for the hello before you start talking: words spoken over Bookwyrm's own voice can get
lost. **Headphones are best** for the first few calls. On laptop speakers, the system's echo
cancellation is what keeps Bookwyrm from hearing itself. If it ever cuts itself off, say so in
an issue.

### The Bookwyrm window

- **Conversations.** Every call and typed chat, newest first, with search. Double-click one to
  rename it; hover over it to delete it. Open one and type to carry on. **Call** carries on by
  voice, and Bookwyrm remembers what you were discussing.
- **The document beside the conversation.** When Bookwyrm changes a document (by text or on a
  call), it opens here rendered, with what changed highlighted: new words in green, removed ones
  struck through. **Approve** or **Discard** each one; for a change across many documents, step
  through them (**‹ 3 of 12 ›**) or **Approve all**. When nothing is left to look at, Bookwyrm opens
  the pull request and merges it, and closes any gap it resolved. Nothing reaches GitHub until you
  approve it. The **edits to review** button in the toolbar takes you back to anything waiting.
- **Knowledge.** The repo's documents. Open one to read it rendered; **Ask Bookwyrm** talks about
  it ("fix this section"); **Edit** lets you change it yourself, like a word processor. **Save**
  publishes it straight away, and Bookwyrm says if anything about it is worth a second look.
- **Gaps.** Open gaps, yours first: pick the labels that mean "yours" (your team, your subject
  area) in Settings. **Work on it** opens the document and starts the conversation; **⋯** comments
  on the issue, marks it not applicable or snoozes it for a week. Quarantined drafts and open pull
  requests are below. The robot shows how many of your gaps are open.
- **Up to date / Synced 2 min ago** in the toolbar: Bookwyrm keeps a copy of the repo on this
  computer and checks GitHub every few minutes, and right before every edit. Click it to check now.
- **Settings:**
  - your name and team;
  - how Bookwyrm reaches Claude: Anthropic directly or your company's gateway (**Save and check**
    tests a change before Bookwyrm uses it);
  - the Archivist registry (your company's own Archivist, if it has one), the knowledge repo
    picked from it, and the GitHub token (changing these
    re-runs the relevant setup steps for you);
  - Bookwyrm's voice (press **Play** to hear one) and its speaking speed;
  - calls from Bookwyrm;
  - your gap labels, and how often to check GitHub for changes;
  - opening at login, and showing the robot.

### Letting Bookwyrm call you

This is off unless you switch it on (robot menu → **Let Bookwyrm call me**, or Settings). When
it's on, Bookwyrm checks the repo every few minutes. When a new draft lands in quarantine or a
new gap is filed, the robot rings and the card says why. Choose **Answer** or **Not now**.

It only calls about things that are new since you switched it on, never the backlog, and it
makes at most one call per check. A call you miss shows as a red badge on the robot.

### Closing it

Quit from the robot's menu or the menu-bar / tray icon (**Quit Bookwyrm**). Closing the
Bookwyrm window leaves the robot running. Quitting stops everything, voice included.

## Updating

Run the same install line again. It pulls the latest Bookwyrm and only redoes what changed,
usually in under a minute.

## If something's off

The card and Settings → *Voice service* say what's wrong.

| What you see | What to do |
|---|---|
| "Bookwyrm is waking up" for more than a minute | The first start after setup loads the speech models. If it never finishes, check the log at `~/.bookwyrm/voice.log` (Windows: `%USERPROFILE%\.bookwyrm\voice.log`), then Settings → Voice service → **Restart** |
| "Bookwyrm's brain (Hermes) isn't running" | In Terminal or PowerShell: `hermes gateway restart` |
| "I can't reach the repo", the toolbar says *Can't reach GitHub*, or Gaps shows a GitHub error | The token has expired or doesn't cover the repo. Settings → GitHub token → **Replace…** |
| Bookwyrm can't answer anything | Settings → Model: check the Anthropic key, or the gateway address, model name and key. **Save and check** tests them |
| An approved change stays an open pull request | `main` is protected and you aren't on its bypass list. Ask a repo admin to add you, or a reviewer to merge it |
| My knowledge repo isn't in the list | Bookwyrm only looks after repos in Archivist's registry. If your company runs its own Archivist, point Bookwyrm at it: Settings → Knowledge repo → Archivist registry → **Change…**, type its repo (for example `your-org/archivist`, or `your-org/archivist:config/targets.yml`), **Load**, pick the repo, **Switch**. Otherwise ask the Archivist owners to add it to the registry (a pull request) |
| "Couldn't find targets.yaml or targets.yml" for my company's registry | The registry repo is private and your token can't read it. Edit the token on GitHub and add that repo with Contents: read |
| A repo in the list says your token can't reach it | Make a fine-grained GitHub token that includes that repo, and save it in Settings → GitHub token |
| Gaps says the repo is no longer an active target | It's been retired in the registry. Choose another in Settings → Knowledge repo |
| Using a gateway: answers stop off the company network | The gateway is only reachable on the network or VPN. Speech still works; thinking needs the gateway |
| "Voice isn't set up on this computer" | Run the install line again |
| No sound from Bookwyrm | Check the computer's output device. The captions on the card show what it's saying |
| It hears itself and cuts off | Use headphones, and tell us which computer and speakers |

Setup can also be checked without changing anything: `~/bookwyrm/install.sh --dry-run` on a Mac,
or `~\bookwyrm\install.ps1 --dry-run` on Windows.

## Removing Bookwyrm

1. Quit Bookwyrm, and switch off Settings → *Open Bookwyrm when I log in*.
2. Delete the app shortcut: `~/Applications/Bookwyrm.app` on a Mac, or *Bookwyrm* in the Start
   menu folder on Windows (`%APPDATA%\Microsoft\Windows\Start Menu\Programs`).
3. Delete the two Bookwyrm folders: `~/bookwyrm` (the program) and `~/.bookwyrm` (settings,
   history, speech models).
4. Remove Bookwyrm's Hermes profile, keys included: `hermes profile delete bookwyrm`. If you
   don't use Hermes for anything else, uninstall Hermes too (see its README).
5. Revoke the GitHub token and the Anthropic key on their websites.
