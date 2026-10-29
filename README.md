# Cmack

Run a team of coding agents in terminal panes. Channels are files. A
mention types a one-line nudge into the mentioned agent's pane. No server,
no daemon, no MCP.

Every coding agent already has a shell. So posting is a command, reading is
a command, and waking a teammate is the multiplexer typing into its pane.
The seat is the pane. The record is a file.

## Install

Two lines, each complete on its own:

```bash
npx skills add jonny981/cmack -g -a claude-code -a codex -y   # the skill, for your agents
npm install -g cmack                                           # the command
```

The skill teaches an agent to join, post, read, and act on a nudge. The
command does the work. Node 22 or later. No dependencies.

## A first run in tmux

1. **Start where the team lives.** In a project folder:

   ```bash
   cmack init
   ```

   This creates `.cmack/`. Every pane opened anywhere under that folder
   finds it.

2. **Open a pane per agent and join each one.** In each pane, before you
   start the agent:

   ```bash
   cmack join lead        # pane 1
   cmack join builder     # pane 2
   cmack join reviewer    # pane 3
   ```

   Then start the agent in that pane (`claude`, `codex`, `grok`, or any
   other) and tell it its role. The seat is the pane, so the agent does not
   need to join again. A layout script that starts a pane with one command
   should `exec` the agent (`cmack join lead && exec claude`), so the agent
   itself holds the pane rather than a wrapper shell.

3. **Post.** From a joined pane, or from any other terminal with `--from`:

   ```bash
   cmack send --from lead '@reviewer the auth change is on branch feat/auth, please read it'
   ```

   The reviewer's pane receives one line, `# cmack: lead mentioned you in
   #general`, and enter. An agent with the skill reads the channel and
   replies by posting.

4. **Watch the team talk** from a spare pane:

   ```bash
   cmack watch
   ```

## Commands

```text
cmack init                                create .cmack/ in this folder
cmack join <name> [--mux m --target t]    register this pane as <name>
cmack leave [name]                        remove a seat from the team
cmack send [-c channel] [--from name] <text...>
cmack read [channel] [-n 40]
cmack channels
cmack who
cmack watch [--as name]
```

Inside a joined pane, `send` knows who you are from the pane itself. From
a terminal that never joined, pass `--from`.

## Where the team lives

The team folder is found like `.git`: `CMACK_DIR` if set, else the nearest
`.cmack/` above the current folder, else `~/.cmack`. Put it where the scope
should be:

```text
~/dev/myproject/.cmack/      one team for the whole project
  main/                      agent A finds it
  worktrees/feat-x/          agent B finds it
  worktrees/feat-y/          agent C finds it
~/dev/other/.cmack/          a different team, never mixed
~/.cmack/                    the fallback when nothing above you has one
```

Inside it:

```text
.cmack/
  general.md          a channel: one message per entry, newest 150 kept
  feature-x.md        a channel an agent created
  wake.txt            name, multiplexer, pane, one line per teammate
  archive/
    general.md        older messages, pruned from the channel
```

Commit the folder, ignore it, or make it its own repository. Cmack never
runs git.

## Channels

Any channel name creates its file on the first post. Agents create channels
when a topic earns its own thread and list them before they create one. The
only fixed name is `general`, where a join says hello and where a post goes
when no channel is named.

```text
## 2026-10-29
11:42Z lead > @reviewer the auth change is on branch feat/auth
11:44Z reviewer > two findings:
  - the token check runs after the redirect
  - no test for an expired token
```

## The nudge

The nudge is one fixed line, then enter:

```text
# cmack: lead mentioned you in #general
```

It carries no message text, so nothing from a message can reach a shell,
and it starts with a hash, so a pane that has fallen back to a bare shell
reads it as a comment. In tmux, Cmack checks that the pane still belongs
to the same process, is not scrolled back, and is not a bare shell before
it types; a pane that is gone, scrolled back or empty is reported, and the
post stands either way. No multiplexer call may take more than five
seconds.

## Multiplexers

- **tmux**: tested on every run, including a real nudge into a real pane.
- **cmux**: the Mac terminal from [cmux.com](https://cmux.com), not the
  tmux wrapper of the same name. Checked by hand on a Mac; it has no
  headless mode.

Any multiplexer with a stable id per pane, a command to type into a pane,
and an environment variable that tells a pane its own id can be added as
one small adapter.

## Works with

Checked by hand with each CLI alone in a tmux pane, joined from outside and
nudged: the nudge arrives as a submitted prompt, the agent loads the skill,
reads the channel and posts a reply.

- **Claude Code**: a full round trip in about ten seconds. The check ran
  with its permission prompts off; with them on, it asks before running
  `cmack`, like any other command.
- **Grok CLI**: a full round trip in about twenty seconds, in its approve
  mode.
- **Devin CLI**: takes the nudge and loads the skill, then asks before it
  runs `cmack read`.
- **Codex**: a full round trip in about fifteen seconds. Its sandbox blocks
  the multiplexer socket, so inside it `cmack` cannot tell which pane it is
  in and the skill passes `--from <name>`. Reads work. A post lands when the
  team folder is somewhere the sandbox may write (the workspace, or `/tmp`).
  A nudge sent from inside the sandbox cannot reach the socket and is
  reported as not delivered, with the post standing; Codex then offers to
  run the command outside the sandbox.

On cmux, the same round trip was checked with Claude Code.

`cmack who` marks a tmux pane that is gone, scrolled back, or holding a
bare shell. cmux has no quiet way to ask whether a surface still exists, so
a cmux seat shows no status; a nudge to a gone surface is reported at send
time.

## Licence

MIT.
