import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

/** 只读事实适配器：不缓存、不重试，不以权限/API 失败代替空结果。 */
export type Repo = { root: string; slug: string; host: string; defaultBranch: string };
export type IssueFact = {
  number: number;
  title: string;
  body: string;
  url: string;
  state: "OPEN" | "CLOSED";
  assignees: string[];
  /** GitHub 原生依赖；正文约定由上层按仓库规则解释，不能从任意 #引用猜测。 */
  blockedBy: Array<{ repo: string; number: number; state: "OPEN" | "CLOSED"; url: string }>;
  comments: Array<{ url: string; body: string }>;
};
export type CheckFact = {
  id: string;
  name: string;
  status: "pass" | "pending" | "failed" | "startup_failure" | "skipped" | "unknown";
  url: string;
};
export type PrFact = {
  number: number;
  url: string;
  head: string;
  base: string;
  baseRef: string;
  headRef: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  checks: CheckFact[];
  /** 仅 MERGED 时为 merge_commit_sha；squash/rebase 后不等于 head。 */
  mergedHead: string;
};

type JsonObject = Record<string, unknown>;
const MAX_OUTPUT = 32 * 1024 * 1024;
const COMMAND_TIMEOUT = 120_000;

function fail(message: string): never {
  throw new Error(`GitHub observation: ${message}`);
}

function object(value: unknown, where: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${where}: expected an object`);
  return value as JsonObject;
}

function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(`${where}: expected an array`);
  return value;
}

function string(value: unknown, where: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value)) fail(`${where}: expected a string`);
  return value;
}

function nullableText(value: unknown, where: string): string {
  return value === null ? "" : string(value, where, true);
}

function integer(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(`${where}: expected a positive integer`);
  return value;
}

function boolean(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") fail(`${where}: expected a boolean`);
  return value;
}

function sha(value: unknown, where: string): string {
  const result = string(value, where);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(result)) fail(`${where}: expected a full commit SHA`);
  return result.toLowerCase();
}

function parseJSON(raw: string, where: string): unknown {
  try { return JSON.parse(raw); } catch { return fail(`${where}: invalid JSON response`); }
}

function command(executable: "git" | "gh", argv: string[], cwd: string): string {
  // 环境中的 GH_REPO 不能把当前工作区悄悄指向另一仓库；禁用调试输出来避免打印认证头。
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", GH_DEBUG: "" };
  delete env.GH_REPO;
  try {
    return execFileSync(executable, argv, {
      cwd, env, shell: false, encoding: "utf8", timeout: COMMAND_TIMEOUT,
      maxBuffer: MAX_OUTPUT, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const e = error as { stderr?: string | Buffer; message?: string; status?: number | null; signal?: string | null };
    const detail = String(e.stderr || e.message || "command failed").trim().slice(0, 2000);
    return fail(`${executable} ${argv.join(" ")} failed (status ${e.status ?? "none"}, signal ${e.signal ?? "none"}): ${detail}`);
  }
}

function slug(value: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) || value.split("/").some(p => p === "." || p === "..")) {
    fail(`invalid repository name: ${value}`);
  }
  return value;
}

function webURL(value: unknown, where: string): URL {
  let url: URL;
  try { url = new URL(string(value, where)); } catch { return fail(`${where}: invalid URL`); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    fail(`${where}: unexpected URL form`);
  }
  return url;
}

function validateRepo(repo: Repo): void {
  if (!isAbsolute(repo.root)) fail("repo.root must be absolute");
  slug(repo.slug);
  if (webURL(`https://${repo.host}`, "repo.host").host !== repo.host || /[/?#]/.test(repo.host)) fail("invalid repo.host");
}

function pathFor(repo: Repo): string {
  validateRepo(repo);
  return `repos/${repo.slug.split("/").map(encodeURIComponent).join("/")}`;
}

function api(repo: Repo, endpoint: string, paginated = false): unknown {
  validateRepo(repo);
  const argv = ["api", "--hostname", repo.host, "--method", "GET", "--header", "Accept: application/vnd.github+json"];
  if (paginated) argv.push("--paginate", "--slurp");
  // 不钉死 github.com 最新版本号，使 GHES 使用其实际支持的默认 REST 版本。
  argv.push(endpoint);
  return parseJSON(command("gh", argv, repo.root), endpoint);
}

