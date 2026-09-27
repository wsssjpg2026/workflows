---
name: code-review-from-claude
description: Automated multi-agent code review of a GitHub pull request — five parallel review agents, confidence scoring to filter false positives, and compliance checks against the repo's guideline files (CLAUDE.md and AGENTS.md). Use whenever the user asks to review, audit, or check a PR / pull request — even if they don't explicitly say "code review".
---

Provide a code review for the given pull request. This workflow is tool-agnostic: it works in any coding agent that can spawn subagents and run shell commands, and does not depend on any specific vendor, model, or plugin format.

Throughout this skill, "guideline files" means the repository's **CLAUDE.md and AGENTS.md** files. Read both by default and treat them as equivalent sources of repo-specific coding guidance — a repo may have either or both.

To do this, follow these steps precisely:

1. Use a fast, lightweight subagent to check if the pull request (a) is closed, (b) is a draft, (c) does not need a code review (eg. because it is an automated pull request, or is very simple and obviously ok), or (d) already has a code review from you from earlier. If so, do not proceed.
2. Use another fast subagent to give you a list of file paths to (but not the contents of) any relevant guideline files from the codebase: the root CLAUDE.md and root AGENTS.md (whichever exist), as well as any CLAUDE.md or AGENTS.md files in the directories whose files the pull request modified.
3. Use a fast subagent to view the pull request, and ask the subagent to return a summary of the change.
4. Then, launch 5 parallel subagents (use your most capable general-purpose agents for these) to independently code review the change. The subagents should do the following, then return a list of issues and the reason each issue was flagged (eg. guideline-file adherence, bug, historical git context, etc.):
   a. Agent #1: Audit the changes to make sure they comply with the guideline files (CLAUDE.md / AGENTS.md). Note that guideline files are guidance for agents as they write code, so not all instructions will be applicable during code review.
   b. Agent #2: Read the file changes in the pull request, then do a shallow scan for obvious bugs. Avoid reading extra context beyond the changes, focusing just on the changes themselves. Focus on large bugs, and avoid small issues and nitpicks. Ignore likely false positives.
   c. Agent #3: Read the git blame and history of the code modified, to identify any bugs in light of that historical context.
   d. Agent #4: Read previous pull requests that touched these files, and check for any comments on those pull requests that may also apply to the current pull request.
   e. Agent #5: Read code comments in the modified files, and make sure the changes in the pull request comply with any guidance in the comments.
5. For each issue found in #4, launch a parallel fast subagent that takes the PR, issue description, and list of guideline files (from step 2), and returns a score to indicate the subagent's level of confidence for whether the issue is real or false positive. To do that, the subagent should score each issue on a scale from 0-100, indicating its level of confidence. For issues that were flagged due to guideline-file instructions, the subagent should double check that the relevant CLAUDE.md or AGENTS.md actually calls out that issue specifically. The scale is (give this rubric to the subagent verbatim):
   a. 0: Not confident at all. This is a false positive that doesn't stand up to light scrutiny, or is a pre-existing issue.
   b. 25: Somewhat confident. This might be a real issue, but may also be a false positive. The subagent wasn't able to verify that it's a real issue. If the issue is stylistic, it is one that was not explicitly called out in the relevant guideline file.
   c. 50: Moderately confident. The subagent was able to verify this is a real issue, but it might be a nitpick or not happen very often in practice. Relative to the rest of the PR, it's not very important.
   d. 75: Highly confident. The subagent double checked the issue, and verified that it is very likely it is a real issue that will be hit in practice. The existing approach in the PR is insufficient. The issue is very important and will directly impact the code's functionality, or it is an issue that is directly mentioned in the relevant guideline file.
   e. 100: Absolutely certain. The subagent double checked the issue, and confirmed that it is definitely a real issue, that will happen frequently in practice. The evidence directly confirms this.
6. Filter out any issues with a score less than 50. If there are no issues that meet this criteria, do not proceed.
7. Use a fast subagent to repeat the eligibility check from #1, to make sure that the pull request is still eligible for code review.
8. Finally, use the `gh` command to comment back on the pull request with the result. When writing your comment, keep in mind to:
   a. Keep your output brief
   b. Avoid emojis (except the footer line below)
   c. Link and cite relevant code, files, and URLs

Examples of false positives, for steps 4 and 5:

- Pre-existing issues
- Something that looks like a bug but is not actually a bug
- Pedantic nitpicks that a senior engineer wouldn't call out
- Issues that a linter, typechecker, or compiler would catch (eg. missing or incorrect imports, type errors, broken tests, formatting issues, pedantic style issues like newlines). No need to run these build steps yourself — it is safe to assume that they will be run separately as part of CI.
- General code quality issues (eg. lack of test coverage, general security issues, poor documentation), unless explicitly required in a guideline file
- Issues that are called out in a guideline file, but explicitly silenced in the code (eg. due to a lint ignore comment)
- Changes in functionality that are likely intentional or are directly related to the broader change
- Real issues, but on lines that the user did not modify in their pull request

Notes:

- Do not check build signal or attempt to build or typecheck the app. These will run separately, and are not relevant to your code review.
- Use `gh` to interact with GitHub (eg. to fetch a pull request, or to create inline comments), rather than web fetch. If the repository is hosted on a different platform (eg. GitLab, Bitbucket, Gitee), adapt the commands to that platform's CLI or API — the workflow stays the same.
- Make a todo list first
- You must cite and link each bug (eg. if referring to a guideline file, you must link it)
- For your final comment, follow the following format precisely (assuming for this example that you found 3 issues):

---

### Code review

Found 3 issues:

1. <brief description of bug> (CLAUDE.md says "<...>")

<link to file and line with full sha1 + line range for context, note that you MUST provide the full sha and not use bash here, eg. https://github.com/anthropics/claude-code/blob/1d54823877c4de72b2316a64032a54afc404e619/README.md#L13-L17>

2. <brief description of bug> (some/other/AGENTS.md says "<...>")

<link to file and line with full sha1 + line range for context>

3. <brief description of bug> (bug due to <file and code snippet>)

<link to file and line with full sha1 + line range for context>

🤖 Generated by an automated code review agent

<sub>- If this code review was useful, please react with 👍. Otherwise, react with 👎.</sub>

---

- Or, if you found no issues:

---

### Code review

No issues found. Checked for bugs and compliance with CLAUDE.md / AGENTS.md.

---

- When linking to code, follow the following format precisely, otherwise the Markdown preview won't render correctly: https://github.com/anthropics/claude-cli-internal/blob/c21d3c10bc8e898b7ac1a2d745bdc9bc4e423afe/package.json#L10-L15
  - Requires full git sha
  - You must provide the full sha. Commands like `https://github.com/owner/repo/blob/$(git rev-parse HEAD)/foo/bar` will not work, since your comment will be directly rendered in Markdown.
  - Repo name must match the repo you're code reviewing
  - # sign after the file name
  - Line range format is L[start]-L[end]
  - Provide at least 1 line of context before and after, centered on the line you are commenting about (eg. if you are commenting about lines 5-6, you should link to `L4-7`)

## Bound workflow invocation

When invoked by Spec Delivery as its pinned `prReview` capability, read [automation-context.md](automation-context.md) before starting. It defines the supplied candidate, required regular/fresh completion receipt, child task registration, and report handoff. The standalone review method above remains available outside that workflow.
