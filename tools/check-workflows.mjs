#!/usr/bin/env node
// THE RELEASE DOES NOT SHIP ITSELF. Two workflow facts are load-bearing:
//   * a pull request that becomes ready starts the checks, so a draft stays quiet and a ready PR is tested;
//   * a tag publishes only a commit on main whose check passed, behind an environment, with provenance, and a
//     pre-release never moves latest.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLISH_SDK_PIN = "20515404f5546680ba609b71074d977bd2444196";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = readFileSync(join(ROOT, ".github", "workflows", "check.yml"), "utf8");
const publish = readFileSync(join(ROOT, ".github", "workflows", "publish.yml"), "utf8");
const codeql = readFileSync(join(ROOT, ".github", "workflows", "codeql.yml"), "utf8");
const imageScan = readFileSync(join(ROOT, ".github", "workflows", "image-scan.yml"), "utf8");

function namedSteps(text) {
  const result = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+name:\s*(.+?)\s*$/);
    if (match) {
      if (current) result.push(current);
      current = { name: match[1], body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) result.push(current);
  return result;
}

function stepOf(text, name) {
  return namedSteps(text).find((step) => step.name === name) || null;
}

function positionOf(text, name) {
  return text.indexOf("- name: " + name);
}

function findings(checkText, publishText) {
  const problems = [];
  const need = (text, needle, message) => { if (!text.includes(needle)) problems.push(message); };
  const forbid = (text, label) => {
    if (/^\s*if:\s*false\s*$/m.test(text)) problems.push(label + " has if: false");
    if (/continue-on-error:\s*(true|\$\{\{\s*true\s*\}\})/m.test(text)) {
      problems.push(label + " has continue-on-error: true");
    }
  };
  const ordered = (text, first, second, message) => {
    const a = positionOf(text, first);
    const b = positionOf(text, second);
    if (a < 0 || b < 0 || a >= b) problems.push(message);
  };

  forbid(checkText, "check.yml");
  forbid(publishText, "publish.yml");

  need(checkText, "types: [opened, synchronize, reopened, ready_for_review]",
    "check.yml does not start on ready_for_review");
  need(checkText, "github.event.pull_request.draft == false",
    "check.yml does not skip a draft pull request");
  need(checkText, "repository: Ninsei-Labs/sdk", "check.yml does not check out the SDK client");
  need(checkText, "ref: " + PUBLISH_SDK_PIN, "check.yml does not pin the SDK commit");
  need(checkText, "Run the SDK/witness interop check", "check.yml does not run the SDK/witness interop check");
  need(checkText, "Run the real monerod regtest check", "check.yml does not run the real monerod regtest check");
  need(checkText, "Versions must agree before a build", "check.yml has no version agreement gate");
  ordered(checkText, "Versions must agree before a build", "Build the image",
    "check.yml builds before checking that the versions agree");
  ordered(checkText, "Check out the SDK client", "Build the image",
    "check.yml builds before checking out the SDK client");
  ordered(checkText, "Run the witness checks", "Build the image",
    "check.yml builds before running the witness checks");
  ordered(checkText, "Run the SDK/witness interop check", "Build the image",
    "check.yml builds before the interop check");

  need(publishText, "environment: publish", "publish.yml has no protected environment");
  need(publishText, "fetch-depth: 0", "publish.yml cannot prove ancestry without history");
  need(publishText, "git merge-base --is-ancestor", "publish.yml does not require the tagged commit on main");
  need(publishText, "actions/workflows/check.yml/runs", "publish.yml does not read the tagged commit's CI run");
  need(publishText, "state\" != success", "publish.yml does not refuse a CI run that did not pass");
  need(publishText, "repository: Ninsei-Labs/sdk", "publish.yml does not check out the SDK client");
  need(publishText, "ref: " + PUBLISH_SDK_PIN, "publish.yml does not pin the SDK commit");
  need(publishText, "Versions must agree before a build", "publish.yml has no version agreement gate");
  ordered(publishText, "Versions must agree before a build", "Push the tagged image with provenance",
    "publish.yml pushes before checking that the versions agree");
  need(publishText, "run: bun run check:interop", "publish.yml does not run the SDK/witness interop check");
  need(publishText, "--provenance=true", "publish.yml publishes without provenance");
  need(publishText, "!contains(github.ref_name, '-')", "publish.yml moves latest for a pre-release");
  need(publishText, "imagetools create -t \"$IMAGE:latest\"", "publish.yml does not move latest to the tagged digest");

  ordered(publishText, "Version must match the tag", "Push the tagged image with provenance",
    "publish.yml pushes before checking the version");
  ordered(publishText, "The commit is on main and its CI passed", "Push the tagged image with provenance",
    "publish.yml pushes before checking the commit on main and its CI");
  ordered(publishText, "Run the witness checks", "Push the tagged image with provenance",
    "publish.yml pushes before running the witness checks");
  ordered(publishText, "Run the SDK/witness interop check", "Push the tagged image with provenance",
    "publish.yml pushes before the interop check");
  ordered(publishText, "Run the container smoke", "Push the tagged image with provenance",
    "publish.yml pushes before the container smoke");
  ordered(publishText, "Push the tagged image with provenance", "Move latest only for a release tag",
    "publish.yml moves latest before the tagged image is pushed");

  const ciGate = stepOf(publishText, "The commit is on main and its CI passed");
  if (!ciGate) problems.push("publish.yml has no commit and CI gate");
  else {
    const body = ciGate.body.join("\n");
    need(body, "branch=main", "publish.yml does not filter the CI run to main");
    if (!body.includes("exit 1")) problems.push("publish.yml does not fail the commit and CI gate");
    if (body.includes("exit 0")) problems.push("publish.yml can finish a failed CI gate with exit 0");
  }

  const versionGate = stepOf(publishText, "Version must match the tag");
  if (!versionGate) problems.push("publish.yml has no version gate");
  else {
    const body = versionGate.body.join("\n");
    if (!body.includes("exit 1")) problems.push("publish.yml does not fail the version gate");
    if (body.includes("exit 0")) problems.push("publish.yml can finish a failed version gate with exit 0");
  }

  const latest = stepOf(publishText, "Move latest only for a release tag");
  if (!latest) problems.push("publish.yml has no latest step");
  else {
    const body = latest.body.join("\n");
    if (!body.includes("if: ${{ !contains(github.ref_name, '-') }}")) {
      problems.push("publish.yml moves latest without the release condition");
    }
    if (/always\s*\(/.test(body)) problems.push("publish.yml moves latest unconditionally");
  }

  return problems;
}

function codeqlFindings(text) {
  const problems = [];
  const need = (needle, message) => { if (!text.includes(needle)) problems.push(message); };
  need("pull_request:", "codeql.yml does not run on pull requests");
  need("types: [opened, synchronize, reopened, ready_for_review]",
    "codeql.yml does not start on ready_for_review");
  need("github.event.pull_request.draft == false", "codeql.yml does not skip a draft pull request");
  need("security-events: write", "codeql.yml cannot upload analysis results");
  need("push:", "codeql.yml lost its push scan");
  need("schedule:", "codeql.yml lost its scheduled scan");
  return problems;
}

const problems = findings(check, publish);
assert.deepEqual(problems, [], problems.join("\n"));

const codeqlProblems = codeqlFindings(codeql);
assert.deepEqual(codeqlProblems, [], codeqlProblems.join("\n"));

function imageScanFindings(text) {
  const problems = [];
  const need = (needle, message) => { if (!text.includes(needle)) problems.push(message); };
  need("schedule:", "image-scan.yml lost its scheduled run");
  need("workflow_dispatch:", "image-scan.yml cannot be started by hand");
  need("aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25",
    "image-scan.yml does not pin the Trivy action by commit");
  need("ignore-unfixed: true", "image-scan.yml does not ignore findings without a fix");
  need('exit-code: "1"', "image-scan.yml does not fail on a finding");
  need("severity: CRITICAL,HIGH", "image-scan.yml does not scan Critical and High findings");
  need("docker buildx imagetools inspect", "image-scan.yml cannot detect a stale base digest");
  return problems;
}

const imageScanProblems = imageScanFindings(imageScan);
assert.deepEqual(imageScanProblems, [], imageScanProblems.join("\n"));

// THE GUARD CAN FAIL. Removing each fact from a copy must name that fact.
const mutations = [
  ["types: [opened, synchronize, reopened, ready_for_review]", "", "check.yml does not start on ready_for_review"],
  ["github.event.pull_request.draft == false", "", "check.yml does not skip a draft pull request"],
  ["environment: publish", "", "publish.yml has no protected environment"],
  ["Version must match the tag", "", "publish.yml has no version gate"],
  ["fetch-depth: 0", "", "publish.yml cannot prove ancestry without history"],
  ["git merge-base --is-ancestor", "", "publish.yml does not require the tagged commit on main"],
  ["actions/workflows/check.yml/runs", "", "publish.yml does not read the tagged commit's CI run"],
  ["state\" != success", "", "publish.yml does not refuse a CI run that did not pass"],
  ["repository: Ninsei-Labs/sdk", "", "check.yml does not check out the SDK client"],
  ["ref: " + PUBLISH_SDK_PIN, "ref: main", "check.yml does not pin the SDK commit"],
  ["Run the real monerod regtest check", "", "check.yml does not run the real monerod regtest check"],
  ["run: bun run check:interop", "", "publish.yml does not run the SDK/witness interop check"],
  ["Versions must agree before a build", "Version check missing", "check.yml has no version agreement gate"],
  ["--provenance=true", "", "publish.yml publishes without provenance"],
  ["!contains(github.ref_name, '-')", "", "publish.yml moves latest for a pre-release"],
  ["imagetools create -t \"$IMAGE:latest\"", "", "publish.yml does not move latest to the tagged digest"],
  ["if: github.event_name != 'pull_request' || github.event.pull_request.draft == false", "if: false",
    "check.yml has if: false"],
  ["runs-on: ubuntu-latest", "runs-on: ubuntu-latest\n    continue-on-error: true",
    "publish.yml has continue-on-error: true"],
  ["&branch=main", "", "publish.yml does not filter the CI run to main"],
  ["echo \"CI has not passed for $sha ($state)\" >&2\n            exit 1",
    "echo \"CI has not passed for $sha ($state)\" >&2\n            exit 0",
    "publish.yml can finish a failed CI gate with exit 0"],
  ["if: ${{ !contains(github.ref_name, '-') }}", "if: ${{ always() }}",
    "publish.yml moves latest without the release condition"],
];
for (const [needle, replacement, message] of mutations) {
  const checkCopy = check.replaceAll(needle, replacement);
  const publishCopy = publish.replaceAll(needle, replacement);
  const result = findings(checkCopy, publishCopy);
  assert.ok(result.includes(message), "the workflow check accepted a copy without: " + message);
}

const codeqlMutations = [
  ["pull_request:", "", "codeql.yml does not run on pull requests"],
  ["types: [opened, synchronize, reopened, ready_for_review]", "",
    "codeql.yml does not start on ready_for_review"],
  ["github.event.pull_request.draft == false", "", "codeql.yml does not skip a draft pull request"],
  ["security-events: write", "", "codeql.yml cannot upload analysis results"],
  ["push:", "", "codeql.yml lost its push scan"],
  ["schedule:", "", "codeql.yml lost its scheduled scan"],
];
for (const [needle, replacement, message] of codeqlMutations) {
  const result = codeqlFindings(codeql.replaceAll(needle, replacement));
  assert.ok(result.includes(message), "the workflow check accepted a copy without: " + message);
}

const imageScanMutations = [
  ["schedule:", "", "image-scan.yml lost its scheduled run"],
  ["workflow_dispatch:", "", "image-scan.yml cannot be started by hand"],
  ["aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25", "aquasecurity/trivy-action@v0.36.0",
    "image-scan.yml does not pin the Trivy action by commit"],
  ["ignore-unfixed: true", "ignore-unfixed: false", "image-scan.yml does not ignore findings without a fix"],
  ['exit-code: "1"', 'exit-code: "0"', "image-scan.yml does not fail on a finding"],
  ["severity: CRITICAL,HIGH", "severity: HIGH", "image-scan.yml does not scan Critical and High findings"],
  ["docker buildx imagetools inspect", "", "image-scan.yml cannot detect a stale base digest"],
];
for (const [needle, replacement, message] of imageScanMutations) {
  const result = imageScanFindings(imageScan.replaceAll(needle, replacement));
  assert.ok(result.includes(message), "the workflow check accepted a copy without: " + message);
}

console.log("workflow checks: publish gates, their order, the ready-for-review trigger, CodeQL on PRs and the image scan are enforced");
