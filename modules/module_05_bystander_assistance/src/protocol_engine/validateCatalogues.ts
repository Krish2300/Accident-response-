/**
 * Protocol catalogue validator (Module 5).
 *
 * Usage:
 *   npm run protocols:validate
 *   npm run protocols:validate -- --dir path/to/protocols
 *
 * Exits non-zero when any protocol file fails schema validation, so this can be
 * wired into CI. It is the gate that stops a malformed protocol from reaching a
 * bystander: the engine loads the same schemas, but at runtime, on the first call.
 * This runs them up front, offline, with a readable report.
 *
 * What it checks, per file:
 *   - the document matches `protocolSchema` (steps, transitions, escalations,
 *     sources, review status, fact questions)
 *   - `entry_step` names a step that exists
 *   - every transition's `to` names a step that exists
 *   - every `next`/`escalation_step` target exists
 *   - step ids are unique
 *   - no step is unreachable from the entry step
 *   - escalation rules with `severity: CRITICAL` name an `escalation_step`
 *   - no two files claim the same `protocol_id@version`
 *   - every value a protocol compares a fact against is a value the extraction
 *     contract can actually produce
 *
 * It deliberately does NOT modify protocol content. Protocols are clinically
 * authored data; tooling may report on them and never rewrite them.
 */
import { ProtocolLoader } from './protocolLoader.js';
import { CLOSED_FACT_VALUES } from '../llm/contracts.js';
import type { Condition, Protocol } from './types.js';

interface FileReport {
  file: string;
  protocolId: string;
  version: string;
  reviewStatus: string;
  stepCount: number;
  errors: string[];
  warnings: string[];
}

/** Literals every condition of a protocol compares its facts against. */
function literalsByFact(protocol: Protocol): Map<string, Set<string>> {
  const literals = new Map<string, Set<string>>();

  const note = (fact: string, value: unknown): void => {
    if (typeof value !== 'string') return;
    const set = literals.get(fact) ?? new Set<string>();
    set.add(value);
    literals.set(fact, set);
  };

  const walk = (condition: Condition): void => {
    if ('all' in condition) return condition.all.forEach(walk);
    if ('any' in condition) return condition.any.forEach(walk);
    if ('not' in condition) return walk(condition.not);
    if ('always' in condition) return;
    if (condition.op === 'eq') return note(condition.fact, condition.value);
    if ((condition.op === 'in' || condition.op === 'not_in') && Array.isArray(condition.value)) {
      for (const value of condition.value) note(condition.fact, value);
    }
  };

  for (const condition of protocol.entry_conditions) walk(condition);
  for (const condition of protocol.completion_conditions) walk(condition);
  for (const rule of protocol.escalation_rules) walk(rule.when);
  for (const step of protocol.steps) {
    for (const transition of step.transitions) walk(transition.when);
    for (const condition of step.completion_conditions) walk(condition);
  }
  return literals;
}

/**
 * Warns when a protocol compares a fact against a value extraction cannot produce.
 *
 * Not an error: the protocol is the authoritative source, so widening the
 * extraction contract is the fix and that is a clinical decision. But an
 * unreachable condition is a silent failure — the protocol reads as covering a
 * case it cannot actually be told about — so it has to be visible in CI.
 */
function auditContractCoverage(protocol: Protocol, warnings: string[]): void {
  for (const [fact, values] of literalsByFact(protocol)) {
    const declared = CLOSED_FACT_VALUES[fact];
    if (declared === undefined) continue; // Unbounded fact: the caller's own words.
    for (const value of values) {
      const upper = value.toUpperCase();
      if (!declared.includes(upper) && upper !== 'UNKNOWN') {
        warnings.push(
          `Protocol compares '${fact}' against '${value}', but the extraction contract cannot produce it (declared: ${declared.join(', ')}). That condition cannot be satisfied.`,
        );
      }
    }
  }
}

