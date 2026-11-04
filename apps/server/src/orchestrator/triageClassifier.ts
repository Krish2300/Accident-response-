import type { EmergencySeverity, IncidentType } from '@resus/core';

/**
 * Deterministic keyword triage (Module 3 offline fallback).
 *
 * Used by the Module 10 autonomous orchestrator when neither the Module 3
 * Python service nor a local LLM (Ollama) is available, so the full pipeline
 * still runs on a plain Windows laptop with no API key and no internet.
 *
 * It is a rule table, not a model: every match is explainable (`matched`), the
 * confidence is fixed per rule, and anything it cannot place is `OTHER` with a
 * HIGH severity so an unknown call is never under-triaged. Rules are checked in
 * priority order (life threats first).
 */
export interface TriageResult {
  incidentType: IncidentType;
  severity: EmergencySeverity;
  confidence: number;
  matched: string[];
  source: 'RULE';
}

interface Rule {
  incidentType: IncidentType;
  severity: EmergencySeverity;
  confidence: number;
  /** Every group must match at least one pattern (AND of ORs). */
  all: RegExp[][];
}

const w = (...words: string[]): RegExp[] => words.map((word) => new RegExp(`(^|[^\\p{L}])${word}`, 'iu'));

// Not breathing / unresponsive / collapsed => cardiac arrest is the
// conservative reading (it starts CPR guidance, which is what matters).
const NOT_BREATHING = w(
  'not breathing', "isn'?t breathing", 'no breathing', 'stopped breathing', 'no pulse', 'not responding',
  "isn'?t responding", 'unresponsive', 'no response', 'cardiac arrest', 'heart stopped',
  'shwasam illa', 'ശ്വാസം ഇല്ല', 'ശ്വസിക്കുന്നില്ല', 'saans nahi', 'सांस नहीं',
);
const COLLAPSE = w('collapsed', 'collapse', 'fell down', 'fainted', 'passed out', 'unconscious', 'not waking', 'won\'?t wake', 'boodham illa', 'ബോധം ഇല്ല', 'ബോധമില്ല', 'behosh', 'बेहोश');

const RULES: Rule[] = [
  { incidentType: 'CARDIAC_ARREST', severity: 'CRITICAL', confidence: 0.75, all: [NOT_BREATHING] },
  { incidentType: 'CHOKING', severity: 'CRITICAL', confidence: 0.75, all: [w('chok', 'something stuck', 'stuck in (his|her|their) throat', "can'?t swallow", 'swallowed a')] },
  { incidentType: 'UNSAFE_SCENE', severity: 'CRITICAL', confidence: 0.7, all: [w('fire', 'gun', 'shooting', 'stabbing', 'knife', 'explosion', 'gas leak', 'electrocut', 'live wire', 'flood', 'building collapse')] },
  { incidentType: 'SEVERE_BLEEDING', severity: 'CRITICAL', confidence: 0.7, all: [w('bleeding', 'blood', 'haemorrhag', 'hemorrhag', 'deep cut', 'raktham', 'രക്തം', 'खून')] },
  { incidentType: 'TRAUMA', severity: 'HIGH', confidence: 0.7, all: [w('accident', 'crash', 'collision', 'hit by', 'run over', 'fell from', 'fall from', 'fracture', 'broken (leg|arm|bone)', 'head injury', 'bike', 'motorcycle', 'lorry', 'truck', 'apakadam', 'അപകടം', 'दुर्घटना')] },
  { incidentType: 'STROKE', severity: 'CRITICAL', confidence: 0.7, all: [w('stroke', 'face droop', 'drooping', 'slurred', 'one side', "can'?t move (his|her|their) (arm|leg)", 'paraly')] },
  { incidentType: 'CHEST_PAIN', severity: 'HIGH', confidence: 0.7, all: [w('chest pain', 'chest is hurting', 'pain in (his|her|my|their) chest', 'heart attack', 'chest tight', 'nenju vedana', 'നെഞ്ചുവേദന', 'നെഞ്ച് വേദന', 'सीने में दर्द')] },
  { incidentType: 'SEIZURE', severity: 'HIGH', confidence: 0.7, all: [w('seizure', 'fitting', 'fits', 'convuls', 'shaking uncontroll', 'epilep', 'apasmaram', 'അപസ്മാരം')] },
  { incidentType: 'SEVERE_BREATHING_DIFFICULTY', severity: 'CRITICAL', confidence: 0.65, all: [w("can'?t breathe", 'cannot breathe', 'difficulty breathing', 'trouble breathing', 'short of breath', 'shortness of breath', 'gasping', 'asthma', 'wheez')] },
  { incidentType: 'ALLERGIC_REACTION', severity: 'HIGH', confidence: 0.65, all: [w('allerg', 'anaphyla', 'swollen (face|lips|tongue|throat)', 'swelling', 'bee sting', 'hives', 'epipen')] },
  { incidentType: 'OVERDOSE', severity: 'HIGH', confidence: 0.65, all: [w('overdose', 'too many (pills|tablets)', 'poison', 'swallowed (pills|tablets|chemical)', 'drank (poison|pesticide|kerosene)', 'pesticide', 'visham', 'വിഷം', 'जहर')] },
  { incidentType: 'UNCONSCIOUS', severity: 'CRITICAL', confidence: 0.6, all: [COLLAPSE] },
];

export function classifyTranscript(text: string): TriageResult {
  const normalised = text.normalize('NFC').toLowerCase();
  for (const rule of RULES) {
    const hits: string[] = [];
    const ok = rule.all.every((group) => {
      const found = group.find((pattern) => pattern.test(normalised));
      if (found) hits.push(found.source.replace('(^|[^\\p{L}])', ''));
      return Boolean(found);
    });
    if (ok) {
      return { incidentType: rule.incidentType, severity: rule.severity, confidence: rule.confidence, matched: hits, source: 'RULE' };
    }
  }
  return { incidentType: 'OTHER', severity: 'HIGH', confidence: 0.3, matched: [], source: 'RULE' };
}
