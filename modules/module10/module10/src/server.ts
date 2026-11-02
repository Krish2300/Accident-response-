/**
 * Module 10 – Express HTTP API
 * Exposes REST endpoints that upstream/downstream modules call.
 */

import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { orchestrator } from './orchestrator';
import { dashboardPublisher } from './integrations/dashboardPublisher';
import { eventBus } from './integrations/eventBus';
import { dbPersistence } from './integrations/dbPersistence';
import { logger } from './utils/logger';
import {
  CallerInfo,
} from './types';

const app  = express();
const server = http.createServer(app);

app.use(express.json());

// ─────────────────────────────────────────────
// AUTH MIDDLEWARE (stub – replace with JWT in prod)
// ─────────────────────────────────────────────

app.use((req: Request, res: Response, next: NextFunction) => {
  const token = req.headers['x-internal-token'];
  if (!token || token !== process.env.INTERNAL_API_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
});

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

/** POST /incidents – Module 1 triggers new call */
app.post('/incidents', async (req: Request, res: Response) => {
  try {
    const callerInfo: CallerInfo = req.body;
    if (!callerInfo.callSessionId || !callerInfo.language || !callerInfo.channel) {
      res.status(400).json({ error: 'callSessionId, language, channel required' });
      return;
    }
    const incidentId = await orchestrator.handleNewCall(callerInfo);
    res.status(201).json({ incidentId });
  } catch (err) {
    logger.error(`POST /incidents error: ${err}`);
    res.status(500).json({ error: String(err) });
  }
});

/** POST /incidents/:id/transcription – Module 2 sends transcript */
app.post('/incidents/:id/transcription', async (req: Request, res: Response) => {
  try {
    const { transcript } = req.body;
    if (!transcript) { res.status(400).json({ error: 'transcript required' }); return; }
    await orchestrator.onSpeechTranscribed(req.params.id, transcript);
    res.json({ ok: true });
  } catch (err) {
    logger.error(`POST /transcription error: ${err}`);
    res.status(500).json({ error: String(err) });
  }
});

/** POST /incidents/:id/ambulance – Module 6 confirms dispatch */
app.post('/incidents/:id/ambulance', async (req: Request, res: Response) => {
  try {
    await orchestrator.onAmbulanceDispatched(req.params.id, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** POST /incidents/:id/arrival – ambulance marks patient arrived */
app.post('/incidents/:id/arrival', async (req: Request, res: Response) => {
  try {
    await orchestrator.onPatientArrived(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** POST /incidents/:id/resolved – hospital marks incident complete */
app.post('/incidents/:id/resolved', async (req: Request, res: Response) => {
  try {
    await orchestrator.onIncidentResolved(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** DELETE /incidents/:id – operator cancel */
app.delete('/incidents/:id', async (req: Request, res: Response) => {
  try {
    const { reason } = req.body;
    await orchestrator.cancelIncident(req.params.id, reason ?? 'operator_cancel');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** GET /incidents/active – dashboard polling */
app.get('/incidents/active', (_req: Request, res: Response) => {
  res.json({ incidents: orchestrator.getActiveIncidents() });
});

/** GET /health */
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'module-10', ts: new Date().toISOString() });
});

// ─────────────────────────────────────────────
// BOOTSTRAP
// ─────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  // Connect event bus
  await eventBus.connect();

  // Initialize WebSocket server for Module 12
  await dashboardPublisher.initialize(server);

  // Recovery: reload in-flight incidents from Module 11 DB
  const recovered = await dbPersistence.loadActiveIncidents();
  if (recovered.length > 0) {
    logger.warn(`[Bootstrap] Recovered ${recovered.length} active incidents from DB`);
    // NOTE: In production, you'd rebuild FSM instances from recovered context here.
    // For brevity, we emit a reconnect event so the dashboard can re-subscribe.
    for (const ctx of recovered) {
      await dashboardPublisher.publishAlert({
        incidentId: ctx.incidentId,
        alertType: 'MANUAL_OVERRIDE',
        message: `Incident ${ctx.incidentId} recovered after restart (state: ${ctx.currentState})`,
        severity: ctx.severity,
      });
    }
  }

  const PORT = parseInt(process.env.PORT ?? '8010', 10);
  server.listen(PORT, () => {
    logger.info(`[Bootstrap] Module 10 Orchestrator listening on :${PORT}`);
  });
}

bootstrap().catch((err) => {
  logger.error(`[Bootstrap] Fatal: ${err}`);
  process.exit(1);
});

export default app;
