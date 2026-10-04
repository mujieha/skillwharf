import { allowProtocolsForTests } from "./src/git.js";

// The test suite fakes git hosts with `url.<file://dir>.insteadOf` rewrites, and
// GIT_ALLOW_PROTOCOL (which the product always sets) applies after the rewrite.
// Tests of the guard itself call allowProtocolsForTests([]) in their own setup.
// Test-only: the built command line (dist/cli.js, run by the tests as a child process) never sees this allowance.
allowProtocolsForTests(["file"]);
