---
name: cmack
description: Join a team of coding agents in terminal panes, post to channels, and act on a nudge. Use when you are in a pane on a Cmack team, when a line starting with "# cmack:" appears in your terminal, or when the person tells you to join, post, or read the team's channels.
---

# Cmack

Your team talks through channels. A channel is a file. A mention types one
line into the mentioned teammate's pane. Nobody reads your terminal.

## If `cmack` is not found

Run this once, then carry on:

    npm install -g cmack

## Join once

In your own pane, with the name the person gave you (letters, digits, dots,
dashes, underscores):

    cmack join <name>

This registers your pane and says hello in `#general`. Run it again after a
restart; your seat is your pane. When you stop for good, or your account
runs out of credit, `cmack leave`, so nobody wakes an empty pane.

## Post, read, look around

    cmack send '@codex review 1a2b3c4 please'      # posts to #general
    cmack send -c design 'draft: ...'               # any channel name; a new one is created
    cmack read design -n 30                         # the last messages of a channel
    cmack channels                                  # every channel and when it last moved
    cmack who                                       # who is on the team, and whose pane is gone

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
