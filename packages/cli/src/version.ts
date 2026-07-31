/** The published version, as a literal.
 *
 * `init` writes it into the scaffolded workflow (`npx rankloop@<version>`),
 * so it has to be readable without a filesystem lookup relative to a bundled
 * dist file. `test/version.test.ts` asserts it matches package.json, which is
 * cheaper than making the build clever. */
export const VERSION = "2.0.0-dev";
