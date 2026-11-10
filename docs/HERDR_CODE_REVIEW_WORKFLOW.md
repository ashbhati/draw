# Building with Codex and reviewing with Claude Code in Herdr

This playbook describes the development workflow used for Draw: Codex CLI acts as the implementing developer, Claude Code acts as an independent reviewer, GitHub holds the durable review record, and Herdr provides the terminal panes and agent handoff.

It is written so the setup can be recreated on another machine. Herdr's installed guide is authoritative for the installed version; its commands and agent detection can change. From a Herdr pane, an agent can read `~/.config/herdr-app/AGENTS.md` for the version-matched local guide. The online [Herdr agent automation guide](https://herdr.dev/tui/docs/agent-automation/) and [CLI reference](https://herdr.dev/tui/docs/cli-reference/) describe the current command set.

## Roles and boundaries

| Participant | Responsibility | Expected output |
| --- | --- | --- |
| Human product owner | Defines outcomes and scope, chooses priorities, approves consequential decisions, and accepts the release. | Issues, product feedback, final acceptance. |
| Codex CLI in Herdr | Reads the repo and issue, implements the change, writes or updates tests, runs the relevant checks, commits, pushes a branch, and opens or updates a PR. It fixes accepted review findings. | Reviewable code and test changes on a PR. |
| Claude Code in a separate Herdr pane | Independently reviews the exact PR head. It checks behavior, regressions, tests, and acceptance criteria; it reports actionable findings with severity, file/line, evidence, and acceptance criteria. | GitHub PR review comments and/or a linked findings issue, when explicitly asked to post them. |
| Herdr | Keeps the Codex and Claude terminals available, identifies their state, and lets the coordinator prompt, read, and wait for them. | Agent and terminal coordination; it does not replace Git or GitHub. |
| GitHub | Stores the issue, branch/PR, review comments, checks, and merge record. | The source of truth for what was requested, reviewed, and shipped. |

Keep one writer on a checkout at a time. Claude reviews a pushed commit and does not modify project files during a review. Codex resumes implementation after the review is complete. If parallel implementation is needed, give the agents separate Git worktrees and branches; do not let two agents edit the same checkout concurrently.

## One-time setup on a machine

1. Install and sign in to Herdr, Codex CLI, and Claude Code. Herdr runs these tools in managed terminal panes; it does not provide their model or account access.
2. Clone the repository and make sure both agents can access the same GitHub repo. The person operating the machine must have Git credentials and permission to push branches and open PRs.
3. Open the repo as a Herdr workspace. Start Codex CLI in one pane and Claude Code in another. Claude must be signed in and able to read the repo and GitHub PR. The sessions may be manually started from Herdr's `+` control.
4. In a Herdr pane, check that the processes are detected:

   ```sh
   printf 'HERDR_ENV=%s PANE=%s\n' "$HERDR_ENV" "$HERDR_PANE_ID"
   herdr agent list
   ```

   `HERDR_ENV=1` indicates the shell is running inside Herdr. If an agent is not yet named, its pane ID can be used as the command target. For stable references, rename the detected agents once:

   ```sh
   herdr agent rename <codex-pane-id> codex-dev
   herdr agent rename <claude-pane-id> claude-reviewer
   ```

   Agent names are local to that Herdr server/session and may need to be set again on another machine. Use `herdr agent list` to see current names and states.

Herdr can prompt agents through its CLI. For example, from the Codex pane or another shell attached to the same Herdr server:

```sh
herdr agent prompt codex-dev "Implement GitHub issue 123 on a new branch. Follow the repository instructions, add tests, run the relevant checks, commit, push, and open a PR. Do not merge." --wait --timeout 3600000
```

Herdr's `agent prompt --wait` waits for an observed settled state, not a particular semantic result. Always inspect the terminal output and the GitHub state before acting on the result. A timeout does not prove that the prompt was not delivered; inspect the agent before retrying it.

## Per-issue development and review loop

### 1. Start from a concrete issue

The human or coordinator selects one GitHub issue with a bounded outcome and acceptance criteria. Ask Codex to read the issue and repository instructions before editing. Keep one issue per PR where practical so review and rollback stay focused.

Example implementation prompt:

> Implement issue #123 in this repository. First inspect the relevant code and repository instructions. Work on a feature branch, add or update tests before/with the implementation, run the relevant unit, browser, and build checks, and report any checks you could not run. Commit and push the branch, then open a PR linked to the issue. Do not merge. Keep the change within the issue's acceptance criteria.

Codex should provide the branch and PR URL, summary of changes, tests run and results, and known limitations. The human can inspect the local diff and CI before requesting review.

### 2. Give Claude the exact PR head to review

Wait until Codex has pushed the candidate commit. Ask Claude to review the PR's current head, not a stale local snapshot. The review should be independent: Claude checks the acceptance criteria and code, and should not rely only on Codex's summary.

