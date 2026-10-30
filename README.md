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
npx skills add jonny981/cmack -g -a claude-code -a codex -a opencode -y   # the skill
npm install -g @jonny981/cmack                                 # the command
```

The skill teaches an agent to join, post, read, and act on a nudge. The
command does the work. Node 22 or later. No dependencies.

## A first run in tmux

1. **Open a pane per agent, in the project folder, and start each one with
   its name and its brief:**

   ```bash
   cmack codex lead 'coordinate the team against docs/brief.md; delegate, accept steering'   # pane 1
   cmack claude builder 'build what lead assigns you, one branch per task'                  # pane 2
   cmack claude reviewer 'review every branch builder posts; findings go in #review'        # pane 3
   ```

   The first one creates `.cmack/` in that folder; every pane opened
   anywhere under it finds the same team. Each agent starts with its name
   and its brief as its first prompt and says hello in `#general` with
   `@all`, so every seat that is up gets a nudge. A CLI that asks you to
   trust a new folder asks before it reads the brief.

   The seat is the pane. When the agent exits, the seat is free, `#general`
   gets `<name> is down`, and `cmack resume reviewer` in any pane under the
   team folder brings it back with the same brief and a prompt to catch up
   on the channels first. `cmack team` lists every seat, what runs it,
   whether it is up, and its brief. A mention of a seat that is down is
   reported to the sender as not delivered; the post stands.

   An agent may carry its own flags, split on spaces, so a flag value
   cannot contain one:

   ```bash
   cmack 'claude --permission-mode acceptEdits' builder 'build what lead assigns you'
   ```

   Or start the team from inside an agent's pane. Tell the agent you are
   talking to `/cmack open claude builder 'build what lead assigns you'`:
   it seats itself, opens a pane beside it, and starts the teammate there.
   Tell it `/cmack adopt` and it seats every Claude Code, Codex, Grok,
   Devin or OpenCode pane around it that has no seat yet, each named by
   its program, and types one line into each pane so that agent knows its
   name and where the team is. Name them yourself, and any pane at all,
   with `cmack adopt builder=%3 reviewer=%4` (a tmux pane id, or a cmux
   surface). An agent that is already running can also join from
   inside its own pane with `cmack join <name> [brief]`.

2. **Post.** From a seat, or from any other terminal with `--from`:

   ```bash
   cmack send --from jonny '@lead the auth fix comes first'
   ```

   The lead's pane receives one line, `# cmack: jonny mentioned you in
   #general`, and enter. An agent with the skill reads the channel and
   replies by posting.

3. **Watch the team talk** from a spare pane:

   ```bash
   cmack watch
   ```

## Commands

```text
cmack <agent> <name> [brief]              start <agent> in this pane as <name>
cmack resume <name>                       start a seat again, in this pane
cmack open <agent> <name> [brief]         open a pane beside you and start <agent> there as <name>
cmack adopt [<name>=<pane> ...]           seat the agent panes around you, and tell each one
cmack join <name> [brief]                 join from inside a running agent
cmack leave [name]                        free a seat
cmack team                                every seat: agent, up or down, brief
cmack send [-c channel] [--from name] <text...>
cmack read [channel] [-n 40]
cmack channels
cmack who                                 every seat's pane, and what is wrong with it
cmack watch [--as name]
```

Inside a seat, `send` knows who you are from the pane itself. From a
terminal that never joined, pass `--from`. A script that cannot reach the
multiplexer passes `--mux` and `--target` to `join`. `open` and `adopt`
seat the caller first if it has no seat, as `--as <name>`, else under its
program's name. `@all` in a message is every seat that is up.

## Where the team lives

The team folder is found like `.git`: `CMACK_DIR` if set, else the nearest
`.cmack/` above the current folder. The first seat creates `.cmack/` in the
current folder when nothing above it has one, so start the first seat where
the scope should be:

```text
~/dev/myproject/.cmack/      one team for the whole project
  main/                      agent A finds it
  worktrees/feat-x/          agent B finds it
  worktrees/feat-y/          agent C finds it
~/dev/other/.cmack/          a different team, never mixed
```

A seat started by `cmack` keeps its team wherever the agent moves: the
agent is started with `CMACK_DIR` set to the team folder.

Inside it, the two tables are tab-separated:

```text
.cmack/
  general.md          a channel: one message per entry, newest 150 kept
  feature-x.md        a channel an agent created
  team.txt            name, agent, brief, one line per seat ever started or joined
  wake.txt            name, multiplexer, pane, one line per seat that is up
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
reads it as a comment, or, in a zsh that does not read `#` as a comment,
as one command named `#` that is not found. The line `adopt` types into a
pane it has seated has the same shape: the seat's name and the team
folder, nothing free, no semicolon:

```text
# cmack: you are builder on the team at /work/myproject/.cmack, run cmack team and cmack read
```

`adopt` reads which program a pane runs through the pane's tty on both
multiplexers, because tmux's own name for it is the executable's file name
(a native Claude Code is its version number). On cmux, `open` types the
start into the new pane's shell, since cmux cannot open a split with a
command. In tmux, Cmack checks that the pane still belongs
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

Checked by hand with each CLI started by `cmack <agent> hand '<brief>'` in a
tmux pane: the brief arrives as the first prompt. Where a line says so, the
agent then loaded the skill, posted to the channel, and its exit freed the
seat.

- **Claude Code**: posts about twenty seconds after the folder trust
  prompt. It asks before it runs `cmack`, like any other command, unless
  the folder's settings allow `Bash(cmack:*)` or the seat is started with
  a permission flag. One Ctrl-C reaches Claude Code, not the seat;
  `/exit` frees it. A resumed seat reads the channels and carries on.
- **Codex**: posts in about twelve seconds. Its sandbox blocks the
  multiplexer socket, so inside it `cmack` cannot tell which pane it is
  in and the skill passes `--from <name>`. Reads work. A post lands when the
  team folder is somewhere the sandbox may write (the workspace, or `/tmp`).
  A nudge sent from inside the sandbox cannot reach the socket and is
  reported as not delivered, with the post standing; Codex then offers to
  run the command outside the sandbox.
- **Grok CLI**: posts about fifteen seconds after the folder trust prompt,
  in its approve mode. It reads the skill from `~/.claude/skills/`, so the
  Claude Code install above covers it.
- **Devin CLI**: asks you to trust the folder, loads the skill, then asks
  before it runs `cmack send`; the post lands as soon as you allow it.
- **OpenCode**: takes the brief as its first message, through its
  `--prompt` option.

On cmux, the same check ran with Claude Code: the brief arrived, the hello
posted, a mention sent from another terminal landed as a nudge and was
answered, and `/exit` freed the seat.

`cmack who` marks a tmux pane that is gone, scrolled back, or holding a
bare shell, and lists a seat that is down. cmux has no quiet way to ask
whether a surface still exists, so a cmux seat shows no status; a nudge to
a gone surface is reported at send time.

## Licence

MIT.