/** gh 跟随 Link 分页；集合有 total_count 时额外拒绝不完整的返回。 */
function list(repo: Repo, endpoint: string, key?: string): JsonObject[] {
  const pages = array(api(repo, endpoint, true), `${endpoint} pages`);
  if (!pages.length) fail(`${endpoint}: pagination returned no pages`);
  let expected = 0;
  const rows: JsonObject[] = [];
  for (const page of pages) {
    const data = key ? object(page, endpoint) : undefined;
    if (data && "total_count" in data) {
      const count = data.total_count;
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) fail(`${endpoint}: invalid total_count`);
      expected = Math.max(expected, count);
    }
    for (const row of array(data ? data[key!] : page, endpoint)) rows.push(object(row, endpoint));
  }
  if (rows.length < expected) fail(`${endpoint}: incomplete pagination (${rows.length}/${expected}); observation may have changed`);
  return rows;
}

function issueState(value: unknown): "OPEN" | "CLOSED" {
  if (value === "open") return "OPEN";
  if (value === "closed") return "CLOSED";
  return fail(`unknown issue state: ${String(value)}`);
}

function issueIdentity(raw: JsonObject, repo: Repo): { repo: string; number: number; url: string } {
  if (raw.pull_request) fail("expected an issue, received a pull request");
  const number = integer(raw.number, "issue.number");
  const url = webURL(raw.html_url, "issue.html_url");
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.host !== repo.host || parts.length !== 4 || parts[2] !== "issues" || parts[3] !== String(number)) {
    fail(`issue URL does not match its host/number: ${url.href}`);
  }
  return { repo: slug(`${parts[0]}/${parts[1]}`), number, url: url.href };
}

function sameRepository(identity: { repo: string; url: string }, repo: Repo): void {
  if (identity.repo.toLowerCase() !== repo.slug.toLowerCase()) {
    fail(`cross-repository sub-issue cannot run in ${repo.slug}: ${identity.url}`);
  }
}

export function detectRepo(cwd: string): Repo {
  const root = command("git", ["rev-parse", "--show-toplevel"], resolve(cwd)).trim();
  if (!isAbsolute(root)) fail("git did not return an absolute repository root");
  const raw = object(parseJSON(command("gh", ["repo", "view", "--json", "nameWithOwner,url,defaultBranchRef"], root), "gh repo view"), "repository");
  const name = slug(string(raw.nameWithOwner, "nameWithOwner"));
  const url = webURL(raw.url, "repository.url");
  if (url.pathname.replace(/^\/|\/$/g, "").toLowerCase() !== name.toLowerCase()) fail("repository URL and name disagree");
  const branch = object(raw.defaultBranchRef, "defaultBranchRef (repository may be empty)");
  return { root, slug: name, host: url.host, defaultBranch: string(branch.name, "defaultBranchRef.name") };
}

export function targetHead(repo: Repo, target: string): string {
  validateRepo(repo);
  if (!target || target.startsWith("refs/")) fail("target must be a branch name, without refs/heads/");
  command("git", ["check-ref-format", `refs/heads/${target}`], repo.root);
  const ref = `heads/${target.split("/").map(encodeURIComponent).join("/")}`;
  const raw = object(api(repo, `${pathFor(repo)}/git/ref/${ref}`), "target ref");
  if (raw.ref !== `refs/heads/${target}`) fail("target ref response does not match requested branch");
  const commit = object(raw.object, "target ref.object");
  if (commit.type !== "commit") fail("target branch does not point to a commit");
  return sha(commit.sha, "target SHA");
}

export function issue(repo: Repo, number: number): IssueFact {
  integer(number, "issue number");
  const endpoint = `${pathFor(repo)}/issues/${number}`;
  const raw = object(api(repo, endpoint), endpoint);
  const identity = issueIdentity(raw, repo);
  sameRepository(identity, repo);
  if (identity.number !== number) fail("issue response number differs from request");
  const blockers = list(repo, `${endpoint}/dependencies/blocked_by?per_page=100`);
  const comments = list(repo, `${endpoint}/comments?per_page=100`);
  return {
    number, title: string(raw.title, "issue.title"), body: nullableText(raw.body, "issue.body"),
    url: identity.url, state: issueState(raw.state),
    assignees: array(raw.assignees, "issue.assignees").map(a => string(object(a, "assignee").login, "assignee.login")),
    blockedBy: blockers.map(b => ({ ...issueIdentity(b, repo), state: issueState(b.state) })),
    comments: comments.map(c => ({ url: string(c.html_url, "comment.html_url"), body: nullableText(c.body, "comment.body") })),
  };
}

