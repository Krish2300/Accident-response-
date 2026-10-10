import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { AppError, ErrorCode } from '@resus/core';
import {
  type Protocol,
  type ProtocolSummary,
  protocolSchema,
} from './types.js';

const moduleDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DEFAULT_PROTOCOL_DIR = resolve(moduleDir, 'protocols');

/**
 * Loads and validates the versioned protocol catalogue.
 *
 * Protocols are data. The loader:
 *  - validates every file against `protocolSchema` at load time,
 *  - refuses to serve a protocol whose `review_status` is missing,
 *  - keeps the source and version attached to every served protocol,
 *  - supports loading several versions side by side,
 *  - rejects two files claiming the same `protocol_id@version`, because which one
 *    won would otherwise depend on directory iteration order.
 *
 * It fails closed, unconditionally. A catalogue that contains any error serves
 * nothing at all. There is deliberately no "load the good ones anyway" mode: a
 * bystander being walked through a cardiac-arrest protocol must not be subject to
 * whether the process happened to start with a partial directory listing.
 */
export class ProtocolLoader {
  private readonly cache = new Map<string, Protocol>();
  /** Which file supplied each cached protocol, so duplicates can name both sides. */
  private readonly sourceFiles = new Map<string, string>();
  private loadError: string | null = null;

  constructor(private readonly directory: string = DEFAULT_PROTOCOL_DIR) {}

  get protocolDir(): string {
    return this.directory;
  }

