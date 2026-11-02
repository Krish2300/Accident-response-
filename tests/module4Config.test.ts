import { describe, expect, it } from 'vitest';
import { loadServerConfig } from '../apps/server/src/config.js';

/**
 * Module 4 conversation-support configuration.
 *
 * The approved policy permits at most two silence-triggered re-prompts. That
 * ceiling is enforced when configuration is loaded, so a deployment cannot be
 * configured into a longer automatic prompt loop than the policy allows.
 */

function env(values: Record<string, string> = {}): NodeJS.ProcessEnv {
  return values as unknown as NodeJS.ProcessEnv;
}

describe('Module 4 conversation config', () => {
  it('defaults localisation off, silence handling off, and a two-re-prompt ceiling', () => {
    const config = loadServerConfig(env());
    expect(config.conversation).toEqual({
      localisationEnabled: false,
      translationsFile: null,
      silenceTimeoutMs: 0,
      silenceRetryLimit: 2,
    });
  });

  it('accepts a retry budget from zero up to the approved ceiling of two', () => {
    expect(loadServerConfig(env({ MODULE4_SILENCE_RETRY_LIMIT: '0' })).conversation.silenceRetryLimit).toBe(0);
    expect(loadServerConfig(env({ MODULE4_SILENCE_RETRY_LIMIT: '1' })).conversation.silenceRetryLimit).toBe(1);
    expect(loadServerConfig(env({ MODULE4_SILENCE_RETRY_LIMIT: '2' })).conversation.silenceRetryLimit).toBe(2);
  });

  it('rejects a retry budget above the approved ceiling of two', () => {
    expect(() => loadServerConfig(env({ MODULE4_SILENCE_RETRY_LIMIT: '3' }))).toThrow();
  });

  it('reads a configured translations file and silence timeout', () => {
    const config = loadServerConfig(
      env({
        MODULE4_LOCALISATION_ENABLED: 'true',
        MODULE4_TRANSLATIONS_FILE: '/etc/resus/translations.json',
        MODULE4_SILENCE_TIMEOUT_MS: '4000',
      }),
    );
    expect(config.conversation).toMatchObject({
      localisationEnabled: true,
      translationsFile: '/etc/resus/translations.json',
      silenceTimeoutMs: 4000,
    });
  });
});

describe('Module 3 NLP configuration', () => {
  it('defaults disabled and treats malformed values as disabled', () => {
    expect(loadServerConfig(env()).nlp.enabled).toBe(false);
    expect(loadServerConfig(env({ MODULE3_NLP_ENABLED: 'enabled' })).nlp.enabled).toBe(false);
    expect(loadServerConfig(env({ MODULE3_NLP_ENABLED: 'TRUE' })).nlp.enabled).toBe(true);
  });
});
