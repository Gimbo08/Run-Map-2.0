const crypto=require('crypto');
const {onRequest}=require('firebase-functions/v2/https');
const admin=require('firebase-admin');
const INTERVALS_API='https://intervals.icu/api/v1';const INTERVALS_HISTORY_DAYS=90;const INTERVALS_MAX_ACTIVITIES=10;
const appUrl=()=>process.env.RUNMAP_APP_URL||'https://run-map-2.web.app/';
const userFromRequest=async req=>{const token=String(req.headers.authorization||'').replace(/^Bearer\s+/,'');if(!token)return null;try{return await admin.auth().verifyIdToken(token)}catch{return null}};
const activityType=value=>({Run:'run',VirtualRun:'run',Walk:'walk',Hike:'hike',TrailRun:'hike'}[value]||null);


// ---- Intervals.icu ----
// Intervals.icu riceve le attivita' da Suunto (e da altre piattaforme) e le espone via API
// con una chiave personale: niente abbonamento e nessuna approvazione, a differenza di Strava.
// L'utente salva la sua API key e l'athlete id in users/{uid}/integrations/intervals.
const intervalsHeaders = apiKey => ({ Authorization: 'Basic ' + Buffer.from('API_KEY:' + apiKey).toString('base64') });
const intervalsUserFromRequest = async req => userFromRequest(req);

exports.intervalsConnect = onRequest({ cors: true, region: 'europe-west1', invoker: 'public' }, async (req, res) => {
  const user = await intervalsUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Login richiesto' });
  const apiKey = String((req.body && req.body.apiKey) || '').trim();
  const athleteId = String((req.body && req.body.athleteId) || '').trim();
  if (!apiKey || !athleteId) return res.status(400).json({ error: 'API key e athlete id sono obbligatori' });
  try {
    // Verifico subito le credenziali: se non funzionano, non le salvo.
    const check = await fetch(`${INTERVALS_API}/athlete/${encodeURIComponent(athleteId)}`, { headers: intervalsHeaders(apiKey) });
    if (!check.ok) return res.status(400).json({ error: 'Credenziali Intervals.icu non valide (' + check.status + ')' });
    const athlete = await check.json();
    await admin.firestore().doc(`users/${user.uid}/integrations/intervals`).set({ apiKey, athleteId, athleteName: athlete.name || null, updatedAt: Date.now() }, { merge: true });
    res.json({ connected: true, athleteId, athleteName: athlete.name || null });
  } catch (error) {
    console.error('Intervals connect failed', error);
    res.status(502).json({ error: 'Collegamento Intervals.icu non riuscito' });
  }
});

exports.intervalsDisconnect = onRequest({ cors: true, region: 'europe-west1', invoker: 'public' }, async (req, res) => {
  const user = await intervalsUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Login richiesto' });
  try {
    await admin.firestore().doc(`users/${user.uid}/integrations/intervals`).delete();
    res.json({ connected: false });
  } catch (error) {
    console.error('Intervals disconnect failed', error);
    res.status(502).json({ error: 'Scollegamento Intervals.icu non riuscito' });
  }
});

exports.intervalsImport = onRequest({ cors: true, region: 'europe-west1', timeoutSeconds: 20, invoker: 'public' }, async (req, res) => {
  const user = await intervalsUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Login richiesto' });
  try {
    const ref = admin.firestore().doc(`users/${user.uid}/integrations/intervals`);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ connected: false, error: 'Collega prima Intervals.icu' });
    const integration = snap.data();
    const apiKey = integration.apiKey, athleteId = integration.athleteId;
    if (!apiKey || !athleteId) return res.status(404).json({ connected: false, error: 'Collega prima Intervals.icu' });

    const existingSnapshot = await admin.firestore().collection(`users/${user.uid}/runActivities`).get();
    const byIntervalsId = new Map(existingSnapshot.docs.map(item => [String(item.data().intervalsId || ''), item]));
    const byDoc = new Map(existingSnapshot.docs.map(item => [item.id, item]));
    const byDateKm = new Map(existingSnapshot.docs.map(item => { const d = item.data(); return [`${d.date}|${Number(d.km || 0).toFixed(3)}`, item]; }));

    const newest = new Date().toISOString().slice(0, 10);
    const oldest = new Date(Date.now() - INTERVALS_HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const response = await fetch(`${INTERVALS_API}/athlete/${encodeURIComponent(athleteId)}/activities?oldest=${oldest}&newest=${newest}`, { headers: intervalsHeaders(apiKey) });
    if (response.status === 401 || response.status === 403) return res.status(401).json({ connected: false, error: 'Credenziali Intervals.icu non valide' });
    if (!response.ok) throw new Error(`Intervals activities ${response.status}`);
    const activities = await response.json();

    let imported = 0;
    const batch = admin.firestore().batch();
    const recent = (activities || []).slice().sort((a, b) => String(b.start_date_local || b.start_date || '').localeCompare(String(a.start_date_local || a.start_date || ''))).slice(0, INTERVALS_MAX_ACTIVITIES);(recent || []).forEach(activity => {
      const type = activityType(activity.type);
      if (!type) return;
      const intervalsId = String(activity.id);
      const id = `intervals-${intervalsId}`;
      const date = String(activity.start_date_local || activity.start_date || '').slice(0, 10);
      if (!date) return;
      const km = Number(activity.distance || 0) / 1000;
      const existing = byIntervalsId.get(intervalsId) || byDoc.get(id) || byDateKm.get(`${date}|${km.toFixed(3)}`);
      // Metriche ricche per il coach: FC, ritmo, dislivello, carico, tempo.
      const metrics = {
        km,
        // Tempo totale (secondi) — per il ritmo medio
        movingTime: Number(activity.moving_time || 0) || null,
        elapsedTime: Number(activity.elapsed_time || 0) || null,
        // FC: media, massima (bpm) — l'agente Coach li usa per la readiness
        avgHr: Number(activity.average_heartrate || 0) || null,
        maxHr: Number(activity.max_heartrate || 0) || null,
        // Dislivello (m) — l'accumulo suggerisce il lavoro collinare
        elevGain: Number(activity.total_elevation_gain || 0) || null,
        // Carico di training (TSS/TSS per minuti) — la stanchezza lo rende dominante
        trainingLoad: Number(activity.training_load || 0) || null,
        // Ritmo medio (min/km) — il Coach lo calcola per il tempo di moving time
        // Calcolato solo se entrambi presenti
        // Per il moving time di 3600 (s) e 10000 (m) → 6.00 min/km
        pace: (Number(activity.moving_time || 0) && km) ? (Number(activity.moving_time) / 60) / km : null,
        // RPE percepito dall'utente (se l'attività lo suggerisce)
        perceivedExertion: Number(activity.perceived_exertion || 0) || null,
      };
      const data = { id: existing ? existing.id : id, type, date, source: 'intervals', intervalsId, updatedAt: Date.now(), ...metrics };
      batch.set(existing ? existing.ref : admin.firestore().doc(`users/${user.uid}/runActivities/${id}`), data, { merge: true });
      imported++;
    });
    await batch.commit();
    res.json({ connected: true, imported });
  } catch (error) {
    console.error('Intervals import failed', error);
    res.status(502).json({ error: 'Importazione Intervals.icu non riuscita' });
  }
});