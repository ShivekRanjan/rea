import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { describe, expect } from "vitest";

import { historicalSourceGraphSchema } from "../../../src/domain/referenceSourceGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

// Reference-source reads require no-follow opens; Windows reports unsupported.
describe.skipIf(process.platform === "win32")(
  "compiled reference-source directory imports",
  () => {
    cliTest(
      "resolves directory spellings without selecting similarly named files",
      async ({ cli }) => {
        const workspace = await createTestTempDirectory(
          "rea-reference-directory-imports-",
        );
        const root = join(workspace, "source");
        const imports = [
          ["slash.cjs", "./lib/", "lib/index.js"],
          ["dot.cjs", "./lib/.", "lib/index.js"],
          ["self.cjs", ".", "index.js"],
          ["self-slash.cjs", "./", "index.js"],
          ["nested/parent.cjs", "..", "index.js"],
          ["nested/parent-slash.cjs", "../", "index.js"],
          ["direct.cjs", "./lib.js", "lib.js"],
          ["fallback.cjs", "./fallback", "fallback/index.js"],
          ["legacy-order.cjs", "./dep", "dep/index.js"],
          ["file-first.cjs", "./both", "both.js"],
          ["package-main.cjs", "./pkg", "pkg/actual.js"],
          ["package-main-file.cjs", "./entry", "entry/lib/entry.js"],
        ] as const;
        const unresolved = [
          ["missing.cjs", "./missing/", "missing/"],
          ["escape.cjs", "../outside/", "../outside/"],
          ["main.ts", "./folder.js/.", "folder.js"],
          ["broken-package.cjs", "./broken", "broken"],
        ] as const;
        const files = new Map<string, string>([
          ["index.js", 'module.exports = "root index";\n'],
          ["lib/index.js", 'module.exports = "library index";\n'],
          ["lib.js", 'module.exports = "sibling JavaScript file";\n'],
          ["lib.ts", 'export const value = "sibling TypeScript file";\n'],
          ["fallback/index.js", 'module.exports = "fallback index";\n'],
          ["dep/index.js", 'module.exports = "existing index priority";\n'],
          ["dep.cjs", 'module.exports = "later CommonJS candidate";\n'],
          [
            "folder.ts",
            'export const value = "emitted filename counterpart";\n',
          ],
          ["missing.js", 'module.exports = "not a directory";\n'],
          ["both.js", 'module.exports = "file before directory";\n'],
          ["both/index", 'module.exports = "extensionless index";\n'],
          ["pkg/package.json", JSON.stringify({ main: "actual.js" })],
          ["pkg/actual.js", 'module.exports = "package main";\n'],
          ["pkg/index.js", 'module.exports = "index after main";\n'],
          ["entry/package.json", JSON.stringify({ main: "lib/entry" })],
          ["entry/lib/entry.js", 'module.exports = "main with extension";\n'],
          ["entry/index.js", 'module.exports = "index after main";\n'],
          ["broken/package.json", "{"],
          ["broken/index.js", 'module.exports = "invalid package";\n'],
          ...[...imports, ...unresolved].map(
            ([path, specifier]) =>
              [path, `require(${JSON.stringify(specifier)});\n`] as const,
          ),
        ]);
        await Promise.all(
          [...files].map(async ([path, contents]) => {
            const target = join(root, path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, contents);
          }),
        );
        const outside = join(workspace, "outside", "index.js");
        await mkdir(dirname(outside), { recursive: true });
        await writeFile(outside, 'module.exports = "outside import root";\n');

        // Node's loader establishes each fixture's meaning independently.
        for (const [path, specifier, target] of imports)
          expect(createRequire(join(root, path)).resolve(specifier)).toBe(
            join(root, target),
          );
        expect(() =>
          createRequire(join(root, "missing.cjs")).resolve("./missing/"),
        ).toThrow();
        expect(() =>
          createRequire(join(root, "main.ts")).resolve("./folder.js/."),
        ).toThrow();
        expect(() =>
          createRequire(join(root, "broken-package.cjs")).resolve("./broken"),
        ).toThrow(/Invalid package config/u);
        expect(
          createRequire(join(root, "escape.cjs")).resolve("../outside/"),
        ).toBe(outside);

        const result = await cli.run({
          arguments: ["import-reference-source", root, "--json"],
          environment: {
            HOME: workspace,
            XDG_CONFIG_HOME: workspace,
            XDG_CACHE_HOME: workspace,
          },
        });
        expect(result.exitCode).toBe(0);
        const graph = historicalSourceGraphSchema.parse(result.json);
        expect(graph.parse_failures).toEqual([]);
        expect(graph.relationships).toHaveLength(
          imports.length + unresolved.length,
        );
        for (const [from, , to] of imports)
          expect.soft(graph.relationships, from).toContainEqual({
            from_path: from,
            to,
            kind: "requires",
            resolution: "internal",
            parse_state: "parsed",
          });
        for (const [from, , to] of unresolved)
          expect.soft(graph.relationships, from).toContainEqual({
            from_path: from,
            to,
            kind: "requires",
            resolution: "unresolved",
            parse_state: "parsed",
          });
        expect(
          graph.entries.some((entry) => entry.path.includes("outside")),
        ).toBe(false);
      },
    );
  },
);