Example review prompt:

> Review PR #123 in `owner/repository` at its latest pushed commit. Treat this as a code review, not an implementation task. Do not edit repo files or push commits. Check the diff against issue #123 and the acceptance criteria, look for correctness bugs, regressions, missing tests, and security or data-loss risks. Verify claims with code inspection and run safe, relevant checks if practical. Report only actionable findings. For each finding include severity, file and line, evidence/reproduction, and a concrete acceptance criterion. Separate confirmed findings from items you could not verify. Post inline comments for line-specific issues and use one linked GitHub issue for broader findings if needed. If you find no actionable issues, say so clearly and state what you checked.

When Claude has explicit authorization to write review feedback to GitHub, it may post that feedback on the PR or create/link a findings issue. Otherwise, have it report findings in the Herdr pane for the human to post. Do not ask Claude to merge the PR.

Herdr handoff commands for an already-running Claude session:

```sh
herdr agent prompt claude-reviewer "Review PR #123 in owner/repository at its latest commit. Do not edit files. Use the review instructions in docs/HERDR_CODE_REVIEW_WORKFLOW.md. Post findings to the PR only as authorized." --wait --timeout 3600000
herdr agent read claude-reviewer --source recent-unwrapped --lines 160
```

If a session is already active or asks for permission/input, inspect it before sending another prompt. Use `herdr agent get claude-reviewer` to check its state. `herdr agent prompt --wait` can also settle because an existing active turn ended, so verify the PR review itself in GitHub.

### 3. Triage findings and let Codex fix them

The human/coordinator reads each comment and decides whether it is valid and in scope. Give Codex the actionable findings and ask it to address them on the same branch, add regression coverage, rerun checks, and push an update. Codex should reply to each review thread with what changed or why it was not changed; it should not silently dismiss findings.

Example remediation prompt:

> Address the accepted findings on PR #123. Read every unresolved review comment and linked issue. Fix each confirmed in-scope issue, add regression tests, run the relevant checks, and push the updates to the PR branch. For any finding you believe is incorrect or out of scope, explain the evidence without changing it. Do not merge.

After Codex pushes, have Claude inspect the updated PR head and verify each finding is resolved. Repeat the review/fix cycle until there are no unresolved blocking findings and CI is green. The reviewer should report any remaining uncertainty explicitly.

### 4. Merge and close the loop

The human checks the final diff, the reviewer result, CI, issue linkage, and release scope. Merge only after that acceptance step. Confirm the issue is closed by the merge/linkage or close it with a note. Record any intentionally deferred capability as a separate issue with an explicit future milestone or label; do not let out-of-scope items block a focused release.

For a release, verify the merged commit and release artifact/tag, then update the README and project plan to reflect what shipped. A merge is not itself evidence that an end-user installation or browser flow works; validate the actual release path separately.

## Practical checks and safeguards

- **Pin the reviewed commit.** Ask Claude to name the commit SHA it reviewed. If the PR head changes, request review again.
- **Keep review read-only.** One writer avoids accidental overwrites and makes the review independent. Use distinct worktrees if work must happen concurrently.
- **Ask for evidence.** Findings need a code path, test, browser reproduction, or clearly labeled uncertainty—not a generic suggestion.
- **Keep GitHub as the record.** Link the implementation PR to its issue and the review issue/comment to the PR. Herdr terminal scrollback is useful, but it is not the durable project record.
- **Distinguish review coverage from implementation coverage.** A clean review means the reviewer did not find issues in the checks performed; it does not mean untested browsers, flows, or platforms are verified.
- **Run product flows when appropriate.** Unit tests and a successful build do not prove that file open/save, export pixels, MCP round trips, or browser interactions work. Use the browser/e2e suite for those flows and state what was actually exercised.
- **Do not assume a Herdr prompt completed the requested task.** Read the agent output and inspect the resulting commit, PR, review, or CI state.
- **Protect credentials.** Do not paste tokens into prompts or issue bodies. Let Git/CLI credentials and the signed-in tools handle authentication.

## Article-ready summary of the method

Draw was built with two distinct AI roles inside Herdr. Codex CLI worked as the developer: it inspected the repository, implemented a scoped issue, added tests, ran checks, and pushed a pull request. Claude Code ran in a separate pane as the reviewer: it inspected the actual pull request, reported evidence-backed findings on GitHub, and did not edit the implementation. Codex then addressed the accepted findings, after which Claude reviewed the updated commit. The human kept ownership of product scope and merge decisions, while GitHub preserved the issues, review, checks, and release history. Herdr supplied the persistent, visible terminals and a way to prompt/read/wait on each agent; it did not replace GitHub, testing, or human acceptance.

This is a practical division of labor, not proof that two AI agents guarantee correctness. Review independence, test quality, exact commit identity, and human verification remain important.
