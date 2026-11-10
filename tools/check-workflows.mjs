#!/usr/bin/env node
// THE RELEASE DOES NOT SHIP ITSELF. Two workflow facts are load-bearing:
//   * a pull request that becomes ready starts the checks, so a draft stays quiet and a ready PR is tested;
//   * a tag publishes only a commit on main whose check passed, behind an environment, with provenance, and a
//     pre-release never moves latest.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = readFileSync(join(ROOT, ".github", "workflows", "check.yml"), "utf8");
const publish = readFileSync(join(ROOT, ".github", "workflows", "publish.yml"), "utf8");

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
  need(checkText, "run: bun run check:interop", "check.yml does not run the SDK/witness interop check");
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

const problems = findings(check, publish);
assert.deepEqual(problems, [], problems.join("\n"));

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
  ["run: bun run check:interop", "", "check.yml does not run the SDK/witness interop check"],
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
  const checkCopy = check.replace(needle, replacement);
  const publishCopy = publish.replace(needle, replacement);
  const result = findings(checkCopy, publishCopy);
  assert.ok(result.includes(message), "the workflow check accepted a copy without: " + message);
}

console.log("workflow checks: publish gates, their order and the ready-for-review trigger are enforced");
