/**
 * The only place skillwharf runs git: fixed argument lists, no shell, stdin
 * closed, a protocol allowlist and a timeout.
 */

/** Extra transports a test run allows on top of https and ssh (see vitest.setup.ts). Never set outside tests. */
let extraProtocols: string[] = [];

/**
 * Test hook: let git use these transports in addition to https and ssh in this
 * process, so a test can point a host name at a local bare repository. It is
 * not reachable from the command line, the manifest, the lockfile or the environment.
 */
export function allowProtocolsForTests(extra: string[]): void {
  extraProtocols = [...extra];
}
