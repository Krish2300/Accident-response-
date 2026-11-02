import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InstructionLocalizer,
  type LocalisationRequest,
} from '../apps/server/src/conversation/localizer.js';

/**
 * Module 4 language-layer tests.
 *
 * These pin the safety property that matters: rendering never invents or alters
 * clinical text. A reviewed translation is used verbatim; when there is none the
 * protocol wording is spoken unchanged and the fallback reason says why. A
 * paraphrase — which has no stable key — is never replaced.
 */

const INSTRUCTION_ID = 'cardiac_arrest@1.0.0:check_response';
const QUESTION_ID = 'cardiac_arrest@1.0.0:check_response#q1';
const EN = 'Check if they respond.';
const ML = 'അവർ പ്രതികരിക്കുന്നുണ്ടോ എന്ന് പരിശോധിക്കുക.';

function request(overrides: Partial<LocalisationRequest> = {}): LocalisationRequest {
  return {
    language: 'ml',
    instructionId: INSTRUCTION_ID,
    instruction: EN,
    questionId: null,
    question: null,
    fallbackSpeech: EN,
    paraphrased: false,
    ...overrides,
  };
}

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempCatalogue(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mod4-cat-'));
  cleanups.push(dir);
  const path = join(dir, 'translations.json');
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('InstructionLocalizer', () => {
  it('returns the protocol wording unchanged when disabled', () => {
    const localizer = InstructionLocalizer.disabled();
    const result = localizer.localise(request());
    expect(result).toEqual({ speech: EN, localised: false, reason: 'DISABLED' });
  });

  it('uses the reviewed translation for the requested language', () => {
    const localizer = InstructionLocalizer.fromObject({ [INSTRUCTION_ID]: { ml: ML } });
    const result = localizer.localise(request());
    expect(result).toEqual({ speech: ML, localised: true, reason: 'LOCALISED' });
  });

  it('falls back to the protocol wording when the language has no entry', () => {
    const localizer = InstructionLocalizer.fromObject({ [INSTRUCTION_ID]: { ta: 'x' } });
    const result = localizer.localise(request());
    expect(result).toEqual({ speech: EN, localised: false, reason: 'NO_TRANSLATION' });
  });

  it('falls back when the identifier has no entry', () => {
    const localizer = InstructionLocalizer.fromObject({ other_id: { ml: ML } });
    const result = localizer.localise(request());
    expect(result.localised).toBe(false);
    expect(result.reason).toBe('NO_TRANSLATION');
    expect(result.speech).toBe(EN);
  });

  it('never replaces an approved paraphrase, which has no stable key', () => {
    const localizer = InstructionLocalizer.fromObject({ [INSTRUCTION_ID]: { ml: ML } });
    const result = localizer.localise(request({ paraphrased: true, fallbackSpeech: 'Reassuring paraphrase.' }));
    expect(result).toEqual({ speech: 'Reassuring paraphrase.', localised: false, reason: 'PARAPHRASED' });
  });

  it('reports NO_KEY when the turn carries no identifier to look up', () => {
    const localizer = InstructionLocalizer.fromObject({ [INSTRUCTION_ID]: { ml: ML } });
    const result = localizer.localise(request({ instructionId: null, questionId: null }));
    expect(result).toEqual({ speech: EN, localised: false, reason: 'NO_KEY' });
  });

  it('translates the instruction and question independently, reporting a partial result', () => {
    const localizer = InstructionLocalizer.fromObject({
      [INSTRUCTION_ID]: { ml: ML },
      // No entry for the question.
    });
    const result = localizer.localise(
      request({ questionId: QUESTION_ID, question: 'Are they breathing?' }),
    );
    expect(result.localised).toBe(true);
    expect(result.reason).toBe('PARTIALLY_LOCALISED');
    expect(result.speech).toBe(`${ML} Are they breathing?`);
  });

  it('translates both parts when both have entries', () => {
    const localizer = InstructionLocalizer.fromObject({
      [INSTRUCTION_ID]: { ml: ML },
      [QUESTION_ID]: { ml: 'അവർ ശ്വസിക്കുന്നുണ്ടോ?' },
    });
    const result = localizer.localise(
      request({ questionId: QUESTION_ID, question: 'Are they breathing?' }),
    );
    expect(result.reason).toBe('LOCALISED');
    expect(result.speech).toBe(`${ML} അവർ ശ്വസിക്കുന്നുണ്ടോ?`);
  });

  it('treats a blank translation as absent rather than speaking an empty prompt', () => {
    const localizer = InstructionLocalizer.fromObject({ [INSTRUCTION_ID]: { ml: '   ' } });
    const result = localizer.localise(request());
    expect(result).toEqual({ speech: EN, localised: false, reason: 'NO_TRANSLATION' });
  });

  it('loads a valid catalogue from a file', () => {
    const path = tempCatalogue(JSON.stringify({ [INSTRUCTION_ID]: { ml: ML } }));
    const localizer = InstructionLocalizer.fromFile(path);
    expect(localizer.localise(request())).toMatchObject({ speech: ML, localised: true });
  });

  it('disables localisation when the catalogue file is missing or malformed', () => {
    const missing = InstructionLocalizer.fromFile(join(tmpdir(), 'does-not-exist-xyz.json'));
    expect(missing.localise(request())).toEqual({ speech: EN, localised: false, reason: 'DISABLED' });

    const malformed = InstructionLocalizer.fromFile(tempCatalogue('{ not json'));
    expect(malformed.localise(request())).toEqual({ speech: EN, localised: false, reason: 'DISABLED' });

    const wrongShape = InstructionLocalizer.fromFile(tempCatalogue(JSON.stringify(['a'])));
    expect(wrongShape.localise(request())).toEqual({ speech: EN, localised: false, reason: 'DISABLED' });

    const empty = InstructionLocalizer.fromFile('');
    expect(empty.localise(request()).reason).toBe('DISABLED');
  });
});
