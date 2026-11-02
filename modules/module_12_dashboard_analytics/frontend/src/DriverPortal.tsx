import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  decideDriverAssignment,
  getDriverAssignment,
  login,
  type DriverAssignmentSnapshot,
} from './api.js';

const card: React.CSSProperties = { background: '#fff', border: '1px solid #d9e1e7', borderRadius: 12, padding: '1.25rem', margin: '1rem 0' };
const muted: React.CSSProperties = { color: '#566873' };

/** Separate browser entry point for authenticated ambulance drivers. */
export default function DriverPortal() {
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [snapshot, setSnapshot] = useState<DriverAssignmentSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'RESUS Driver Portal';
    return () => { document.title = previousTitle; };
  }, []);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!token) return;
    try {
      setSnapshot(await getDriverAssignment(token, signal));
      setError(null);
    } catch (cause) {
      if (signal?.aborted) return;
      setError(cause instanceof Error ? cause.message : 'Could not refresh the assignment.');
      if (cause instanceof ApiError && cause.status === 401) setToken(null);
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    // Authenticated short polling keeps offer decisions and dispatcher changes visible promptly.
    const timer = window.setInterval(() => { void refresh(); }, 1500);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [token, refresh]);

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const result = await login(email, password);
      if (!['DRIVER', 'AMBULANCE_DRIVER'].includes(result.user.role)) throw new Error('Sign in with a driver account.');
      setToken(result.token); setPassword('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Sign in failed.'); }
    finally { setBusy(false); }
  }

  async function decide(decision: 'accept' | 'decline') {
    if (!token || !snapshot?.assignment) return;
    setBusy(true); setError(null);
    try {
      await decideDriverAssignment(token, snapshot.assignment.id, decision);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Decision could not be saved.'); }
    finally { setBusy(false); }
  }

  return <main style={{ minHeight: '100vh', background: '#f3f6f8', color: '#17242e', fontFamily: 'system-ui, sans-serif', padding: '2rem', boxSizing: 'border-box' }}>
    <header style={{ maxWidth: 760, margin: '0 auto' }}><h1>RESUS Driver Portal</h1><p style={muted}>Separate driver-facing interface · assignment offers are persisted by the RESUS backend.</p></header>
    <section style={{ ...card, maxWidth: 760, margin: '1rem auto' }}>
      {!token ? <form onSubmit={signIn}>
        <h2>Driver sign in</h2>
        <label style={{ display: 'grid', gap: 6, margin: '1rem 0' }}>Email<input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label style={{ display: 'grid', gap: 6, margin: '1rem 0' }}>Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form> : <>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}><h2>My ambulance assignment</h2><button onClick={() => { setToken(null); setSnapshot(null); }}>Sign out</button></div>
        <p style={muted}>Assignment status refreshes every 1.5 seconds while this page is open.</p>
        {error && <p role="alert" style={{ color: '#a32020' }}>{error}</p>}
        {!snapshot ? <p role="status">Loading assignment…</p> : !snapshot.assigned || !snapshot.assignment ? <p role="status">No active offer or assignment is available for this driver.</p> : <>
          <p><strong>{snapshot.assignment.status}</strong> · {snapshot.ambulance?.vehicleNumber ?? 'Ambulance'} · emergency {snapshot.assignment.emergencyId}</p>
          {snapshot.assignment.status === 'OFFERED' && snapshot.assignment.expiresAt && <p>Offer expires {new Date(snapshot.assignment.expiresAt).toLocaleTimeString()}</p>}
          {snapshot.assignment.status === 'OFFERED' || snapshot.assignment.status === 'ASSIGNED' ? <div style={{ display: 'flex', gap: 12 }}>
            <button disabled={busy} onClick={() => void decide('accept')}>{busy ? 'Saving…' : 'Accept offer'}</button>
            <button disabled={busy} onClick={() => void decide('decline')}>Reject offer</button>
          </div> : <p role="status">Decision recorded by the backend. The dispatcher dashboard will show the updated assignment.</p>}
        </>}
      </>}
    </section>
  </main>;
}
