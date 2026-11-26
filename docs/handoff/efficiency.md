# Doing this work with fewer tokens, without losing depth

Written November 26 at Chip's request, from how the build actually spent tokens.

## Where the tokens went
1. **Long lived agents resumed again and again.** The flip agent reached about 625k tokens of transcript and the sale counting agent about 430k. Every resume replays that whole history, and after a limit stop the cache is cold, so each resume pays for it again. This was the biggest cost.
2. **Long reports through the coordinator.** Each report ran 2 to 6k tokens, landed in the coordinator's context, and was then relayed into the next agent. The coordinator's own context grew with every relay.
3. **Testers starting from zero.** Each tester reread the plan, the code and the data to find its footing, then built its own scripts again.
4. **Heavy outputs in chat.** Top 25 tables, diagnostic runs and simulator tables were pasted into reports instead of left in files.
5. **Limit stops.** Every stop meant saving work, writing handoffs and orienting again.

## What changes now (depth and the 3 check rounds stay)
1. **Fresh agents, short lives.** One agent does one fix round, then ends. The next round starts a fresh agent from files, not by resuming. No agent is resumed past about 150k tokens of transcript.
2. **Findings and briefs live in files.** A tester writes `scratchpad/findings-<piece>-r<N>.txt` (agents cannot write .md files) and a fixer reads it. The coordinator passes a path, not the content. Each brief is a file too.
3. **Reports capped at about 300 words.** Verdict, the commit, the counts that matter and open decisions. Tables and traces go in a file named in the report.
4. **Testers get a focused start.** The diff range, the findings file from the previous round, and the scripts the previous tester left in the scratchpad to reuse.
5. **Model by job.** Design, adversarial review and the final round of each piece stay on the strongest model. Mechanical work runs on a faster model: rerunning a recompute script, applying a reviewed patch, writing the tutorial.
6. **Coordinator stays lean.** Short status lines, no restating of reports, one tool call where one will do.
7. **Commit early,** as now, so a limit stop costs a save and nothing more.

## What does not change
At least 3 independent check rounds per piece and 3 on the whole. Independent recomputation in the tester's own code. Real data runs. Adversarial review of the top flips.
