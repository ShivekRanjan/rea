import { createHash } from "node:crypto";
import { posix } from "node:path";

import { logicalPathEscapesRoot } from "../domain/artifactIdentity.js";
import {
  createReferenceSourcePathLookup,
  isPortableAbsoluteReferenceTarget,
  type ReferenceSourcePathLookup,
} from "../domain/referenceSourcePathIdentity.js";
import {
  classifyReferenceSourcePath,
  detectReferenceSourceLanguage,
} from "../domain/referenceSourceClassification.js";
import type { HistoricalSourceGraphInput } from "../domain/referenceSourceGraph.js";
import {
  parseReferenceSourceImports,
  PARSEABLE_REFERENCE_SOURCE_LANGUAGES,
} from "../domain/referenceSourceImportParsing.js";
import type {
  ReferenceSourceEntry,
  ReferenceSourceRead,
} from "../reference/ReferenceSourceReaderTypes.js";
import { typescriptEmittedSourceCandidates } from "./TypeScriptEmittedSourceCandidates.js";

export interface ParsedReferenceSourceEntries {
  readonly entries: HistoricalSourceGraphInput["entries"];
  readonly relationships: HistoricalSourceGraphInput["relationships"];
  readonly parseFailures: HistoricalSourceGraphInput["parse_failures"];
  readonly limitations: string[];
}

/** Preserve the observed reader failure and add entry-specific recovery guidance. */
export const projectReferenceSourceEntryFailure = (
  entry: Extract<ReferenceSourceEntry, { status: "failed" }>,
): string => `${entry.message} ${entryRecoveryGuidance(entry)}`;

const entryRecoveryGuidance = (
  entry: Extract<ReferenceSourceEntry, { status: "failed" }>,
): string => {
  if (entry.code === "cancelled")
    return "This entry was not read because the import was cancelled. Start the import again when ready.";
  if (entry.code === "unsupported")
    return "Exclude this entry or replace it with a regular file.";
  if (entry.kind === "directory")
    return "This directory could not be read. Check its permissions, then try again.";
  if (entry.kind === "symlink")
    return "This symbolic link could not be read safely. Check the link and its permissions, then try again.";
  if (entry.kind === "unknown")
    return "This entry's type could not be determined. Check the parent directory and try again.";
  return "This file could not be read. Check its permissions, then try again.";
};

const hashBytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const failedEntry = (
  entry: Extract<ReferenceSourceEntry, { status: "failed" }>,
): HistoricalSourceGraphInput["entries"][number] => {
  const classifications = classifyReferenceSourcePath(entry.path);
  const limitation = projectReferenceSourceEntryFailure(entry);
  if (entry.kind === "directory")
    return {
      path: entry.path,
      kind: "directory",
      classifications,
      tree_state: "unreadable",
      limitations: [limitation],
    };
  if (entry.kind === "symlink")
    return {
      path: entry.path,
      kind: "symlink",
      target: null,
      target_state: "unreadable",
      classifications,
      limitations: [limitation],
    };
  if (entry.kind === "unknown" || entry.kind === "other")
    return {
      path: entry.path,
      kind: "unknown",
      classifications: ["unknown"],
      limitations: [limitation],
    };
  return {
    path: entry.path,
    kind: "file",
    sha256: null,
    size: entry.size ?? null,
    language: null,
    classifications: entry.kind === "file" ? classifications : ["unknown"],
    content_state: "unreadable",
    limitations: [limitation],
  };
};

type InternalResolution = {
  readonly to: string;
  readonly resolution: "internal" | "unresolved";
};

type PackageMain =
  | { readonly kind: "absent" }
  | { readonly kind: "declared"; readonly main: string }
  | { readonly kind: "unknown" };

interface ImportResolutionContext {
  readonly lookupPath: ReferenceSourcePathLookup;
  /** The legacy `main` field of `<directory>/package.json`. */
  readonly packageMain: (directory: string) => PackageMain;
}

/** Node's CommonJS loader probes only these extensions after the exact name. */
const COMMON_JS_EXTENSIONS = [".js", ".json", ".node"];

