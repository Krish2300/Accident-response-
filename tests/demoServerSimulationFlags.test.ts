import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('isolated demo server fixtures', () => {
  it('marks ambulance, hospital, emergency, and GPS fixture data as simulated', async () => {
    const source = await readFile(new URL('../scripts/demo-server.ts', import.meta.url), 'utf8');
    const simulationFlags = [...source.matchAll(/\bisSimulation:\s*(true|false)\b/g)].map((match) => match[1]);

    expect(simulationFlags).toHaveLength(4);
    expect(simulationFlags).toEqual(['true', 'true', 'true', 'true']);
  });

  it('marks the verifier GPS update as simulated', async () => {
    const source = await readFile(new URL('../scripts/demo-verify.ts', import.meta.url), 'utf8');
    const gpsUpdate = source.match(/source:\s*'SPOOFED'[\s\S]{0,80}?isSimulation:\s*(true|false)/);

    expect(gpsUpdate?.[1]).toBe('true');
  });

  it('allows explicit simulated routes while keeping automatic routes fail-closed', async () => {
    const source = await readFile(new URL('../scripts/demo-server.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/process\.env\.MODULE8_AUTO_ROUTE_SIMULATION\s*=\s*'true'/);
    expect(source).not.toMatch(/process\.env\.MODULE8_AUTO_ROUTE_ENABLED\s*=\s*'true'/);
  });

  it('allows explicit simulated hospital selection while keeping auto-select fail-closed', async () => {
    const source = await readFile(new URL('../scripts/demo-server.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/process\.env\.MODULE7_AUTO_SELECT_SIMULATION\s*=\s*'true'/);
    expect(source).not.toMatch(/process\.env\.MODULE7_AUTO_SELECT_ENABLED\s*=\s*'true'/);
  });

  it('shows simulation-only demo records while keeping learning disabled', async () => {
    const source = await readFile(new URL('../scripts/demo-server.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/process\.env\.MODULE12_INCLUDE_SIM\s*=\s*'true'/);
    expect(source).toMatch(/process\.env\.MODULE12_LEARNING_ENABLED\s*=\s*'false'/);
  });

  it('uses the offline deterministic Module 5 provider instead of requiring Ollama in the demo', async () => {
    const source = await readFile(new URL('../scripts/demo-server.ts', import.meta.url), 'utf8');

    expect(source).toMatch(/process\.env\.LLM_PROVIDER\s*=\s*'heuristic-fallback'/);
    expect(source).toMatch(/module5Providers:\s*\[new HeuristicProvider\(\)\]/);
    expect(source).not.toMatch(/process\.env\.LLM_PROVIDER\s*=\s*'ollama'/);
  });
});
