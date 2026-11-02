import { readFileSync } from 'node:fs';
import type { Logger } from '@resus/core';

/**
 * Module 4 — language layer.
 *
 * Module 5 owns what is said: it decides which protocol instruction is current
 * and issues it with a stable `instructionId`, plus a structured question with a
 * stable `questionId`. It never contains text in any language other than the
 * reviewed catalogue wording. This file is the *only* place that renders that
 * content into another language, and it does so by looking the identifier up in a
 * reviewed translation table — never by machine-translating, paraphrasing or
 * generating clinical content.
 *
 * Why a table and not a translator
 * ---------------------------------
 * A machine translation of "press hard and fast in the centre of the chest" is a
 * new clinical instruction that no clinician has reviewed. A lookup into a table
 * that a reviewer signed off is not: the wording a caller hears is exactly the
 * wording that was approved for that instruction. When there is no reviewed entry
 * the original protocol wording is spoken and the fallback is reported, so the
 * gap is visible rather than silently filled with invented text.
 *
 * The catalogue is keyed by the engine's identifiers, so it survives a change to
 * the catalogue prose: re-transcribing a step does not invalidate its translations
 * as long as the step id (hence `instructionId`) is unchanged.
 */

/** `instructionId`/`questionId` -> BCP-47 language tag -> reviewed text. */
export type TranslationCatalogue = Record<string, Record<string, string>>;

export type LocalisationReason =
  /** The reviewed translation for this language was spoken. */
  | 'LOCALISED'
  /** Some parts were translated and at least one part fell back to the original. */
  | 'PARTIALLY_LOCALISED'
  /** Localisation is switched off; the original wording is spoken. */
  | 'DISABLED'
  /** The engine paraphrased, so the text is not the catalogue's and must not be replaced. */
  | 'PARAPHRASED'
  /** The turn carried no identifier to look up. */
  | 'NO_KEY'
  /** The identifier or the language had no reviewed entry. */
  | 'NO_TRANSLATION';

export interface LocalisationRequest {
  /** The call's language, as recorded by Module 1. */
  language: string;
  /** Stable key for the current instruction, when Module 5 issued one. */
  instructionId: string | null;
  /** Reviewed catalogue wording of the instruction, used verbatim on fallback. */
  instruction: string | null;
  /** Stable key for the current question, when Module 5 asked one. */
  questionId: string | null;
  /** Reviewed catalogue wording of the question, used verbatim on fallback. */
  question: string | null;
  /** Module 5's own chosen speech, the last-resort text when no parts are present. */
  fallbackSpeech: string;
  /** True when Module 5 approved a paraphrase rather than the catalogue wording. */
  paraphrased: boolean;
}

export interface LocalisationResult {
  /** What should be spoken. Equals the original when nothing was translated. */
  speech: string;
  /** True when any reviewed translation was used. */
  localised: boolean;
  /** Why the result is what it is; reported so a missing translation is visible. */
  reason: LocalisationReason;
}

export interface InstructionLocaliser {
  localise(request: LocalisationRequest): LocalisationResult;
}

function sanitise(catalogue: TranslationCatalogue): TranslationCatalogue {
  const clean: TranslationCatalogue = {};
  for (const [key, byLanguage] of Object.entries(catalogue)) {
    if (!key || typeof byLanguage !== 'object' || byLanguage === null) continue;
    const languages: Record<string, string> = {};
    for (const [language, text] of Object.entries(byLanguage)) {
      // A non-string or blank entry is treated as absent: it must never replace
      // the protocol wording with an empty prompt.
      if (typeof text === 'string' && text.trim() !== '') languages[language] = text;
    }
    if (Object.keys(languages).length > 0) clean[key] = languages;
  }
  return clean;
}

function isCatalogue(value: unknown): value is TranslationCatalogue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fallback(request: LocalisationRequest, reason: LocalisationReason): LocalisationResult {
  return { speech: request.fallbackSpeech, localised: false, reason };
}

export class InstructionLocalizer implements InstructionLocaliser {
  private constructor(
    private readonly catalogue: TranslationCatalogue,
    private readonly enabled: boolean,
  ) {}

  /** A localiser that never translates; the original protocol wording is spoken. */
  static disabled(): InstructionLocalizer {
    return new InstructionLocalizer({}, false);
  }

  /** Builds a localiser from an already-parsed catalogue (used by tests). */
  static fromObject(catalogue: TranslationCatalogue): InstructionLocalizer {
    return new InstructionLocalizer(sanitise(catalogue), true);
  }

  /**
   * Loads a reviewed catalogue from a JSON file.
   *
   * A missing or malformed file disables localisation rather than throwing: the
   * live call must keep working, and the caller hearing the reviewed protocol
   * wording is always safe. The reason is logged so the misconfiguration is
   * noticed.
   */
  static fromFile(path: string, logger?: Logger): InstructionLocalizer {
    if (path.trim() === '') return InstructionLocalizer.disabled();
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (!isCatalogue(parsed)) {
        logger?.warn(
          { path },
          'the translation catalogue is not an instructionId -> language map; localisation is disabled',
        );
        return InstructionLocalizer.disabled();
      }
      return new InstructionLocalizer(sanitise(parsed), true);
    } catch (error) {
      logger?.warn(
        { path, reason: (error as Error).message },
        'could not load the translation catalogue; localisation is disabled',
      );
      return InstructionLocalizer.disabled();
    }
  }

  localise(request: LocalisationRequest): LocalisationResult {
    if (!this.enabled) return fallback(request, 'DISABLED');
    // A paraphrase is the model's approved wording, not the catalogue's, so it has
    // no stable key to look up. Replacing it would silently discard the approved
    // paraphrase; the safe choice is to speak it and report why.
    if (request.paraphrased) return fallback(request, 'PARAPHRASED');
    if (!request.instructionId && !request.questionId) return fallback(request, 'NO_KEY');

    const parts: string[] = [];
    let considered = 0;
    let translated = 0;

    if (request.instruction) {
      considered += 1;
      const text = this.lookup(request.instructionId, request.language);
      if (text) {
        parts.push(text);
        translated += 1;
      } else {
        parts.push(request.instruction);
      }
    }

    if (request.question) {
      considered += 1;
      const text = this.lookup(request.questionId, request.language);
      if (text) {
        parts.push(text);
        translated += 1;
      } else {
        parts.push(request.question);
      }
    }

    if (considered === 0 || translated === 0) return fallback(request, 'NO_TRANSLATION');

    return {
      speech: parts.join(' '),
      localised: true,
      reason: translated === considered ? 'LOCALISED' : 'PARTIALLY_LOCALISED',
    };
  }

  private lookup(id: string | null, language: string): string | null {
    if (!id || !language) return null;
    const entry = this.catalogue[id];
    if (!entry) return null;
    return entry[language] ?? null;
  }
}