  /** Validates and caches every protocol file in the directory. */
  load(force = false): Protocol[] {
    if (this.cache.size > 0 && !force) return [...this.cache.values()];
    this.cache.clear();

    if (!existsSync(this.directory)) {
      throw new AppError(
        ErrorCode.PROTOCOL_CATALOGUE_INVALID,
        `Protocol directory '${this.directory}' does not exist.`,
        500,
      );
    }

    const files = collectJsonFiles(this.directory);
    if (files.length === 0) {
      throw new AppError(
        ErrorCode.PROTOCOL_CATALOGUE_INVALID,
        `No protocol files found in '${this.directory}'.`,
        500,
      );
    }

    const problems: string[] = [];
    for (const file of files) {
      let raw: string;
      try {
        raw = readFileSync(file, 'utf8');
      } catch (error) {
        problems.push(`${basename(file)}: unreadable (${String(error)})`);
        continue;
      }

      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch (error) {
        problems.push(`${basename(file)}: invalid JSON (${String(error)})`);
        continue;
      }

      const parsed = protocolSchema.safeParse(json);
      if (!parsed.success) {
        problems.push(
          `${basename(file)}: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        );
        continue;
      }

      const protocol = parsed.data;
      const key = cacheKey(protocol.protocol_id, protocol.version);

      // Two files claiming the same protocol_id@version is a deployment error, not
      // a race: without this check the winner is whichever the filesystem lists
      // first, so a stray copy could silently shadow a reviewed protocol.
      const previousFile = this.sourceFiles.get(key);
      if (previousFile !== undefined) {
        problems.push(
          `${basename(file)}: duplicate ${key}; already defined by ${previousFile}`,
        );
        continue;
      }

      const structural = validateGraph(protocol);
      problems.push(...structural.map((issue) => `${basename(file)}: ${issue}`));

      this.sourceFiles.set(key, basename(file));
      this.cache.set(key, protocol);
    }

    this.sourceFiles.clear();

    this.loadError = problems.length > 0 ? problems.join(' | ') : null;
    if (problems.length > 0) {
      // Fail closed. Nothing is served from a catalogue with a known error.
      this.cache.clear();
      throw new AppError(
        ErrorCode.PROTOCOL_CATALOGUE_INVALID,
        'The protocol catalogue failed validation.',
        500,
        { problems },
      );
    }
    return [...this.cache.values()];
  }

  list(): ProtocolSummary[] {
    return this.load()
      .map((protocol) => toSummary(protocol))
      .sort((a, b) => b.priority - a.priority || a.protocolId.localeCompare(b.protocolId));
  }

  versionsOf(protocolId: string): string[] {
    return this.load()
      .filter((p) => p.protocol_id === protocolId)
      .map((p) => p.version)
      .sort(compareVersions);
  }

  get(protocolId: string, version?: string): Protocol {
    const all = this.load();
    if (version) {
      const exact = all.find((p) => p.protocol_id === protocolId && p.version === version);
      if (!exact) {
        throw new AppError(
          ErrorCode.PROTOCOL_NOT_FOUND,
          `Protocol '${protocolId}' version '${version}' is not in the catalogue. Available: ${this.versionsOf(protocolId).join(', ') || 'none'}.`,
          404,
          { protocolId, version, available: this.versionsOf(protocolId) },
        );
      }
      return exact;
    }
    const candidates = all.filter((p) => p.protocol_id === protocolId);
    if (candidates.length === 0) throw this.notFound(protocolId);
    // Highest version wins.
    return candidates.sort((a, b) => compareVersions(b.version, a.version))[0]!;
  }

  /** Protocols whose `applies_to.incident_types` contains the incident type. */
  forIncidentType(incidentType: string): Protocol[] {
    return this.load()
      .filter((p) => p.applies_to.incident_types.includes(incidentType))
      .sort((a, b) => b.priority - a.priority);
  }

  /** Resolves the protocol to run for an incident, or null when none applies. */
  resolveForIncident(incidentType: string): Protocol | null {
    return this.forIncidentType(incidentType)[0] ?? null;
  }

  get lastLoadError(): string | null {
    return this.loadError;
  }

  private notFound(protocolId: string): AppError {
    return new AppError(
      ErrorCode.PROTOCOL_NOT_FOUND,
      `Protocol '${protocolId}' is not in the catalogue.`,
      404,
      {
        protocolId,
        available: [...new Set(this.load().map((p) => p.protocol_id))],
      },
    );
  }
}

function cacheKey(protocolId: string, version: string): string {
  return `${protocolId}@${version}`;
}

/** Files are visited in a stable order so duplicate-definition errors are reproducible. */
function collectJsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      out.push(...collectJsonFiles(full));
    } else if (extname(entry) === '.json') {
      out.push(full);
    }
  }
  return out;
}

/**
 * Graph integrity: every transition target must exist and entry_step must resolve.
 *
 * Errors here are load-blocking, never warnings. A transition pointing at a
 * step that does not exist throws at runtime inside `requireStep`, which means a
 * bystander mid-call; catching it at load time turns a crash during an emergency
 * into a refusal to start. Reachability and CRITICAL-without-escalation-step are
 * deliberately *not* checked here: both are reported by `protocols:validate` as
 * warnings, because the remedy is clinical authoring, not a code fix.
 */
function validateGraph(protocol: Protocol): string[] {
  const issues: string[] = [];
  const stepIds = new Set(protocol.steps.map((s) => s.step_id));

  if (!stepIds.has(protocol.entry_step)) {
    issues.push(`entry_step '${protocol.entry_step}' does not exist`);
  }
  if (stepIds.size !== protocol.steps.length) {
    issues.push('duplicate step_id values detected');
  }
  const ruleIds = new Set<string>();
  for (const rule of protocol.escalation_rules) {
    if (ruleIds.has(rule.rule_id)) {
      issues.push(`duplicate escalation rule_id '${rule.rule_id}'`);
    }
    ruleIds.add(rule.rule_id);
    // A CRITICAL rule that names a step which does not exist is a data error: at
    // runtime the engine cannot present the wording the rule depends on.
    if (rule.escalation_step && !stepIds.has(rule.escalation_step)) {
      issues.push(
        `escalation rule '${rule.rule_id}' names escalation_step '${rule.escalation_step}', which does not exist`,
      );
    }
  }
  for (const step of protocol.steps) {
    for (const transition of step.transitions) {
      if (transition.to !== null && !stepIds.has(transition.to)) {
        issues.push(`step '${step.step_id}' points to unknown step '${transition.to}'`);
      }
    }
    const moves = step.transitions.some(
      (t) => t.action === 'LOOP' || t.action === 'COMPLETE' || t.action === 'ESCALATE' || t.to !== null,
    );
    if (!moves) {
      issues.push(`step '${step.step_id}' has no way forward`);
    }
    }
  return issues;
}

function toSummary(protocol: Protocol): ProtocolSummary {
  return {
    protocolId: protocol.protocol_id,
    version: protocol.version,
    title: protocol.title,
    source: protocol.source,
    priority: protocol.priority,
    appliesTo: protocol.applies_to.incident_types,
    stepCount: protocol.steps.length,
    reviewStatus: protocol.source.review_status,
  };
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