/** Structural checks that the JSON schema cannot express. */
function audit(protocol: Protocol): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const stepIds = new Set(protocol.steps.map((s) => s.step_id));
  if (stepIds.size !== protocol.steps.length) {
    errors.push('Step ids are not unique across the protocol.');
  }

  if (!stepIds.has(protocol.entry_step)) {
    errors.push(`entry_step '${protocol.entry_step}' is not a declared step.`);
  }

  for (const step of protocol.steps) {
    for (const transition of step.transitions) {
      // `to: null` is the schema's way of saying "this transition terminates the
      // flow", and is required for COMPLETE / ESCALATE / LOOP actions. Only a
      // non-null target has to name a declared step.
      if (transition.to !== null && !stepIds.has(transition.to)) {
        errors.push(
          `Step '${step.step_id}' transitions to '${transition.to}', which is not a declared step.`,
        );
      }
    }

    // fact_questions is a record of fact -> reviewed wording. A question whose
    // fact is not in requires_facts is unreachable, because the engine only asks
    // for facts the step declares it needs.
    const required = new Set(step.requires_facts);
    for (const fact of Object.keys(step.fact_questions ?? {})) {
      if (!required.has(fact)) {
        warnings.push(
          `Step '${step.step_id}' has wording for fact '${fact}', which is not in requires_facts, so it will never be asked.`,
        );
      }
    }
  }

  // Reachability: every step must be reachable from the entry step, otherwise it
  // is dead clinical content that will never be spoken but will still be reviewed
  // and versioned as if it mattered.
  const reachable = new Set<string>([protocol.entry_step]);
  const queue = [protocol.entry_step];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const step = protocol.steps.find((s) => s.step_id === current);
    if (!step) continue;
    for (const transition of step.transitions) {
      if (transition.to !== null && !reachable.has(transition.to)) {
        reachable.add(transition.to);
        queue.push(transition.to);
      }
    }
  }
  for (const rule of protocol.escalation_rules) {
    if (rule.escalation_step && !reachable.has(rule.escalation_step)) {
      reachable.add(rule.escalation_step);
      queue.push(rule.escalation_step);
    }
  }
  for (const step of protocol.steps) {
    if (!reachable.has(step.step_id)) {
      warnings.push(`Step '${step.step_id}' is unreachable from '${protocol.entry_step}'.`);
    }
  }

  // A CRITICAL escalation with no named step leaves the bystander hearing the
  // previously active instruction instead of the escalation. When a rule names an
  // `escalation_step`, the engine speaks that step's reviewed wording instead.
  for (const rule of protocol.escalation_rules) {
    if (rule.severity === 'CRITICAL' && !rule.escalation_step) {
      warnings.push(
        `Escalation rule '${rule.rule_id}' is CRITICAL but names no escalation_step, so the bystander may not hear an escalation instruction.`,
      );
    }
  }

  auditContractCoverage(protocol, warnings);

  return { errors, warnings };
}

async function main(): Promise<number> {
  const dirArgIndex = process.argv.indexOf('--dir');
  const directory = dirArgIndex >= 0 ? process.argv[dirArgIndex + 1] : undefined;

  // The loader throws on the first structural problem rather than collecting
  // them, because a schema failure is fatal and must be reported as such, not as
  // an empty catalogue.
  const loader = new ProtocolLoader(directory);

  let protocols: Protocol[];
  try {
    protocols = loader.load(true);
  } catch (error) {
    process.stderr.write(
      `\n[protocols] catalogue failed to load: ${(error as Error).message}\n`,
    );
    return 1;
  }

  const reports: FileReport[] = protocols.map((protocol) => {
    const { errors, warnings } = audit(protocol);
    return {
      file: `${protocol.protocol_id}@${protocol.version}`,
      protocolId: protocol.protocol_id,
      version: protocol.version,
      reviewStatus: protocol.source.review_status,
      stepCount: protocol.steps.length,
      errors,
      warnings,
    };
  });

  const line = '─'.repeat(72);
  process.stdout.write(`\nProtocol catalogue: ${loader.protocolDir}\n${line}\n`);

  let errorCount = 0;
  let warningCount = 0;

  for (const report of reports) {
    errorCount += report.errors.length;
    warningCount += report.warnings.length;

    const status = report.errors.length > 0 ? 'FAIL' : report.warnings.length > 0 ? 'WARN' : ' OK ';
    process.stdout.write(
      `[${status}] ${report.file.padEnd(38)} steps=${String(report.stepCount).padStart(3)}  review_status=${report.reviewStatus}\n`,
    );
    for (const error of report.errors) process.stdout.write(`         ERROR   ${error}\n`);
    for (const warning of report.warnings) process.stdout.write(`         warning ${warning}\n`);
  }

  const totalSteps = reports.reduce((sum, r) => sum + r.stepCount, 0);
  process.stdout.write(`${line}\n`);
  process.stdout.write(
    `${reports.length} protocol(s), ${totalSteps} step(s), ${errorCount} error(s), ${warningCount} warning(s)\n`,
  );

  const unreviewed = reports.filter((r) => r.reviewStatus !== 'CLINICALLY_REVIEWED').length;
  if (unreviewed > 0) {
    process.stdout.write(
      `\nNote: ${unreviewed} protocol(s) are not marked CLINICALLY_REVIEWED. That is expected in\n` +
        `development. It is not a validation failure: unreviewed content is served\n` +
        `with its review status attached to every protocol session.\n`,
    );
  }

  if (errorCount > 0) {
    process.stderr.write('\n[protocols] FAILED\n');
    return 1;
  }

  process.stdout.write('\n[protocols] ok\n');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`\n[protocols] unexpected failure: ${String(error)}\n`);
    process.exit(1);
  });
