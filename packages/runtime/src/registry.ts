/**
 * The registry: finds installed apps, validates their manifests, and checks
 * their integrity hash. Spec §10 and §15.
 *
 * An app is a folder `${PIFI_HOME}/registered-apps/<name>/` containing `pifi.json`.
 * One bad manifest must never stop the others from loading, so errors are
 * collected and returned instead of thrown.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { APP_NAME_REGEX } from '@pifi/protocol';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const ManifestSchema = z
  .object({
    name: z.string().regex(APP_NAME_REGEX, 'must match ^[a-z0-9][a-z0-9-]{0,31}$'),
    version: z.string().regex(SEMVER, 'must be a semver string like 1.0.0'),
    description: z.string().max(500).optional(),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    memoryMB: z.number().positive(),
    needsPort: z.boolean().default(false),
    autostart: z.boolean().default(false),
    restart: z
      .object({
        policy: z.enum(['never', 'on-crash']).default('on-crash'),
        maxRestarts: z.number().int().min(0).default(3),
        windowSec: z.number().positive().default(60),
      })
      .strict()
      .default({ policy: 'on-crash', maxRestarts: 3, windowSec: 60 }),
    startTimeoutMs: z.number().int().positive().optional(),
    env: z.record(z.string(), z.string()).default({}),
    frontend: z.string().url().optional(),
    hash: z
      .string()
      .regex(/^sha256-[0-9a-f]{64}$/, 'must look like sha256-<64 hex chars>')
      .optional(),
  })
  // Unknown keys are rejected: a typo like "autostrat" should be an error, not silently ignored.
  .strict();

export type Manifest = z.infer<typeof ManifestSchema>;

export interface RegistryEntry {
  manifest: Manifest;
  /** Derived from where we found the manifest; never read from the manifest itself. */
  dir: string;
}

export interface RegistryError {
  dir: string;
  error: string;
}

export interface RegistryScan {
  entries: RegistryEntry[];
  errors: RegistryError[];
}

export function registeredAppsDir(home: string): string {
  return path.join(home, 'registered-apps');
}

/** Scan `registered-apps/*` and validate every manifest. Never throws for a bad app. */
export async function loadRegistry(home: string): Promise<RegistryScan> {
  const root = registeredAppsDir(home);
  const entries: RegistryEntry[] = [];
  const errors: RegistryError[] = [];

  let dirents;
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch {
    return { entries, errors }; // no registered-apps folder yet = no apps
  }

  for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!dirent.isDirectory()) continue; // symlinks and stray files are ignored on purpose
    const dir = path.join(root, dirent.name);
    try {
      const raw = await readFile(path.join(dir, 'pifi.json'), 'utf8');
      const parsed = ManifestSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`invalid manifest: ${issue?.path.join('.') || 'root'}: ${issue?.message ?? 'unknown problem'}`);
      }
      // The folder name is the source of truth for identity; the manifest must agree.
      if (parsed.data.name !== dirent.name) {
        throw new Error(`manifest name "${parsed.data.name}" does not match its folder "${dirent.name}"`);
      }
      entries.push({ manifest: parsed.data, dir });
    } catch (err) {
      errors.push({ dir, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { entries, errors };
}

/** Recursively list files under `dir` as POSIX-style relative paths, skipping node_modules. */
async function listFiles(dir: string, rel = ''): Promise<string[]> {
  const result: string[] = [];
  for (const dirent of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      if (dirent.name === 'node_modules') continue; // Phase 1 limitation, see docs/MANIFEST.md
      result.push(...(await listFiles(dir, relPath)));
    } else if (relPath !== 'pifi.json') {
      result.push(relPath); // regular files and symlinks
    }
  }
  return result;
}

/**
 * sha256 over the app folder: for each file (sorted by relative path) feed
 * `path + "\0" + bytes`. The manifest itself is excluded because it contains the
 * hash. Symlinks are hashed by their target text and never followed, so a link
 * can't smuggle in content from outside the folder unnoticed.
 */
export async function hashDirectory(dir: string): Promise<string> {
  const files = (await listFiles(dir)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    const full = path.join(dir, rel);
    try {
      hash.update(await readlink(full)); // throws EINVAL if it is not a symlink
      continue;
    } catch {
      // not a symlink: hash the bytes, streaming so big files don't fill the Pi's RAM
    }
    for await (const chunk of createReadStream(full)) hash.update(chunk as Buffer);
  }
  return `sha256-${hash.digest('hex')}`;
}
