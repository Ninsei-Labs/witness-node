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

function findings(checkText, publishText) {
  const problems = [];
  const need = (text, needle, message) => { if (!text.includes(needle)) problems.push(message); };
  need(checkText, "types: [opened, synchronize, reopened, ready_for_review]",
    "check.yml does not start on ready_for_review");
  need(checkText, "github.event.pull_request.draft == false",
    "check.yml does not skip a draft pull request");
  need(publishText, "environment: publish", "publish.yml has no protected environment");
  need(publishText, "fetch-depth: 0", "publish.yml cannot prove ancestry without history");
  need(publishText, "git merge-base --is-ancestor", "publish.yml does not require the tagged commit on main");
  need(publishText, "actions/workflows/check.yml/runs", "publish.yml does not read the tagged commit's CI run");
  need(publishText, "state\" != success", "publish.yml does not refuse a CI run that did not pass");
  need(checkText, "repository: Ninsei-Labs/sdk", "check.yml does not check out the SDK client");
  need(checkText, "run: bun run check:interop", "check.yml does not run the SDK/witness interop check");
  need(publishText, "repository: Ninsei-Labs/sdk", "publish.yml does not check out the SDK client");
  need(publishText, "run: bun run check:interop", "publish.yml does not run the SDK/witness interop check");
  need(publishText, "--provenance=true", "publish.yml publishes without provenance");
  need(publishText, "!contains(github.ref_name, '-')", "publish.yml moves latest for a pre-release");
  need(publishText, "imagetools create -t \"$IMAGE:latest\"", "publish.yml does not move latest to the tagged digest");
  return problems;
}

const problems = findings(check, publish);
assert.deepEqual(problems, [], problems.join("\n"));

// THE GUARD CAN FAIL. Removing each fact from a copy must name that fact.
const mutations = [
  ["types: [opened, synchronize, reopened, ready_for_review]", "", "check.yml does not start on ready_for_review"],
  ["github.event.pull_request.draft == false", "", "check.yml does not skip a draft pull request"],
  ["environment: publish", "", "publish.yml has no protected environment"],
  ["fetch-depth: 0", "", "publish.yml cannot prove ancestry without history"],
  ["git merge-base --is-ancestor", "", "publish.yml does not require the tagged commit on main"],
  ["actions/workflows/check.yml/runs", "", "publish.yml does not read the tagged commit's CI run"],
  ["state\" != success", "", "publish.yml does not refuse a CI run that did not pass"],
  ["repository: Ninsei-Labs/sdk", "", "check.yml does not check out the SDK client"],
  ["run: bun run check:interop", "", "check.yml does not run the SDK/witness interop check"],
  ["--provenance=true", "", "publish.yml publishes without provenance"],
  ["!contains(github.ref_name, '-')", "", "publish.yml moves latest for a pre-release"],
  ["imagetools create -t \"$IMAGE:latest\"", "", "publish.yml does not move latest to the tagged digest"],
];
for (const [needle, replacement, message] of mutations) {
  const checkCopy = check.replace(needle, replacement);
  const publishCopy = publish.replace(needle, replacement);
  const result = findings(checkCopy, publishCopy);
  assert.ok(result.includes(message), "the workflow check accepted a copy without: " + message);
}

console.log("workflow checks: publish gates and the ready-for-review trigger are present");