/**
 * Node's CommonJS lookup for a relative request: the file and its extensions,
 * then the directory's package `main`, then its index. Returns undefined when
 * Node would load no inventoried file, so the general candidates still apply.
 */
const resolveCommonJsRequest = (
  request: string,
  directoryReference: boolean,
  context: ImportResolutionContext,
): InternalResolution | undefined => {
  const { lookupPath } = context;
  const loadAsFile = (path: string): string | undefined =>
    lookupPath.resolveCandidates([
      path,
      ...COMMON_JS_EXTENSIONS.map((extension) => `${path}${extension}`),
    ]);
  const loadIndex = (path: string): string | undefined =>
    lookupPath.resolveCandidates(
      COMMON_JS_EXTENSIONS.map((extension) =>
        posix.join(path, `index${extension}`),
      ),
    );
  const file = directoryReference ? undefined : loadAsFile(request);
  if (file !== undefined) return { to: file, resolution: "internal" };
  const manifest = context.packageMain(request);
  // Node rejects an unparseable package.json; an unread one is unknown.
  if (manifest.kind === "unknown")
    return { to: request, resolution: "unresolved" };
  if (manifest.kind === "declared") {
    const main = posix.normalize(posix.join(request, manifest.main));
    if (posix.isAbsolute(manifest.main) || logicalPathEscapesRoot(main))
      return { to: request, resolution: "unresolved" };
    const selected = loadAsFile(main) ?? loadIndex(main);
    if (selected !== undefined) return { to: selected, resolution: "internal" };
  }
  // Node falls back to the index when a declared main is missing.
  const index = loadIndex(request);
  return index === undefined
    ? undefined
    : { to: index, resolution: "internal" };
};

const resolveInternalSpecifier = (
  relationship: Pick<
    HistoricalSourceGraphInput["relationships"][number],
    "from_path" | "to" | "kind"
  >,
  context: ImportResolutionContext,
): InternalResolution => {
  const { from_path: fromPath, to: specifier } = relationship;
  if (posix.isAbsolute(specifier))
    return { to: specifier, resolution: "unresolved" };
  const normalized = posix.normalize(
    posix.join(posix.dirname(fromPath), specifier),
  );
  if (logicalPathEscapesRoot(normalized))
    return { to: normalized, resolution: "unresolved" };
  // Preserve directory intent before normalization removes terminal dot segments.
  const directoryReference =
    specifier.endsWith("/") || [".", ".."].includes(posix.basename(specifier));
  // JavaScript `require` follows Node; other imports keep source-level lookup.
  if (
    relationship.kind === "requires" &&
    detectReferenceSourceLanguage(fromPath) === "JavaScript"
  ) {
    const commonJs = resolveCommonJsRequest(
      normalized,
      directoryReference,
      context,
    );
    if (commonJs !== undefined) return commonJs;
  }
  const suffixes = ["", ".ts", ".js", ".mjs", ".cjs", ".tsx", ".jsx"];
  const candidates = suffixes.flatMap((suffix) => [
    ...(directoryReference ? [] : [`${normalized}${suffix}`]),
    posix.join(normalized, `index${suffix}`),
  ]);
  // Retain present runtime files first; substitute only a missing counterpart.
  // Counterparts cover explicit filenames, not directory/index resolution.
  if (!directoryReference)
    candidates.push(
      ...typescriptEmittedSourceCandidates(fromPath, normalized).map(
        ({ path }) => path,
      ),
    );
  const match = context.lookupPath.resolveCandidates(candidates);
  return match === undefined
    ? { to: normalized, resolution: "unresolved" }
    : { to: match, resolution: "internal" };
};

type ReadFile = Extract<ReferenceSourceEntry, { status: "read"; kind: "file" }>;

