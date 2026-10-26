Set up Cade for me by following GETTING_STARTED.md, one step at a time.
Before each step, tell me what it does and what you'll run. Run the
commands yourself, check the result against the step's Expect, and
fix what you can using its If it fails. Stop and tell me exactly what
to do whenever a step needs a person: browser logins, approvals, Slack
and Google settings. Ask me for every value you need instead of
guessing.
Never ask me for a token or secret, and never put one in a file, a
commit or a command: the commands that need one (`slack:create`,
`slack:update`, `wrangler secret put`, `npm run dev`, `npm run group`)
ask for it themselves, hidden; `npm run group` also asks me questions to
set up the first group. For those, give me the exact command to run in a
separate terminal window, in this folder (not with !, which can't take
hidden input), wait for me, then check the result. Ask before deleting
anything, and before running a step a second time.
