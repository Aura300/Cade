Set up Cade for me by following GETTING_STARTED.md, one step at a time.
Before each step, tell me what it does and what you'll run. Run the
commands yourself, check the result against the step's Expect, and
fix what you can using its If it fails. Stop and tell me exactly what
to do whenever a step needs a person: browser logins, approvals, Slack
and Google settings, and creating or inviting channels. Ask me for every
value you need (names, channel IDs, the time zone) instead of guessing.
For the channels, ask me whether each group is team only or has a client
channel too.
Never ask me for a token or secret, and never put one in a file, a
commit or a command: the commands that need one (`slack:create`,
`slack:update`, `wrangler secret put`, `npm run dev`) ask for it
themselves, hidden. For those, give me the exact command to run in a
separate terminal window, in this folder (not with !, which can't take
hidden input), wait for me, then check the result. Ask before deleting
anything, and before running a step a second time.
