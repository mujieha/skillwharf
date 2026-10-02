import { allowProtocolsForTests } from "./src/git.js";

// The test suite fakes git hosts with `url.<file://dir>.insteadOf` rewrites, and
// GIT_ALLOW_PROTOCOL (which the product always sets) applies after the rewrite.
// Tests of the guard itself call allowProtocolsForTests([]) in their own setup.
allowProtocolsForTests(["file"]);
