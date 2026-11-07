/**
 * The command-line entry point for `scripts/import-hygiene-artifacts.sh`.
 *
 * Kept as a thin `main` so the builder itself (`import-artifacts.ts`) is importable by specs without
 * running: the shell wrapper parses the flags, this file maps a refusal to an exit code, and the build
 * logic stays testable.
 */
import { buildImportArtifacts, exportBlock, MARKER } from './import-artifacts.ts';

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

const root = arg('--root');
const source = arg('--source') ?? process.cwd();
const revisions = arg('--revisions');
const createdAt = arg('--created-at') ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

if (root === null) {
  console.error('import-hygiene-artifacts: --root is required');
  process.exit(2);
}

try {
  const artifacts = buildImportArtifacts({
    root,
    revisions: revisions === null ? 20 : Number(revisions),
    source,
    createdAt,
  });
  console.log(
    `import-hygiene-artifacts: built ${String(artifacts.baseRevs.length)} base revisions`,
  );
  console.log(`import-hygiene-artifacts: corpus ${artifacts.revisionDir}`);
  console.log(`import-hygiene-artifacts: marker ${String(artifacts.root)}/${MARKER}`);
  console.log('');
  console.log('# paste this, then run the planner:');
  console.log(exportBlock(artifacts));
  console.log('');
  console.log(
    `# bash ${artifacts.planScript}   # submits and qualifies ${String(artifacts.specPaths.length)} units`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`import-hygiene-artifacts: ${message}`);
  process.exit(error instanceof RangeError ? 2 : 1);
}
