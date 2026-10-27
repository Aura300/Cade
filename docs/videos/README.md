# Demo clips

One clip per act of [DEMO.md](../../DEMO.md), played by the walkthrough on
[the showcase page](../index.html). Act 1 also loops, muted, at the top of the
page. A clip that isn't here yet shows as "coming soon", so they can be added
one at a time.

| File | Act | Suggested length |
|---|---|---|
| `act-1-message-to-task.mp4` | A message becomes a task | 45–60s |
| `act-2-team-picks-up.mp4` | The team picks it up | 45–60s |
| `act-3-build-review-ship.mp4` | Build, review, test, ship | 60–90s |
| `act-4-incident.mp4` | Something breaks | 30s |
| `act-5-own-work.mp4` | The team's own work | 45s |
| `act-6-everyones-view.mp4` | Everyone's view | 45s |

Each can have a still of the same name as a `.jpg` (such as
`act-1-message-to-task.jpg`), shown before it plays.

No audio is needed. Keep each clip under about 5 MB so the page loads
quickly:

```
ffmpeg -i raw.mov -vf "scale=1600:-2" -c:v libx264 -crf 26 -preset slow -an -movflags +faststart act-1-message-to-task.mp4
```

The titles and summaries shown with each act are in `CHAPTERS` in
`index.html`.
