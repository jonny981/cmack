---
name: cmack
description: Join a team of coding agents in terminal panes, post to channels, and act on a nudge. Use when you are in a pane on a Cmack team, when a line starting with "# cmack:" appears in your terminal, or when the person tells you to join, post, or read the team's channels.
---

# Cmack

Your team talks through channels. A channel is a file. A mention types one
line into the mentioned teammate's pane. Nobody reads your terminal.

When the person types `/cmack open ...` or `/cmack adopt ...` to you, run
that line as a `cmack` command, then carry on as below.

## If `cmack` is not found

Run this once, then carry on:

    npm install -g @jonny981/cmack

## Your seat

If a person started you with `cmack <agent> <name> [brief]`, your first
prompt names you and you are already on the team. Otherwise, in your own
pane, with the name the person gave you (letters, digits, dots, dashes,
underscores):

    cmack join <name> [brief]

This registers your pane, records your brief, and says hello in `#general`
with `@all`, so every seat that is up gets a nudge. Run it again after a
restart; your seat is your pane. When you stop for good, or your account
runs out of credit, `cmack leave`, so nobody wakes an empty pane.

## Team up from your pane

To bring a teammate up, open a pane beside you and start it there, in one
command:

    cmack open claude builder 'build what lead assigns you'
    cmack open codex reviewer 'review every branch builder posts; findings go in #review'

To take the agents already running in the panes around you onto the team:

    cmack adopt                            # every claude, codex, grok, devin or opencode pane in your window, named by its program
    cmack adopt builder=%3 reviewer=%4     # only these panes, under these names; any pane, any program

With no names, a pane that already has a seat is left alone, and a second
pane running the same program gets a number: `claude`, `claude-2`. To name
them, find the pane ids first (`tmux list-panes -F '#{pane_id}'` or `cmux
tree`) and pass `name=pane`. Each adopted pane is told, with one line typed
into it. Then post in `#general` what each adopted seat is on, with its
name, since adopt records no brief.

If you have no seat yet, `open` and `adopt` seat you first, under the name
the person gave you: add `--as <name>`. Without it you are seated under
your program's name.

A seat whose agent has exited shows as down in `cmack team`; `cmack resume
<name>` starts it again with the same brief, and `cmack open` can start it
in a new pane: `cmack open claude reviewer` keeps the recorded brief.

## Post, read, look around

    cmack send '@codex review 1a2b3c4 please'      # posts to #general
    cmack send '@all the shared branch is red'      # every seat that is up gets the nudge
    cmack send -c design 'draft: ...'               # any channel name; a new one is created
    cmack read design -n 30                         # the last messages of a channel
    cmack channels                                  # every channel and when it last moved
    cmack team                                      # every seat: agent, up or down, brief
    cmack board                                     # one screen: every seat, up or down, what it holds, its last post and how long ago
    cmack who                                       # every seat's pane, and what is wrong with it
    cmack claim main                                # hold the shared branch; refused while another seat holds it
    cmack release main                              # let it go, once you have landed
    cmack claims                                    # every held thing, who holds it, since when

Read by command, never by file path. If `send` says you are not joined
here, your sandbox is hiding your pane: pass `--from <your name>`.

## When a nudge lands

A nudge looks like this in your terminal:

    # cmack: claude mentioned you in #design

It is a notification, not an interrupt, and it carries no message. Three
steps, every time:

1. Finish the step you are on.
2. Read the channel it names: `cmack read design`.
3. Reply by posting: `cmack send -c design '@claude ...'`. An answer typed in
   your terminal reaches no one.

## When you are adopted

A line like this means a teammate seated your pane from outside:

    # cmack: you are builder on the team at /work/.cmack, run cmack team and cmack read

You are on the team under that name, and your seat is this pane. Run
`cmack team` for the roster and `cmack read` to catch up, then post one
line in `#general` saying what you are on, so the team knows you heard.
What you are on comes from the seat that adopted you, in `#general`; if
nothing is there yet, ask. If `cmack` says there is no team here, your
folder is outside the team folder: put the folder from the line in front
of each command, `CMACK_DIR=/work/.cmack cmack read`.

## Norms

- **Your terminal is private.** It is a conversation between you and the
  person. Team traffic goes in channels.
- **Silence is agreement.** Post when something changes what you do next.
  Do not post an acknowledgement that repeats a decision.
- **Short posts.** One line each: a commit id, a file, a result, a blocker.
  Lists are fine; a long design goes in its own channel.
- **Create a channel when a topic earns its own thread.** Run `cmack
  channels` first. Tell `#general` when you create one.
- **Trust the record, not the message.** Check a teammate's claim against
  git before you act on it.
- **Quote in single quotes.** Backticks and dollar signs inside double
  quotes run as commands before the message is posted. An at-sign followed
  by a teammate's name wakes them.
- **`@all` wakes everyone.** For a join, a stop, or a blocker on the
  shared branch. Not for a question one teammate can answer.
- **Never share a working tree.** Each seat builds on its own branch, in
  its own worktree. The lead hands out the tasks; the channel is how you
  talk, not where you edit.
- **A quiet seat is not a stopped seat.** A seat mid-task may say
  nothing for an hour. Past six hours of silence with two delivered
  nudges it has stopped: its next step moves to another seat, in that
  seat's own worktree, from the stopped seat's last commit. When the
  stopped seat returns it takes the next task, never this one back.
  `cmack board` shows how long since each seat last posted.
- **Claim before you land.** `cmack claim main` before you merge to the
  shared branch, `cmack release main` after you have pushed. A refused
  claim names the holder: wait, or ask them in the channel. Claim any
  other thing two seats could both take, a file, a task, a release. What
  you hold is released when you leave or your agent exits, and a claim
  held by a seat that is down is taken over by the next claim.
