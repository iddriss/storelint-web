import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Finding, Framework, Report, Severity } from './types.js';
import { computeScore } from './types.js';

export type ScanFn = (projectPath: string) => Promise<Report>;

export interface Scanner {
  scan: ScanFn;
  /** false when the real `storelint` package could not be loaded and the stub is in use. */
  available: boolean;
  source: 'storelint' | 'stub';
}

/**
 * Loads `scan()` from the `storelint` package (declared as an optional dependency on
 * github:iddriss/storelint). When the package is missing or has no usable export, a
 * stub scanner is returned that produces a schema-valid Report with a single info
 * finding so the rest of the app keeps working.
 */
export async function loadScanner(): Promise<Scanner> {
  // Widened to `string` so tsc does not try to resolve the module at compile time.
  const moduleName: string = 'storelint';
  try {
    const mod = (await import(moduleName)) as Record<string, unknown>;
    const candidate = mod.scan ?? (mod.default as Record<string, unknown> | undefined)?.scan;
    if (typeof candidate === 'function') {
      const real = candidate as (p: string) => Promise<unknown>;
      return {
        available: true,
        source: 'storelint',
        scan: async (projectPath) => normalizeReport(await real(projectPath), projectPath),
      };
    }
    console.warn('[scanner] storelint loaded but exports no scan(); using stub scanner');
  } catch (err) {
    console.warn(`[scanner] storelint not available (${errorMessage(err)}); using stub scanner`);
  }
  return { available: false, source: 'stub', scan: stubScan };
}

export const STUB_FINDING_ID = 'app.scanner-unavailable';

/** Fallback used when the real scanner is not installed. */
export async function stubScan(projectPath: string): Promise<Report> {
  const framework = await detectFramework(projectPath);
  const findings: Finding[] = [
    {
      id: STUB_FINDING_ID,
      platform: 'both',
      severity: 'info',
      title: 'The StoreLint scanner is not available on this server yet',
      detail:
        'This deployment could not load the storelint package, so no store-readiness checks were run on your upload.',
      fix: 'Run the scanner locally with `npx @iraaj/storelint` in your project directory, or try the web scan again later.',
      docs: 'https://github.com/iddriss/storelint',
    },
  ];
  return buildReport({ path: '.', framework, name: path.basename(projectPath) || 'project' }, findings);
}

/** Coerces whatever the scanner returned into a schema-valid Report (recomputing the summary). */
export function normalizeReport(raw: unknown, projectPath: string): Report {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const project = (r.project && typeof r.project === 'object' ? r.project : {}) as Record<string, unknown>;
  const findingsRaw = Array.isArray(r.findings) ? r.findings : [];
  const findings = findingsRaw.map(normalizeFinding).filter((f): f is Finding => f !== null);
  const scannedAt = typeof r.scannedAt === 'string' ? r.scannedAt : undefined;
  return buildReport(
    {
      path: typeof project.path === 'string' ? project.path : '.',
      framework: asFramework(project.framework),
      name: typeof project.name === 'string' && project.name ? project.name : path.basename(projectPath) || 'project',
    },
    findings,
    scannedAt,
  );
}

function buildReport(project: Report['project'], findings: Finding[], scannedAt?: string): Report {
  const summary = { blocker: 0, warning: 0, info: 0, score: 0 };
  for (const f of findings) summary[f.severity]++;
  summary.score = computeScore(summary.blocker, summary.warning);
  return {
    schemaVersion: 1,
    scannedAt: scannedAt ?? new Date().toISOString(),
    project,
    summary,
    findings,
  };
}

function normalizeFinding(raw: unknown): Finding | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  const title = typeof f.title === 'string' ? f.title : '';
  if (!title) return null;
  const out: Finding = {
    id: typeof f.id === 'string' && f.id ? f.id : 'app.unknown',
    platform: f.platform === 'android' || f.platform === 'ios' ? f.platform : 'both',
    severity: asSeverity(f.severity),
    title,
    detail: typeof f.detail === 'string' ? f.detail : '',
    fix: typeof f.fix === 'string' ? f.fix : '',
  };
  if (typeof f.file === 'string' && f.file) out.file = f.file;
  if (typeof f.line === 'number' && Number.isFinite(f.line)) out.line = f.line;
  if (typeof f.docs === 'string' && /^https?:\/\//.test(f.docs)) out.docs = f.docs;
  return out;
}

function asSeverity(v: unknown): Severity {
  return v === 'blocker' || v === 'warning' ? v : 'info';
}

function asFramework(v: unknown): Framework {
  return v === 'flutter' || v === 'react-native' || v === 'expo' ? v : 'unknown';
}

/** Minimal project detection per the spec, used only by the stub. */
async function detectFramework(dir: string): Promise<Framework> {
  const pubspec = await readText(path.join(dir, 'pubspec.yaml'));
  if (pubspec && /^\s*flutter\s*:/m.test(pubspec)) return 'flutter';
  const appJson = await readText(path.join(dir, 'app.json'));
  if (appJson && appJson.includes('"expo"')) return 'expo';
  for (const name of ['app.config.js', 'app.config.ts', 'app.config.mjs']) {
    if (await exists(path.join(dir, name))) return 'expo';
  }
  const pkg = await readText(path.join(dir, 'package.json'));
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg) as { dependencies?: Record<string, string> };
      if (parsed.dependencies?.['react-native']) return 'react-native';
    } catch {
      /* not JSON; ignore */
    }
  }
  return 'unknown';
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Rejects if `promise` does not settle within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
