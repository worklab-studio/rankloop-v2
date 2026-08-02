// The scaffold's output is generated as a STRING, which means every
// content-based test above can pass while the file does not parse. A
// template with a stray brace ships a pull request that fails the user's CI
// — the single worst outcome this feature has — and no `toContain` assertion
// would catch it.
//
// So the generated code goes through the TypeScript compiler here. This is
// syntax, not type-checking: the imports (next/link, marked, node:fs) cannot
// resolve outside the user's repo, and a parse error is the failure mode
// that actually reaches them.

import { describe, expect, it } from "vitest";
import ts from "typescript";
import { buildScaffold } from "./scaffold.logic";
import { extractTheme } from "./theme.logic";
import type { StackId } from "./stack.logic";

const THEME = extractTheme([
  `${"color: rgb(0, 153, 255);".repeat(30)}${"background: rgb(255,255,255);".repeat(30)}`,
]);

function syntaxErrorsIn(code: string, fileName: string): string[] {
  const result = ts.transpileModule(code, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true,
    },
  });
  return (result.diagnostics ?? []).map((d) =>
    ts.flattenDiagnosticMessageText(d.messageText, " "),
  );
}

describe("generated TypeScript parses", () => {
  for (const stack of ["next-app", "next-pages"] as StackId[]) {
    it(`${stack} templates compile without syntax errors`, () => {
      const { files } = buildScaffold({
        stack,
        blogPath: "blog",
        theme: THEME,
        packageJson: null,
      });
      const tsFiles = files.filter((f) => f.path.endsWith(".tsx"));
      expect(tsFiles.length).toBeGreaterThan(0);

      for (const file of tsFiles) {
        expect(syntaxErrorsIn(file.content, file.path), file.path).toEqual([]);
      }
    });
  }

  it("survives a blog root that would break a template literal", () => {
    // The blog root is interpolated into generated source in several places,
    // including inside template literals and string literals. A root
    // containing a quote or a backtick would close one of them early and
    // produce a file that does not parse.
    const { files } = buildScaffold({
      stack: "next-app",
      blogPath: 'we"ird',
      theme: THEME,
      packageJson: null,
    });
    for (const file of files.filter((f) => f.path.endsWith(".tsx"))) {
      expect(syntaxErrorsIn(file.content, file.path), file.path).toEqual([]);
    }
  });
});

describe("generated Astro frontmatter parses", () => {
  it("the script block of each .astro file is valid TypeScript", () => {
    // Astro files are not TypeScript, but the fenced block at the top is,
    // and that is where every expression lives.
    const { files } = buildScaffold({
      stack: "astro",
      blogPath: "blog",
      theme: THEME,
      packageJson: null,
    });
    const astroFiles = files.filter((f) => f.path.endsWith(".astro"));
    expect(astroFiles.length).toBeGreaterThan(0);

    for (const file of astroFiles) {
      const fence = /^---\n([\s\S]*?)\n---/.exec(file.content);
      expect(fence, `${file.path} has no frontmatter fence`).not.toBeNull();
      expect(
        syntaxErrorsIn(fence?.[1] ?? "", file.path.replace(".astro", ".ts")),
        file.path,
      ).toEqual([]);
    }
  });
});

describe("generated CSS is balanced", () => {
  it("has matching braces", () => {
    // A stylesheet with an unclosed rule silently drops everything after it,
    // which looks like the theme not applying rather than a broken file.
    const { files } = buildScaffold({
      stack: "next-app",
      blogPath: "blog",
      theme: THEME,
      packageJson: null,
    });
    const css = files.find((f) => f.path.endsWith(".css"))?.content ?? "";
    const open = (css.match(/\{/g) ?? []).length;
    const close = (css.match(/\}/g) ?? []).length;
    expect(open).toBe(close);
    expect(open).toBeGreaterThan(0);
  });
});

describe("generated HTML is balanced", () => {
  it("closes every tag it opens", () => {
    const { files } = buildScaffold({
      stack: "static",
      blogPath: "blog",
      theme: THEME,
      packageJson: null,
    });
    for (const file of files.filter((f) => f.path.endsWith(".html"))) {
      for (const tag of ["html", "head", "body", "main"]) {
        expect((file.content.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length, `${file.path} <${tag}>`).toBe(1);
        expect((file.content.match(new RegExp(`</${tag}>`, "g")) ?? []).length, `${file.path} </${tag}>`).toBe(1);
      }
    }
  });
});
