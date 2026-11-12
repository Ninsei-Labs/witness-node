#!/usr/bin/env node
// ONE VERSION, THREE PLACES. The package version is what the image labels carry, the compose file is what an
// operator deploys, and a release tag is what the owner pushes. A mismatch in any pair means the image and the
// deployment disagree, and the previous release died at the publish step after the tag had already been made.
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

function cases() {
  const pkg = (v) => JSON.stringify({ name: "@ninsei-labs/witness-node", version: v });
  const compose = (v) => "services:\n  witness:\n    image: ghcr.io/ninsei-labs/witness-node:v" + v + "\n";
  const verify = ({ packageText, composeText, tag }) => versionProblems(versionsFrom({ packageText, composeText, tag }));

  assert.deepEqual(verify({ packageText: pkg("0.1.2"), composeText: compose("0.1.2"), tag: "v0.1.2" }), []);
  assert.match(verify({ packageText: pkg("0.1.2"), composeText: compose("0.1.1"), tag: "v0.1.2" }).join("\n"),
    /package\.json says 0\.1\.2, compose\.yaml pins v0\.1\.1/);
  assert.match(verify({ packageText: pkg("0.1.2"), composeText: compose("0.1.2"), tag: "v0.1.1" }).join("\n"),
    /package\.json says 0\.1\.2, the tag is v0\.1\.1/);
  assert.match(verify({ packageText: pkg("0.1.2"), composeText: compose("0.1.2"), tag: "not-a-release" }).join("\n"),
    /is not vX\.Y\.Z/);
  console.log("version checks: 4 cases passed");
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
  const problems = versionProblems(versions);
  if (problems.length) {
    for (const problem of problems) console.error("version: " + problem);
    process.exit(1);
  }
  console.log("versions agree: package.json " + versions.packageVersion
    + ", compose.yaml v" + versions.composeVersion
    + (versions.tagVersion ? ", tag v" + versions.tagVersion : ""));
}