const appendFile = (
  entry: ReadFile,
  context: ImportResolutionContext,
  output: ParsedReferenceSourceEntries,
): void => {
  const language = detectReferenceSourceLanguage(entry.path);
  const parsed =
    language === null || !PARSEABLE_REFERENCE_SOURCE_LANGUAGES.has(language)
      ? undefined
      : parseReferenceSourceImports(entry.path, entry.bytes, language);
  output.entries.push({
    path: entry.path,
    kind: "file",
    sha256: hashBytes(entry.bytes),
    size: entry.size,
    language,
    classifications: classifyReferenceSourcePath(entry.path),
    content_state: "hashed",
    limitations: [...(parsed?.limitations ?? [])],
  });
  if (parsed === undefined) return;
  for (const relationship of parsed.relationships) {
    if (relationship.resolution !== "internal") {
      output.relationships.push(relationship);
      continue;
    }
    const resolved = resolveInternalSpecifier(relationship, context);
    output.relationships.push({
      ...relationship,
      to: resolved.to,
      resolution: resolved.resolution,
    });
  }
  output.parseFailures.push(...parsed.parse_failures);
};

const appendReadEntry = (
  entry: Extract<ReferenceSourceEntry, { status: "read" }>,
  context: ImportResolutionContext,
  output: ParsedReferenceSourceEntries,
): void => {
  if (entry.kind === "file") {
    appendFile(entry, context, output);
    return;
  }
  const classifications = classifyReferenceSourcePath(entry.path);
  if (entry.kind === "directory") {
    output.entries.push({
      path: entry.path,
      kind: "directory",
      classifications,
      tree_state: "enumerated",
      limitations: [],
    });
    return;
  }
  output.entries.push({
    path: entry.path,
    kind: "symlink",
    // The reader resolves inventory identities from its root; the persisted
    // graph represents relative symlink targets from the link's directory.
    target:
      entry.targetState === "internal" ||
      (entry.targetState === "missing" &&
        !isPortableAbsoluteReferenceTarget(entry.target))
        ? posix.relative(posix.dirname(entry.path), entry.target) || "."
        : entry.target,
    target_state: entry.targetState,
    classifications,
    limitations: [],
  });
};

/** Convert bounded reader observations into graph entries and parsed edges. */
export const parseReferenceSourceEntries = (
  read: ReferenceSourceRead,
  filePaths: ReadonlySet<string>,
  signal?: AbortSignal,
): ParsedReferenceSourceEntries => {
  const output: ParsedReferenceSourceEntries = {
    entries: [],
    relationships: [],
    parseFailures: [],
    limitations: [...read.limitations],
  };
  const lookupPath = createReferenceSourcePathLookup(filePaths);
  const context: ImportResolutionContext = {
    lookupPath,
    packageMain: packageMainReader(read.entries, lookupPath),
  };
  for (const entry of read.entries) {
    if (signal?.aborted === true) break;
    if (entry.status === "failed") output.entries.push(failedEntry(entry));
    else appendReadEntry(entry, context, output);
  }
  return output;
};

/** Read legacy package `main` fields from inventoried package.json entries. */
const packageMainReader = (
  entries: readonly ReferenceSourceEntry[],
  lookupPath: ReferenceSourcePathLookup,
): ((directory: string) => PackageMain) => {
  // A manifest that was not read as a regular file has unknown contents.
  const manifests = new Map<string, Uint8Array | null>(
    entries
      .filter(({ path }) => posix.basename(path) === "package.json")
      .map((entry) => [
        entry.path,
        entry.status === "read" && entry.kind === "file" ? entry.bytes : null,
      ]),
  );
  const cache = new Map<string, PackageMain>();
  return (directory) => {
    const requested = posix.join(directory, "package.json");
    const path = lookupPath.resolve(requested) ?? requested;
    const cached = cache.get(path);
    if (cached !== undefined) return cached;
    const main = readPackageMain(manifests, path);
    cache.set(path, main);
    return main;
  };
};

const readPackageMain = (
  manifests: ReadonlyMap<string, Uint8Array | null>,
  path: string,
): PackageMain => {
  const bytes = manifests.get(path);
  if (bytes === undefined) return { kind: "absent" };
  if (bytes === null) return { kind: "unknown" };
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause: unknown) {
    void cause;
    return { kind: "unknown" };
  }
  const main =
    typeof manifest === "object" && manifest !== null && "main" in manifest
      ? manifest.main
      : undefined;
  // Node ignores a non-string or empty main and loads the directory index.
  return typeof main === "string" && main !== ""
    ? { kind: "declared", main }
    : { kind: "absent" };
};
