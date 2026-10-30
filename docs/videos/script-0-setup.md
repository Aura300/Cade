# Setup for every clip

Shot lists: [act 1](script-1-message-to-task.md) · [act 2](script-2-team-picks-up.md) · [act 3](script-3-build-review-ship.md) · [act 4](script-4-incident.md) · [act 5](script-5-own-work.md) · [act 6](script-6-everyones-view.md)

Steps and message text come from [DEMO.md](../../DEMO.md).

- **Screens:** one browser profile per person (Sarah, You, Rex, Mia, Tom).
  Record each shot from the profile named in the *Screen* column.
- **Private messages:** Cade's prompts (Accept / Not now / Ask for approval), the
  forms and `/cade` output are *only visible to the account they're for*. If a
  shot shows one of them, it must be recorded from that account's screen.
- **Layout:** 1080p, Slack zoom ~110%, unrelated channels hidden, same sidebar
  in every clip. Keep the message text in a notes file and paste it.
- **Pace:** pause about one second after each click so Cade's reply lands.
- **Audio:** the clips play muted on the page, so each line below is a **caption**
  (burned into the video). The same lines work as voice-over for the full cut.
- **Seed first:** see "Seed beforehand" in DEMO.md. Reset between takes.
- **Config for the recording:** `pinning: true`, `canvas: true` (both off by
  default, and the pinned card and canvas only show with them), `ai: true` (one
  shot in act 3 needs it), then `npm run config`. Update the app
  (`npm run slack:update`) so the **Home** tab shows.
- **What each reply looks like** (so you record the right screen):
  - A typed command (`@Cade assign`, `status`, `priority`, `due`, `pr add`)
    gets a **✅ on your message**. Cade posts in the thread only to ask someone
    to do something.
  - A change from the card's ⋯ → **Edit**, or from **Accept** on a suggestion,
    is **one thread message**: a change log ("@you assigned @Rex as owner."),
    then on the next line what it asks of the people it names.
  - Someone your message already mentioned isn't asked again.
  - A suggestion from your own words is **private** to whoever wrote the
    message: "Should I update the task? From your message: …" with
    **Accept · Edit… · Reject**. Record it from the writer's screen.

Screen key: **S** Sarah (client) · **Y** You (lead) · **R** Rex (dev) ·
**M** Mia (reviewer) · **T** Tom (QA).

## Edit and export
- Cut by act. Add a thin caption bar at the bottom; no logos needed.
- Optional 2 s title card at the start of each clip with the act name.
- Export with the ffmpeg command in [README.md](README.md). Aim for under 5 MB.
- Save a still of the same name as `.jpg` (for example `act-3-build-review-ship.jpg`).