/** 返回全部后代，不含父 spec；每层都完整分页，跨仓库或循环明确报错。 */
export function subIssues(repo: Repo, number: number): IssueFact[] {
  integer(number, "parent issue number");
  const result: IssueFact[] = [];
  const seen = new Set<number>([number]);
  function visit(parent: number, ancestors: Set<number>): void {
    const children = list(repo, `${pathFor(repo)}/issues/${parent}/sub_issues?per_page=100`);
    for (const child of children) {
      const identity = issueIdentity(child, repo);
      sameRepository(identity, repo);
      if (ancestors.has(identity.number)) fail(`sub-issue cycle at ${identity.url}`);
      if (seen.has(identity.number)) continue;
      seen.add(identity.number);
      result.push(issue(repo, identity.number));
      visit(identity.number, new Set([...ancestors, identity.number]));
    }
  }
  visit(number, new Set([number]));
  return result;
}

function checkStatus(status: unknown, conclusion: unknown): CheckFact["status"] {
  if (["queued", "in_progress", "requested", "waiting", "pending"].includes(String(status))) return "pending";
  if (status !== "completed") return "unknown";
  if (conclusion === "success") return "pass";
  if (conclusion === "startup_failure") return "startup_failure";
  if (conclusion === "skipped" || conclusion === "neutral") return "skipped";
  if (["failure", "timed_out", "cancelled", "action_required", "stale"].includes(String(conclusion))) return "failed";
  return "unknown";
}

function checksForCommit(repo: Repo, commit: string): CheckFact[] {
  const prefix = pathFor(repo);
  // GitHub 的 ref/check-runs 只覆盖最近 1000 个 suites，不能把截断结果称为完整。
  const suites = list(repo, `${prefix}/commits/${commit}/check-suites?per_page=100`, "check_suites");
  if (suites.length > 1000) fail(`commit ${commit} has over 1000 check suites; check-runs endpoint would truncate`);
  const runs = list(repo, `${prefix}/commits/${commit}/check-runs?filter=latest&per_page=100`, "check_runs");
  const statuses = list(repo, `${prefix}/commits/${commit}/status?per_page=100`, "statuses");
  const workflows = list(repo, `${prefix}/actions/runs?head_sha=${commit}&per_page=100`, "workflow_runs");
  // 官方 head_sha 搜索上限为 1000；边界上无法证明完整时明确失败。
  if (workflows.length >= 1000) fail(`commit ${commit} reached the Actions search cap (1000); cannot prove complete observation`);
  const knownSuites = new Set(workflows
    .filter(w => w.check_suite_id !== null && w.check_suite_id !== undefined)
    .map(w => integer(w.check_suite_id, "workflow.check_suite_id")));
  const checks: CheckFact[] = [];
  for (const run of runs) {
    const app = object(run.app, "check.app");
    const suite = object(run.check_suite, "check.check_suite");
    // Actions 用下面的完整 workflow/jobs 观察取代，避免旧 run 的同名检查阻塞新 run。
    if (app.slug === "github-actions" && knownSuites.has(integer(suite.id, "check_suite.id"))) continue;
    checks.push({ id: `check:${integer(run.id, "check.id")}`, name: string(run.name, "check.name"),
      status: checkStatus(run.status, run.conclusion), url: string(run.html_url, "check.html_url") });
  }
  for (const status of statuses) {
    const normalized = status.state === "success" ? "pass" : status.state === "pending" ? "pending"
      : status.state === "failure" || status.state === "error" ? "failed" : "unknown";
    checks.push({ id: `status:${integer(status.id, "status.id")}`, name: string(status.context, "status.context"),
      status: normalized, url: status.target_url === null ? string(status.url, "status.url") : string(status.target_url, "status.target_url") });
  }
  // 同一候选的 workflow+event+branch 仅取最新 run；同 run 的 jobs 使用 latest attempt。
  const latest = new Map<string, JsonObject>();
  for (const workflow of workflows) {
    if (sha(workflow.head_sha, "workflow.head_sha") !== commit) fail("Actions returned an unrelated candidate");
    const key = JSON.stringify([integer(workflow.workflow_id, "workflow_id"), string(workflow.event, "workflow.event"), workflow.head_branch]);
    const previous = latest.get(key);
    if (!previous || integer(workflow.id, "workflow.id") > integer(previous.id, "workflow.id")) latest.set(key, workflow);
  }
  for (const workflow of latest.values()) {
    const id = integer(workflow.id, "workflow.id");
    const name = workflow.name === null || workflow.name === undefined
      ? `workflow ${integer(workflow.workflow_id, "workflow_id")}` : string(workflow.name, "workflow.name");
    const jobs = list(repo, `${prefix}/actions/runs/${id}/jobs?filter=latest&per_page=100`, "jobs");
    let state = checkStatus(workflow.status, workflow.conclusion);
    if (state === "failed" && workflow.conclusion === "failure" && jobs.length === 0) state = "startup_failure";
    checks.push({ id: `workflow:${id}`, name: `${name} (${string(workflow.event, "workflow.event")})`,
      status: state, url: string(workflow.html_url, "workflow.html_url") });
    for (const job of jobs) {
      const steps = job.steps === null || job.steps === undefined ? undefined : array(job.steps, "job.steps");
      let state = checkStatus(job.status, job.conclusion);
      // 没有执行步骤的失败不被误报为测试断言失败，更不会因计费原因被记为通过。
      if (state === "failed" && job.conclusion === "failure" && steps?.length === 0) state = "startup_failure";
      checks.push({ id: `job:${integer(job.id, "job.id")}`, name: `${name} / ${string(job.name, "job.name")}`,
        status: state, url: string(job.html_url, "job.html_url") });
    }
  }
  return checks;
}

