#!/usr/bin/env node
// ONE VERSION, THREE PLACES. The package version is what the image labels carry, the compose file is what an
// operator deploys, and a release tag is what the owner pushes. A mismatch in any pair means the image and the
// deployment disagree, and the previous release died at the publish step after the tag had already been made.
//
// THE RUNTIME IS ANOTHER THREE PLACES. `packageManager`, both workflow setup steps and the Dockerfile base image
// must name the same Bun release. A green app-version check with a stale runtime is still a broken release image.
//
// This check runs BEFORE any image build in both workflows. It reads the real files, compares the values, and
// names each disagreement. `--self-test` proves the comparison can go red without touching the tree.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TAG = /^v?(\d+\.\d+\.\d+)$/;

export function versionsFrom({ packageText, composeText, tag = null }) {
  const pkg = JSON.parse(packageText);
  const packageVersion = String(pkg.version || "");
  const composeMatch = String(composeText).match(/ghcr\.io\/ninsei-labs\/witness-node:v([0-9]+\.[0-9]+\.[0-9]+)/);
  const composeVersion = composeMatch ? composeMatch[1] : null;
  const tagVersion = tag === null || tag === undefined || tag === "" ? null : (String(tag).match(TAG) || [])[1] || null;
  return { packageVersion, composeVersion, tagVersion, tag };
}

export function runtimeFrom({ packageText, checkText, publishText, dockerfileText }) {
  const pkg = JSON.parse(packageText);
  const manager = String(pkg.packageManager || "");
  const engine = String((pkg.engines && pkg.engines.bun) || "");
  const bunVersion = manager.match(/^bun@(\d+\.\d+\.\d+)$/)?.[1] || null;
  const engineVersion = engine.match(/^>=\s*(\d+\.\d+\.\d+)$/)?.[1] || null;
  const workflowVersion = (text) => String(text).match(/bun-version:\s*(\d+\.\d+\.\d+)/)?.[1] || null;
  const docker = String(dockerfileText).match(/FROM\s+oven\/bun:(\d+\.\d+\.\d+)-slim(?:@sha256:([0-9a-f]{64}))?/i);
  return {
    bunVersion,
    engineVersion,
    checkVersion: workflowVersion(checkText),
    publishVersion: workflowVersion(publishText),
    dockerVersion: docker ? docker[1] : null,
    dockerDigest: docker ? docker[2] : null,
  };
}

export function versionProblems({ packageVersion, composeVersion, tagVersion, tag = null }) {
  const problems = [];
  if (!packageVersion) problems.push("package.json has no version");
  if (!composeVersion) problems.push("compose.yaml does not pin ghcr.io/ninsei-labs/witness-node:vX.Y.Z");
  if (packageVersion && composeVersion && packageVersion !== composeVersion) {
    problems.push("package.json says " + packageVersion + ", compose.yaml pins v" + composeVersion);
  }
  if (tag !== null && tag !== undefined && tag !== "") {
    if (!tagVersion) problems.push("the tag " + JSON.stringify(tag) + " is not vX.Y.Z");
    else if (packageVersion && tagVersion !== packageVersion) {
      problems.push("package.json says " + packageVersion + ", the tag is v" + tagVersion);
    }
  }
  return problems;
}

export function runtimeProblems({ bunVersion, engineVersion, checkVersion, publishVersion, dockerVersion, dockerDigest }) {
  const problems = [];
  if (!bunVersion) problems.push("package.json packageManager is not bun@X.Y.Z");
  if (!engineVersion) problems.push("package.json engines.bun is not >=X.Y.Z");
  else if (bunVersion && engineVersion !== bunVersion) {
    problems.push("package.json engines.bun says >=" + engineVersion + ", packageManager says " + bunVersion);
  }
  if (bunVersion && checkVersion !== bunVersion) problems.push("check.yml bun-version is not " + bunVersion);
  if (bunVersion && publishVersion !== bunVersion) problems.push("publish.yml bun-version is not " + bunVersion);
  if (!dockerVersion) problems.push("Dockerfile does not use oven/bun:X.Y.Z-slim");
  else if (bunVersion && dockerVersion !== bunVersion) {
    problems.push("Dockerfile uses Bun " + dockerVersion + ", packageManager says " + bunVersion);
  }
  if (!dockerDigest) problems.push("Dockerfile Bun image has no sha256 digest");
  return problems;
}

