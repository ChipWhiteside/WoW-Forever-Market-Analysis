---
description: The overnight improvement loop for Gold Finder. Run by a Claude desktop scheduled task at 1am.
---
You are the master of the Gold Finder overnight loop. You never write code yourself. Follow these steps exactly.

1. Run `npx tsx scripts/loop-guard.ts window`. If it exits non zero, stop now and do nothing else. This prevents daytime catch up runs.
2. `git checkout main && git pull --ff-only` if a remote exists. Run `npm test`. If main is already failing, file that as the top issue and do not start any other.
3. Use the `auditor` agent. It files issues into `docs/issues.md`.
4. Pick at most **2** open issues for tonight, most valuable first, skipping any marked `touches_protected: yes` (append those to `docs/CHANGELOG.md` as proposals for Chip instead) and any marked `needs Chip`.
5. For each picked issue, one at a time (never two in flight):
   a. `git checkout -b loop/I-<n> main`.
   b. If `size: large`, use the `architect` agent to write the plan.
   c. Round loop, at most **3** rounds: `implementer`, then `tester` and `reviewer`. Both PASS ends the loop. Otherwise give their findings to the implementer for the next round.
   d. Stop early and revert (`git checkout main && git branch -D loop/I-<n>`) when a round is worse: more failing tests than the round before, or the reviewer says the change is growing beyond the issue. Also after a third failed round. Mark the issue `status: needs Chip` with what was tried.
   e. On a double PASS: `npx tsx scripts/loop-guard.ts protected main` must exit 0. Then merge to main with `git merge --no-ff loop/I-<n>`, note the merge commit, and run `npx tsx scripts/watchdog.ts <merge-commit>`. The engine picks up the new code on its next restart; the watchdog reverts automatically if anything that passed before now fails. Mark the issue `status: live`.
6. Append tonight's entry to `docs/CHANGELOG.md`: date, each issue with how it was found, what changed in plain words, files touched, tests added, reviewer notes, status (live, reverted, needs Chip, proposal), and how to undo it (`git revert <commit>`). Add the number of agent runs and rounds used.
7. If any limit is hit, stop for the night. Never wait for a limit to reset.
8. Commit the docs changes on main. If `DISCORD_DEV_WEBHOOK_URL` is set in `.env`, send a short summary to the dev channel with `npx tsx scripts/notify.ts "<summary>"`.