function prFields(raw: JsonObject, repo: Repo, number: number): Omit<PrFact, "checks"> {
  if (integer(raw.number, "pr.number") !== number) fail("PR response number differs from request");
  const url = webURL(raw.html_url, "pr.html_url");
  if (url.host !== repo.host || url.pathname.toLowerCase() !== `/${repo.slug}/pull/${number}`.toLowerCase()) fail("PR belongs to another repository");
  const head = object(raw.head, "pr.head");
  const base = object(raw.base, "pr.base");
  const state = boolean(raw.merged, "pr.merged") ? "MERGED" : issueState(raw.state);
  return { number, url: url.href, head: sha(head.sha, "pr.head.sha"), base: sha(base.sha, "pr.base.sha"),
    headRef: string(head.ref, "pr.head.ref"), baseRef: string(base.ref, "pr.base.ref"), state,
    draft: boolean(raw.draft, "pr.draft"),
    mergeable: raw.mergeable === true ? "MERGEABLE" : raw.mergeable === false ? "CONFLICTING" : "UNKNOWN",
    mergedHead: state === "MERGED" ? sha(raw.merge_commit_sha, "pr.merge_commit_sha") : "" };
}

export function pr(repo: Repo, number: number): PrFact {
  integer(number, "PR number");
  const endpoint = `${pathFor(repo)}/pulls/${number}`;
  const raw = object(api(repo, endpoint), endpoint);
  const fact = prFields(raw, repo, number);
  const commits = new Set([fact.head]);
  // pull_request CI 可能附在测试合并提交；仅开放 PR 的该提交属于当前候选。
  if (fact.state === "OPEN" && raw.merge_commit_sha !== null) commits.add(sha(raw.merge_commit_sha, "pr.merge_commit_sha"));
  const checks = [...commits].flatMap(commit => checksForCommit(repo, commit));
  const currentRaw = object(api(repo, endpoint), endpoint);
  const current = prFields(currentRaw, repo, number);
  const stable = (p: Omit<PrFact, "checks">) => [p.head, p.base, p.baseRef, p.headRef, p.state, p.draft, p.mergedHead];
  if (JSON.stringify(stable(fact)) !== JSON.stringify(stable(current)) || raw.merge_commit_sha !== currentRaw.merge_commit_sha) {
    fail(`PR #${number} changed while checks were being read; re-observe before taking action`);
  }
  // mergeability 的后台计算可从 null 完成；返回第二次观察，UNKNOWN 仍由上层等待。
  return { ...current, checks: [...new Map(checks.map(c => [c.id, c])).values()] };
}