function cases() {
  const pkg = (v, bun = "1.4.5", engine = bun) => JSON.stringify({ name: "@ninsei-labs/witness-node", version: v,
    packageManager: "bun@" + bun, engines: { bun: ">=" + engine } });
  const compose = (v) => "services:\n  witness:\n    image: ghcr.io/ninsei-labs/witness-node:v" + v + "\n";
  const workflow = (v) => "      - uses: oven-sh/setup-bun@x\n        with:\n          bun-version: " + v + "\n";
  const dockerfile = (v = "1.4.5", digest = "a".repeat(64)) => "FROM oven/bun:" + v + "-slim@sha256:" + digest + "\n";
  const verify = ({ packageText, composeText, tag }) => versionProblems(versionsFrom({ packageText, composeText, tag }));
  const runtime = ({ packageText, checkText = workflow("1.4.5"), publishText = workflow("1.4.5"),
    dockerfileText = dockerfile() }) => runtimeProblems(runtimeFrom({ packageText, checkText, publishText, dockerfileText }));

  assert.deepEqual(verify({ packageText: pkg("0.1.2"), composeText: compose("0.1.2"), tag: "v0.1.2" }), []);
  assert.match(verify({ packageText: pkg("0.1.2"), composeText: compose("0.1.1"), tag: "v0.1.2" }).join("\n"),
    /package\.json says 0\.1\.2, compose\.yaml pins v0\.1\.1/);
  assert.match(verify({ packageText: pkg("0.1.2"), composeText: compose("0.1.2"), tag: "v0.1.1" }).join("\n"),
    /package\.json says 0\.1\.2, the tag is v0\.1\.1/);
  assert.match(verify({ packageText: pkg("0.1.2"), composeText: compose("0.1.2"), tag: "not-a-release" }).join("\n"),
    /is not vX\.Y\.Z/);
  assert.deepEqual(runtime({ packageText: pkg("0.1.2") }), []);
  assert.match(runtime({ packageText: pkg("0.1.2", "1.4.5", "1.4.4") }).join("\n"), /engines\.bun says >=1\.4\.4/);
  assert.match(runtime({ packageText: pkg("0.1.2"), checkText: workflow("1.4.4") }).join("\n"),
    /check\.yml bun-version is not 1\.4\.5/);
  assert.match(runtime({ packageText: pkg("0.1.2"), publishText: workflow("1.4.4") }).join("\n"),
    /publish\.yml bun-version is not 1\.4\.5/);
  assert.match(runtime({ packageText: pkg("0.1.2"), dockerfileText: dockerfile("1.4.4") }).join("\n"),
    /Dockerfile uses Bun 1\.4\.4/);
  assert.match(runtime({ packageText: pkg("0.1.2"), dockerfileText: dockerfile("1.4.5", "") }).join("\n"),
    /has no sha256 digest/);
  console.log("version checks: 10 cases passed");
}

if (process.argv.includes("--self-test")) {
  cases();
} else {
  const versions = versionsFrom({
    packageText: readFileSync(join(ROOT, "package.json"), "utf8"),
    composeText: readFileSync(join(ROOT, "compose.yaml"), "utf8"),
    // GITHUB_REF_NAME is "main" or a branch on ordinary runs. Only a tag is a version, and only a tag is compared.
    tag: /^v\d+\.\d+\.\d+$/.test(process.env.GITHUB_REF_NAME || "") ? process.env.GITHUB_REF_NAME : null,
  });
  const runtime = runtimeFrom({
    packageText: readFileSync(join(ROOT, "package.json"), "utf8"),
    checkText: readFileSync(join(ROOT, ".github", "workflows", "check.yml"), "utf8"),
    publishText: readFileSync(join(ROOT, ".github", "workflows", "publish.yml"), "utf8"),
    dockerfileText: readFileSync(join(ROOT, "Dockerfile"), "utf8"),
  });
  const problems = [...versionProblems(versions), ...runtimeProblems(runtime)];
  if (problems.length) {
    for (const problem of problems) console.error("version: " + problem);
    process.exit(1);
  }
  console.log("versions agree: package.json " + versions.packageVersion
    + ", compose.yaml v" + versions.composeVersion
    + (versions.tagVersion ? ", tag v" + versions.tagVersion : "")
    + "; Bun " + runtime.bunVersion + " in package.json, both workflows and Dockerfile");
}
