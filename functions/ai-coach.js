const admin = require('firebase-admin');
const { onRequest } = require('firebase-functions/v2/https');

// ---------------------------------------------------------------------------
// AI Coach — agente che analizza gli allenamenti registrati e propone modifiche
// strutturate al piano di allenamento. Non scrive mai il piano direttamente:
// ogni modifica passa da una proposta che l'atleta deve approvare.
// ---------------------------------------------------------------------------

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash-lite';
const GEMINI_URL = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const INTERVALS_API = 'https://intervals.icu/api/v1';
const FETCH_ACTIVITIES_LIMIT = 100;

// Contesto completo letto da tutte le sezioni dell'app.
const COACH_TZ = 'Europe/Rome';
const COACH_HISTORY_DAYS = 400;

const getDb = () => admin.firestore();
const verifyToken = (token) => admin.auth().verifyIdToken(token);

const userFromRequest = async (req) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/, '');
  if (!token) return null;
  try {
    return await verifyToken(token);
  } catch {
    return null;
  }
};

// Data di oggi nel fuso italiano (YYYY-MM-DD), non in UTC.
const todayInRome = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: COACH_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const addDays = (isoDate, days) => {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const daysBetween = (fromIso, toIso) => {
  if (!fromIso || !toIso) return null;
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
};

const num = (value, fallback = null) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const round = (value, digits = 2) => (value == null || !Number.isFinite(Number(value)) ? null : Number(Number(value).toFixed(digits)));

const secondsToPace = (secPerKm) => {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) return null;
  const total = Math.round(secPerKm);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

const paceToSeconds = (pace) => {
  const match = String(pace || '').match(/(\d+):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

// ---------------------------------------------------------------------------
// Contesto: tutto ciò che l'app sa, letto da Firestore. L'agente legge ogni
// sezione della dashboard: gare effettuate, gare future, note gare, allenamenti
// registrati, piano futuro, scarpe, profilo e integrazione Intervals.icu.
// ---------------------------------------------------------------------------

const safeGet = async (ref, fallback) => {
  try {
    return await ref.get();
  } catch (error) {
    console.warn('Lettura contesto fallita', error.message);
    return fallback;
  }
};

const snapshotToArray = (snap) => (snap && snap.docs ? snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })) : []);

async function buildContext(uid, days = 90) {
  const db = getDb();
  const base = `users/${uid}`;
  const today = todayInRome();
  const from = addDays(today, -days);

  const [activitiesSnap, futureSnap, plannedSnap, shoesSnap, futureRacesSnap, racesSnap, profileSnap, integrationSnap] = await Promise.all([
    safeGet(db.collection(`${base}/runActivities`), { docs: [] }),
    safeGet(db.collection(`${base}/futureWorkouts`), { docs: [] }),
    safeGet(db.collection(`${base}/plannedNotes`), { docs: [] }),
    safeGet(db.collection(`${base}/shoeShelf`), { docs: [] }),
    safeGet(db.collection(`${base}/futureRaces`), { docs: [] }),
    safeGet(db.collection(`${base}/races`), { docs: [] }),
    safeGet(db.doc(`${base}/profile/settings`), { exists: false, data: () => ({}) }),
    safeGet(db.doc(`${base}/integrations/intervals`), { exists: false, data: () => null })
  ]);

  // Allenamenti registrati: finestra recente per l'analisi del carico.
  const activities = snapshotToArray(activitiesSnap)
    .filter((a) => String(a.date || '') >= from)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  // Storico completo: serve per i personal best e il trend di lungo periodo.
  const allActivities = snapshotToArray(activitiesSnap).sort((a, b) => String(a.date).localeCompare(String(b.date)));

  // Piano futuro: supporta sia il formato strutturato del coach (date ISO) sia
  // le righe inserite a mano o importate da DOC (campo `day` testuale).
  const futureWorkouts = snapshotToArray(futureSnap)
    .map((item) => ({
      ...item,
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(item.date || '')) ? String(item.date) : null,
      structured: !!item.type
    }))
    .sort((a, b) => {
      const da = a.date || '9999-99-99';
      const dbb = b.date || '9999-99-99';
      if (da !== dbb) return da.localeCompare(dbb);
      return (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0);
    });

  // Gare future: il menu "Gare future" usa futureRaces, mentre plannedNotes
  // contiene obiettivi e note gara. I risultati di races restano distinti.
  const futureRaces = snapshotToArray(futureRacesSnap)
    .map((r) => ({ ...r, daysToRace: daysBetween(today, String(r.date)) }))
    .sort((a, b) => String(a.date || '9999-12-31').localeCompare(String(b.date || '9999-12-31')));
  const plannedNotes = snapshotToArray(plannedSnap)
    .map((r) => ({ ...r, daysToRace: daysBetween(today, String(r.date)) }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const upcoming = [...futureRaces, ...plannedNotes].filter((r) => (r.daysToRace ?? 9999) >= 0);
  const nextRace = upcoming.length ? upcoming.slice().sort((a, b) => (a.daysToRace ?? 9999) - (b.daysToRace ?? 9999))[0] : null;

  // Gare effettuate: risultati reali con tempo, piazzamento, distanza.
  const pastRaces = snapshotToArray(racesSnap)
    .filter((r) => String(r.date || '') <= today)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const shoes = snapshotToArray(shoesSnap).map((shoe) => {
    // my-shoes.js registra i km attività separatamente dal campo distanceCovered.
    const covered = (num(shoe.distanceCovered, 0) || 0) + (num(shoe.activityKm, 0) || 0);
    const limit = num(shoe.distanceLimit, 0) || 0;
    return {
      id: shoe.id,
      name: [shoe.brand, shoe.model].filter(Boolean).join(' ') || 'Scarpa',
      kmTotali: round(covered, 1),
      kmLimite: limit || null,
      kmRimanenti: limit ? round(Math.max(0, limit - covered), 1) : null,
      daSostituire: limit ? covered >= limit : false
    };
  });

  const profile = profileSnap.exists ? profileSnap.data() : {};
  const integration = integrationSnap.exists ? integrationSnap.data() : null;

  return {
    today,
    from,
    activities,
    allActivities,
    futureWorkouts,
    futureRaces,
    plannedNotes,
    upcomingRaces: upcoming,
    nextRace,
    pastRaces,
    shoes,
    profile,
    integration
  };
}

// ---------------------------------------------------------------------------
// Intervals.icu arricchisce le attività: Firestore ha solo km e data, mentre per
// una valutazione reale servono passo, frequenza cardiaca, dislivello e carico.
// ---------------------------------------------------------------------------
async function enrichFromIntervals(ctx) {
  const integration = ctx.integration;
  if (!integration || !integration.apiKey || !integration.athleteId) return { enriched: false, activities: ctx.activities };

  const headers = { Authorization: 'Basic ' + Buffer.from(`API_KEY:${integration.apiKey}`).toString('base64') };
  const newest = ctx.today;
  const oldest = ctx.from;
  let raw = [];
  try {
    const url = `${INTERVALS_API}/athlete/${encodeURIComponent(integration.athleteId)}/activities?oldest=${encodeURIComponent(oldest)}&newest=${encodeURIComponent(newest)}&limit=${FETCH_ACTIVITIES_LIMIT}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      console.warn('Intervals enrichment non disponibile', response.status);
      return { enriched: false, activities: ctx.activities };
    }
    raw = await response.json();
  } catch (error) {
    console.warn('Intervals enrichment fallita', error.message);
    return { enriched: false, activities: ctx.activities };
  }

  const byId = new Map((raw || []).map((item) => [String(item.id), item]));
  // Le attività hanno già le metriche salvate dall'import (movingTime, avgHr,
  // pace...) — completale con Intervals solo quelle senza metriche ricche,
  // per non ricalcolare inutilmente a ogni analisi.
  const knownIds = new Set(ctx.activities.map((activity) => String(activity.intervalsId || '')));
  const activities = ctx.activities.map((activity) => {
    const match = byId.get(String(activity.intervalsId || ''));
    if (!match) return activity;
    // Se l'import ha già salvato le metriche, non toccare nulla.
    if (activity.avgHr != null || activity.pace != null || activity.durationMin != null) return activity;
    const movingSec = num(match.moving_time) ?? num(match.elapsed_time);
    const km = num(match.distance) ? num(match.distance) / 1000 : num(activity.km);
    return {
      ...activity,
      km: round(km, 2),
      durationMin: movingSec ? Math.round(movingSec / 60) : null,
      pace: movingSec && km ? secondsToPace(movingSec / km) : null,
      avgHr: num(match.average_heartrate),
      maxHr: num(match.max_heartrate),
      elevationGain: num(match.total_elevation_gain),
      avgCadence: num(match.average_cadence),
      trainingLoad: num(match.icu_training_load) ?? num(match.training_load),
      rpe: num(match.icu_rpe) ?? num(match.perceived_exertion),
      name: match.name || null
    };
  });
  for (const item of raw || []) {
    const id = String(item.id || '');
    if (!id || knownIds.has(id)) continue;
    const type = String(item.type || '');
    if (!['Run', 'VirtualRun', 'TrailRun'].includes(type)) continue;
    const date = String(item.start_date_local || item.start_date || '').slice(0, 10);
    if (!date || date < ctx.from || date > ctx.today) continue;
    const km = num(item.distance, 0) / 1000;
    const movingSec = num(item.moving_time) ?? num(item.elapsed_time);
    activities.push({
      id: `intervals-${id}`,
      intervalsId: id,
      date,
      type: 'run',
      source: 'intervals',
      km: round(km, 2),
      durationMin: movingSec ? Math.round(movingSec / 60) : null,
      pace: movingSec && km ? secondsToPace(movingSec / km) : null,
      avgHr: num(item.average_heartrate),
      maxHr: num(item.max_heartrate),
      elevationGain: num(item.total_elevation_gain),
      avgCadence: num(item.average_cadence),
      trainingLoad: num(item.icu_training_load) ?? num(item.training_load),
      rpe: num(item.icu_rpe) ?? num(item.perceived_exertion),
      name: item.name || null
    });
    knownIds.add(id);
  }
  activities.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { enriched: true, activities };
}

// ---------------------------------------------------------------------------
// Metriche calcolate in modo deterministico: l'agente non deve fare aritmetica.
// ---------------------------------------------------------------------------
function computeMetrics(activities) {
  const byDate = new Map();
  activities.forEach((a) => {
    const date = String(a.date || '');
    if (!date) return;
    const current = byDate.get(date) || { date, km: 0, sessions: 0, load: 0 };
    current.km += num(a.km, 0) || 0;
    current.sessions += 1;
    current.load += num(a.trainingLoad, 0) || 0;
    byDate.set(date, current);
  });
  const daily = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  const weeks = [];
  for (let i = 0; i < 12; i += 1) {
    const end = addDays(todayInRome(), -7 * i);
    const start = addDays(end, -6);
    const inWeek = daily.filter((d) => d.date >= start && d.date <= end);
    weeks.push({
      weekStart: start,
      weekEnd: end,
      km: round(inWeek.reduce((sum, d) => sum + d.km, 0), 1),
      sessions: inWeek.reduce((sum, d) => sum + d.sessions, 0),
      load: Math.round(inWeek.reduce((sum, d) => sum + d.load, 0))
    });
  }

  const last7 = weeks[0];
  const prev7 = weeks[1];
  const last28 = weeks.slice(0, 4);
  const avg28 = last28.length ? round(last28.reduce((sum, w) => sum + (w.km || 0), 0) / last28.length, 1) : 0;
  const weekChangePct = prev7 && prev7.km > 0 ? round(((last7.km - prev7.km) / prev7.km) * 100, 0) : null;

  // Giorni consecutivi di allenamento fino a oggi (riposo = serie interrotta).
  const dateSet = new Set(daily.map((d) => d.date));
  let streak = 0;
  let cursor = todayInRome();
  while (dateSet.has(cursor) && streak < 60) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }

  // Giorni di riposo consecutivi prima dell'ultima seduta.
  const lastSession = daily.length ? daily[daily.length - 1].date : null;
  const restDays = lastSession ? Math.max(0, daysBetween(lastSession, todayInRome()) || 0) : null;

  const paces = activities
    .map((a) => {
      // Il ritmo puo' arrivare come "m:ss" (normale) o come decimale (es. 6.16,
      // dal vecchio import): normalizzo entrambi prima della media.
      if (a.pace != null && a.pace !== '') {
        if (String(a.pace).includes(':')) return paceToSeconds(a.pace);
        const dec = Number(a.pace);
        if (Number.isFinite(dec) && dec > 1.5 && dec < 20) return Math.round(dec * 60);
      }
      if (a.movingTime && a.km) return Math.round(a.movingTime / a.km);
      return null;
    })
    .filter((p) => p && p > 120 && p < 900); // fuori range = dato spurio
  const avgPace = paces.length ? secondsToPace(paces.reduce((s, p) => s + p, 0) / paces.length) : null;

  return {
    totalSessions: activities.length,
    totalKm: round(activities.reduce((sum, a) => sum + (num(a.km, 0) || 0), 0), 1),
    averagePace: avgPace,
    weeks,
    last7Km: last7.km,
    prev7Km: prev7.km,
    avg28Km: avg28,
    weekChangePct,
    consecutiveTrainingDays: streak,
    restDaysBeforeToday: restDays,
    lastSessionDate: lastSession,
    hasHeartRateData: activities.some((a) => a.avgHr),
    hasLoadData: activities.some((a) => a.trainingLoad)
  };
}

// ---------------------------------------------------------------------------
// Schemi di risposta: Gemini deve restituire JSON validato, non testo libero.
// ---------------------------------------------------------------------------
const workoutSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Id del documento futureWorkouts, se esiste' },
    date: { type: 'string', description: 'Data ISO YYYY-MM-DD dell allenamento' },
    weekLabel: { type: 'string', description: 'Settimana del mesociclo: S1, S2, S3 o S4 (solo piani completi)' },
    type: { type: 'string', description: 'easy | long | interval | tempo | recovery | rest | race | cross | test' },
    title: { type: 'string', description: 'Titolo breve, es. Ripetute 6x1000' },
    purpose: { type: 'string', description: 'Obiettivo fisiologico della seduta' },
    warmup: { type: 'string' },
    main: { type: 'string', description: 'Parte centrale con volumi e ritmi espliciti' },
    cooldown: { type: 'string' },
    distanceKm: { type: 'number' },
    targetPace: { type: 'string', description: 'Passo target in min/km, es. 4:35' },
    targetHr: { type: 'string', description: 'Zona o range FC' },
    notes: { type: 'string' },
    action: { type: 'string', description: 'create | update | delete | keep' }
  },
  required: ['date', 'type', 'title', 'action']
};

const responseSchema = {
  type: 'object',
  properties: {
    readiness: {
      type: 'object',
      properties: {
        score: { type: 'integer', description: '0-100, prontezza fisica di oggi' },
        status: { type: 'string', description: 'verde | giallo | rosso' },
        summary: { type: 'string', description: 'Una frase chiara per latleta' }
      },
      required: ['score', 'status', 'summary']
    },
    analysis: { type: 'string', description: 'Analisi degli allenamenti recenti, 3-6 frasi' },
    risks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          level: { type: 'string', description: 'info | warning | danger' },
          area: { type: 'string', description: 'zona del corpo o ambito, es. tendine achilleo, carico' },
          message: { type: 'string' },
          advice: { type: 'string' }
        },
        required: ['level', 'area', 'message']
      }
    },
    todayDecision: {
      type: 'object',
      properties: {
        verdict: { type: 'string', description: 'conferma | alleggerisci | intensifica | annulla | sostituisci' },
        reason: { type: 'string' },
        workout: workoutSchema
      },
      required: ['verdict', 'reason']
    },
    planChanges: {
      type: 'array',
      description: 'Modifiche ai prossimi 7 giorni. Solo le righe che cambiano. Massimo 7 sedute.',
      items: workoutSchema
    },
    methodology: { type: 'string', description: 'Metodologia applicata e perché, 2-4 frasi' },
    raceTactic: { type: 'string', description: 'Tattica per la prossima gara, se esiste una gara in programma' },
    suggestions: { type: 'array', items: { type: 'string' } }
  },
  required: ['readiness', 'analysis', 'todayDecision', 'planChanges', 'suggestions']
};

function systemInstruction() {
  return [
    'Sei RUNMAP COACH: allenatore di corsa esperto e fisioterapista sportivo che lavora dentro l app Run Map.',
    'Parli come il coach che conosce l atleta da anni: diretto, concreto, non servile, non catastrofista.',
    'Niente frasi generiche. Ogni frase deve dire qualcosa di utile, con numeri se ce li hai.',
    '',
    'DOPPIO RUOLO — usali separatamente quando serve:',
    '- Cappello ALLENATORE: progressioni, sedute, ritmo, tattica di gara, dosaggio dello sforzo.',
    '- Cappello FISIOTERAPISTA: solo quando l atleta segnala un fastidio. Gestione del dolore e del carico, esercizi di rinforzo/isometria, criteri per fermarsi e per ripartire. NON fare diagnosi: resta nell ambito della prevenzione e della gestione del carico. Se il quadro lo merita, indirizza al medico sportivo con criteri chiari (quando, perché).',
    '',
    'SCALA DEL DOLORE — linguaggio condiviso con l atleta (0-10):',
    '- 0-3: gestibile. Allenamento possibile con eventuale adattamento (volume/intensità ridotti), monitorare nei giorni successivi.',
    '- 4-6: segnale serio. Adatta o sostituisci la seduta (cross training a basso impatto), nessuna intensità sulla zona dolorante.',
    '- 7-10: fermarsi. Nessuna seduta sulla zona, valutazione medico/fisioterapista prima di riprendere.',
    '- Dolore che peggiora DURANTE la corsa o che altera la camminata => fermarsi a prescindere dal numero.',
    '',
    'METODO:',
    '- Distribuzione polarizzata 80/20: la maggior parte del volume facile, poche sedute intense di qualità.',
    '- Progressione del volume massimo +10% a settimana; ogni quarta settimana di scarico (-25/30%).',
    '- Una sola seduta intensa ogni 48 ore; mai due giorni di qualità consecutivi.',
    '- Tapering: 2 settimane per maratona, 10 giorni per mezza, 5-7 giorni per 10 km e distanze inferiori.',
    '- Se la gara è entro 7 giorni, priorità assoluta al recupero e alla freschezza, non al carico.',
    '- TAPERING QUANTITATIVO: se la gara è entro 7 giorni, il lungo pre-gara non supera il 60% del lungo abituale e la settimana intera riduce il volume del 30-40%. Se non c è nessuna gara vicina, non usare MAI la parola tapering.',
    '- Il conservativismo protegge il recupero, NON deve bloccare il miglioramento: se readiness >= 75 e nessun fastidio segnalato, proponi UNA progressione questa settimana (piu volume o piu qualita) e spiegala: e lo stimolo normale, non un rischio.',
    '- GENDER: se preferenze_piano.gender = donna, adotta la prospettiva fisiologica femminile: FC e soglie tendenzialmente piu alte a parita di ritmo; se il check-in menziona il ciclo mestruale, adatta (calo energetico => recupero o easy; sintomi assenti => qualita possibile); stanchezza persistente con segnali da carenza marziale => suggerisci controlli (ferritina) senza diagnosticare. NON stereotipare: chi corre 60 km a settimana segue la stessa struttura a prescindere dal genere; le differenze stanno nei dettagli, non nel metodo.',
    '- BASE DI ALLENAMENTO (preferenze_piano.base): strada | tapis | mista. Definisce DOVE si corre e COME si esprimono i ritmi:',
    '  * strada: km e ritmi in min/km come sempre.',
    '  * tapis: TUTTE le sedute in tapis. OBBLIGATORIO in ogni fase: ritmo in km/h (tabella: 6:00/km=10.0, 5:30=10.9, 5:00=12.0, 4:45=12.6, 4:30=13.3, 4:15=14.1, 4:00=15.0, 3:50=15.7 km/h) — scrivi SEMPRE il valore km/h esplicito, es. "12.0 km/h", mai solo il ritmo min/km.',
    '  * tapis: pendenza dove utile (ripetute in 2-3%, lento-fondo in salita 4-6%) espressa in %, es. "12.0 km/h pendenza 2.5%".',
    '  * tapis: qualita con recupero fermo o tapis lentissimo (no recuperi in corsa). Lungo fino a 90 min max, con variazioni di pendenza per simularne la varieta.',
    '  * mista: lunghi e sedute di qualita FUORI (strada); recupero, easy corte e giorni con meteo avverso in TAPIS (km/h). Indica nel titolo o note dove corre la seduta (es. "[TAPIS] Recupero 40 min").',
    '  * La STRUTTURA del piano (numero sedute, 80/20, progressione, obiettivo) NON cambia mai con la base: cambia solo la traduzione delle sedute.',
    '',
    'REGOLE DI SICUREZZA (non negoziabili):',
    '- Qualsiasi dolore acuto, puntura, gonfiore, zoppia o fastidio che peggiora durante la corsa => NON proporre intensità. Alleggerisci o annulla e suggerisci valutazione medica.',
    '- Dolore al petto, vertigini, svenimento, fiato corto anomalo => stop immediato, consiglio medico, nessuna seduta proposta.',
    '- Fastidio che persiste da 3+ giorni o che si ripete su una seduta già interrotta => carico ridotto e seduta alternativa.',
    '- Se l atleta dichiara sonno scarso, stress alto o stanchezza marcata, riduci l intensità anche se il piano previsto era intenso.',
    '- Non inventare dati che non sono nel contesto. Se mancano passo o FC, dillo esplicitamente.',
    '',
    'COMPITI:',
    '1. Analizza le attività recenti usando i numeri forniti (volume, passo, FC, carico).',
    '2. Valuta la readiness di oggi (0-100) con status verde/giallo/rosso.',
    '3. Decidi la seduta di OGGI: conferma, alleggerisci, intensifica, annulla o sostituisci.',
    '4. Proponi modifiche ai prossimi 7 giorni SOLO dove serve, indicando action = update/create/delete/keep. MASSIMO 7 sedute: il check-in e una revisione rapida, non la rigenerazione del piano.',
    '5. Indica la tattica di gara se c è una gara in programma, con split e gestione dello sforzo.',
    '6. Segnala rischi e infortuni con livello, zona e consiglio pratico. Quando un fastidio è presente, separa la risposta: prima ALLENAMENTO (cosa far oggi), poi FISICO (ciao gestire il sintomo).',
    '7. Confronta i risultati delle gare effettuate con i personal best e con i ritmi di allenamento: segnala scostamenti.',
    '8. Se una scarpa ha superato o sta per superare il chilometraggio limite, dillo e collegalo a eventuali fastidi.',
    '',
    'DATI DELL APP CHE RICEVI:',
    '- allenamenti_recenti e personal_best: sezione "Allenamenti effettuati".',
    '- gare_effettuate: sezione "Gare effettuate", con tempo e piazzamento.',
    '- prossima_gara e gare_in_programma: sezioni "Gare future" e "Gare pianificate".',
    '- piano_futuro: sezione "Allenamenti futuri", sia righe manuali sia sedute strutturate.',
    '- scarpe: sezione "Le mie scarpe" con km percorsi e limite.',
    'Se una sezione è vuota, dillo in modo esplicito invece di ipotizzare i dati.',
    '',
    'MEMORIA — IMPORTANTE:',
    'Ricevi storico_checkin (tutti i check-in passati con le risposte dell atleta), storico_decisioni_approvate e storico_proposte_scartate.',
    '- Usa la memoria: se un fastidio era già segnalato giorni fa, valutane l evoluzione e dillo.',
    '- Non riproporre una modifica che l atleta ha già scartato senza spiegare perché ora è diversa.',
    '- Riprendi i suggerimenti dati in passato e verifica se sono stati seguiti.',
    '- Se un problema si ripete (es. sonno scarso 3 giorni di fila), trattalo come pattern, non come evento isolato.',
    '',
    'FORMATO ALLENAMENTO — DESCRIZIONE PARLANTE (questa e la regola principale):',
    'Il campo main e una DESCRIZIONE COMPLETA della seduta, scritta come se la spiegassi in chat all atleta — obiettivo, fasi, ritmi personalizzati sui SUOI dati, chilometraggio:',
    '  * Contenuto obbligatorio: PERCHE quella seduta, le FASI con km e ritmi CALCOLATI SUI SUOI DATI (usa allenamenti_recenti e personal_best come riferimento), chilometraggio coerente con distanceKm.',
    '  * Esempio di BUONA descrizione (qualita 9,5 km per un atleta che corre a 5:12/km):',
    '    "Seduta di soglia: insegnarti a sostenere ritmi da gara piu a lungo. Apri con 2 km facili a 6:00/km, poi 6x1000 a 4:45/km (tuo ritmo di soglia, riferito al PB 10k) con 90 s di recupero camminando. Chiudi con 1,5 km a 6:15. Totale 9,5 km. Se la FC supera 175 nelle ripetute, allunga i recuperi."',
    '  * Esempi SBAGLIATI: "corsa facile", "seduta di qualita", "ripetute brevi e recuperi" — niente numeri, niente perche.',
    '  * I ritmi sono PERSONALIZZATI: mai ritmi generici. Qualita = 10-15% piu veloce del suo ritmo medio; facile = 10-20% piu lento; lungo = 5% piu lento con eventuale chiusura piu spinta.',
    '  * SEPARAZIONE RIGIDA dei campi — VIETATO duplicare:',
    '  * warmup: SOLO il riscaldamento (es. "2 km a 6:00/km").',
    '  * main: la descrizione completa della PARTE CENTRALE e del perche (obiettivo, fasi, ritmi personalizzati sui dati dell atleta). NON ripetere il riscaldamento e il defaticamento in main: sono gia nei loro campi. NON scrivere in main il km totale della seduta.',
    '  * cooldown: SOLO il defaticamento (es. "1,5 km a 6:15/km").',
    '  * distanceKm: il TOTALE ufficiale della seduta (unico numero di riferimento per latleta). Se la tua descrizione cita km di fasi, devono sommare a distanceKm SENZA duplicazioni.',
    '',
    'PIANO NUOVO — se preferenze_piano è presente:',
    '- trainingDays: i giorni in cui l atleta PUO allenarsi. Metti le sedute SOLO in quei giorni; gli altri sono SOLO riposo completo — mai cross, mai sport secondari, mai attività leggera.',
    '- longDay: il giorno del lungo. Il lungo va SEMPRE lì, qualunque cosa dica il resto del piano.',
    '  * VINCOLO LUNGO DUREVOLE: guarda il calendario delle date (calendario_date fornito nel contesto): ogni seduta type=long DEVE cadere ESATTAMENTE nel weekday indicato da longDay. Se la tua bozza la mette in un altro giorno, spostala sul longDay più vicino.',
    '  * TAPERING QUANTITATIVO: se la gara è entro 7 giorni, il lungo pre-gara non supera il 60% del lungo abituale e la settimana intera riduce il volume del 30-40%. Se non c è nessuna gara vicina, non usare MAI la parola tapering.',
    '  * IL TAPERING RIDUCE I VOLUMI, NON CANCELLA LE SEDUTE: mantieni la STRUTTURA abituale (stesso numero di uscite, stesse tipologie: easy/qualita/lungo) con distanze ridotte del 30-40%. VIETATO trasformare in riposo i giorni di allenamento dell atleta durante il tapering — al massimo un riposo extra il giorno prima della gara.',
    '- objective: obiettivo della programmazione. Costruisce la struttura:',
    '  * resistenza -> volume crescente, lunghi lunghi, intensità bassa dominante;',
    '  * velocita -> più sedute di qualità (ripetute, tempo), lungo più corto;',
    '  * miglioramento -> equilibrio 80/20 con progressione settimanale chiara;',
    '  * costanza -> volumi moderati e regolari, quasi zero intensità, priorità al non saltare sedute.',
    '  * OBIETTIVO SU DISTANZA SPECIFICA — il piano si calibra sulla gara bersaglio:',
    '    * 10k -> sedute di qualità dominanti su VO2 e soglia (ripetute 400-1000 m a ritmo gara o piu veloce, tempo run 20-30 min), lungo 12-16 km con finali a ritmo gara, volume 30-50 km;',
    '    * mezza -> soglia anaerobica è la regina (tempo run 30-45 min a ritmo mezza, blocchi 2x20 min), lungo 18-24 km con tratti a ritmo mezza, volume 45-70 km;',
    '    * maratona -> resistenza specifica: lunghe 28-35 km con blocchi a ritmo maratona, fondi lunghissimi, qualita moderata (maratona-pace, poche sedute veloci), volume 55-90 km;',
    '    * In TUTTI i casi i ritmi si calibrano sui DATI dell atleta (PB e ritmo medio di personal_best/allenamenti_recenti), MAI su valori generici.',
    '- MESOCICLO A BLOCCHI SETTIMANALI: quando preferenze_piano è presente o il piano attuale è vuoto/scaduto, ti viene chiesto di generare UNA SETTIMANA alla volta (7 giorni, da data X a data Y). Ti riceverai le istruzioni blocco per blocco con il piano delle settimane precedenti come contesto di continuita.',
    '- ATTENZIONE: questa istruzione vale SOLO quando il piano è vuoto o scaduto. Se il piano esiste già, NON rigenerarlo: proponi solo le modifiche necessarie per oggi e i prossimi giorni.',
    '- DISCIPLINE SECONDARIE: se preferenze_piano.disciplines contiene bici/tapis/nuoto, sostituisci OCCASIONALMENTE (max 1-2 sedute a settimana, mai il lungo, mai la principale di qualita) una seduta facile con uno di quegli sport.',
    '  * La corsa resta PRINCIPALE: la 80/20 si calcola solo sulle sedute di corsa, gli sport secondari non aggiungono volume e non sostituiscono mai il lungo.',
    '  * Per quelle sedute: type=cross, title con lo sport (es. "Bici · recupero attivo"), main con durata e intensita (es. "45 min zona 2, cadenza 85+").',
    '  * Sono indicate nei giorni con fastidio lieve o come recupero attivo dopo una seduta intensa.',
    '  * SOLO le sedute rest/cross possono avere main vuoto. OGNI ALTRA seduta (easy, long, interval, tempo, race, test) DEVE avere:',
    '    - UNA PARTE CENTRALE VERA in main (la corsa vera della seduta), oltre al riscaldamento. VIETATO mettere tutta la corsa nel warmup e lasciare main vuoto: una "corsa facile" da 5 km ha warmup breve (1-2 km tecnico) e main con i km restanti a ritmo facile.',
    '    - main con la struttura completa (es. "3 km a 5:10/km + 6 allunghi di 80 m fino a 3:50/km + 2 km a 4:55/km"),',
    '    - distanceKm numerico REALISTICO (la somma settimanale deve essere coerente con il volume dell atleta),',
    '    - targetPace o targetHr (almeno uno dei due),',
    '    - warmup e cooldown per le sedute di qualità (interval, tempo, test); per le easy il warmup PUO coincidere coi primi km.',
    '  * VIETATO scrivere main generici tipo "corsa", "allenamento", "seduta di qualità" senza volumi e ritmi.',
    '',
    'STILE DELLE RISPOSTE — leggibilità prima di tutto:',
    '- Le analisi e le tattiche DEVENO essere elenchi puntati, non muri di testo. Frasi brevi, una idea per punto.',
    '- Ogni testo libero (analysis, raceTactic, methodology, suggerimenti) va scritto come righe separate che iniziano con "- ".',
    '- Esempio per analysis:',
    '  "- Ultima settimana: 42 km su 4 sedute, +12% sul volume.\n- Il lungo di domenica è stato corso a 5:40: ritmo in linea con l obiettivo.\n- FC media 152: sotto soglia, carico gestito bene."',
    '- In ogni elenco metti il punto più importante come primo elemento.',
    '- Massimo 6 punti per elenco: se hai più cose da dire, tieni quelle che cambiano le decisioni.'
  ].join('\n');
}

function buildPrompt(ctx, metrics, activities, checkin, prefs = null, chatStyle = false) {
  const history = ctx.history || { checkins: [], proposals: [] };
  // Calendario esplicito delle prossime 28 date: il modello non deve calcolare
  // lui i giorni della settimana, glielo forniamo (evita lunghi "domenicali" il lunedi).
  const weekdayNames = ['domenica', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato'];
  const calendar = Array.from({ length: 28 }, (_, i) => {
    const date = addDays(ctx.today, i + 1);
    const weekday = weekdayNames[new Date(`${date}T12:00:00Z`).getUTCDay()];
    // L'agente vede PER OGNI GIORNO se puo' allenarti: la regola non e' un
    // promemoria da ricordare, e' scritta nel calendario stesso.
    const puoi = prefs?.trainingDays?.length ? (prefs.trainingDays.includes(weekday) ? 'SI - puoi proporre seduta' : 'NO - solo riposo, nessuna proposta') : 'preferenze non fornite';
    return { date, weekday, puoi_allenarti: puoi };
  });
  const payload = {
    oggi: ctx.today,
    profilo: ctx.profile || {},
    checkin_oggi: checkin ? { testo: checkin.text, registrato_il: checkin.date } : null,

    // --- Memoria della conversazione ---
    storico_checkin: history.checkins.slice(0, 30),
    storico_decisioni_approvate: history.proposals.filter((p) => p.status === 'applied').slice(0, 15),
    storico_proposte_scartate: history.proposals.filter((p) => p.status === 'discarded').slice(0, 10),

    metriche_calcolate: metrics,

    // --- Allenamenti registrati ---
    allenamenti_recenti: activities.slice(0, 30),
    personal_best: personalBests(ctx.allActivities),

    // --- Gare ---
    prossima_gara: ctx.nextRace,
    gare_in_programma: ctx.upcomingRaces.slice(0, 6),
    gare_effettuate: ctx.pastRaces.slice(0, 20).map((r) => ({
      data: r.date,
      nome: r.name,
      luogo: r.city || r.place || null,
      distanza_km: r.distance ?? null,
      tempo: r.time || null,
      posizione: r.absolutePlace ?? null,
      tipo: r.raceType || null
    })),

    // --- Piano attuale ---
    piano_futuro: ctx.futureWorkouts.slice(0, 40),

    // --- Scarpe ---
    scarpe: ctx.shoes,

    // --- Fonti dati ---
    dati_disponibili: {
      intervals_collegato: !!ctx.integration,
      passo_e_fc: activities.some((a) => a.pace || a.avgHr),
      gare_con_risultati: ctx.pastRaces.length,
      allenamenti_registrati: ctx.allActivities.length
    },

    // --- Preferenze di piano (se fornite dall'utente) ---
    preferenze_piano: prefs || null,

    // --- Calendario esplicito delle prossime 28 date ---
    calendario_date: calendar
  };
  return [
    'Ecco il contesto completo dell atleta in formato JSON, letto da tutte le sezioni dell app:',
    JSON.stringify(payload, null, 1),
    '',
    checkin
      ? chatStyle
        ? `L atleta ha risposto al check-in di oggi: "${checkin.text}". Tra le cose, tratta anche eventuali RICHIESTE contenute nel messaggio (spostamenti, dubbi, cambi): se una richiesta e chiara e coerente col piano, includila in planChanges come proposta — sara approvata dall atleta, tu non applichi nulla. La risposta resta comunque una analisi completa con readiness e decisione per oggi.`
        : `L atleta ha risposto al check-in di oggi: "${checkin.text}". Valuta questa risposta con priorità assoluta sulla decisione per oggi.`
      : 'Non c è ancora un check-in per oggi: basati su carico, storico e gare in programma.',
    '',
    'RINNOVO MESOCICLO: se piano_futuro non contiene NESSUNA seduta con data >= oggi, il piano è scaduto.',
    'In quel caso genera il mesociclo completo dei prossimi 28 giorni (regole PIANO NUOVO), usando le preferenze_piano se presenti e lo storico per il volume di partenza.',
    '',
    'SEDUTE DA COMPLETARE: se piano_futuro contiene sedute con needsDetail=true (parti centrali senza ritmo, perché il ritmo medio non era noto quando sono state generate), riscrivile ORA come descrizioni complete con i ritmi calcolati sui suoi dati — mantieni la data e il tipo, arricchisci il contenuto.',
    '',
    'Usa TUTTE le sezioni disponibili: confronta i tempi delle gare effettuate con i personal best, valuta la coerenza tra il piano futuro e la prossima gara, considera lo stato delle scarpe se un fastidio potrebbe dipendere dall usura.'
  ].join('\n');
}

// Personal best per distanza calcolati dalle gare effettuate e dai tempi noti.
function personalBests(activities) {
  const buckets = {};
  activities.forEach((a) => {
    const pace = paceToSeconds(a.pace);
    if (!pace) return;
    const km = num(a.km, 0);
    if (!km) return;
    const total = pace * km;
    [5, 10, 21.0975, 42.195].forEach((target) => {
      if (Math.abs(km - target) <= Math.max(0.4, target * 0.03)) {
        const current = buckets[target];
        if (!current || total < current.secondi) {
          buckets[target] = { distanza_km: target, secondi: Math.round(total), tempo: formatSeconds(total), data: a.date };
        }
      }
    });
  });
  return Object.values(buckets).map(({ secondi, ...rest }) => rest);
}

function formatSeconds(total) {
  const s = Math.round(total);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

async function callGemini(prompt, { json = true } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const error = new Error('GEMINI_API_KEY non configurata');
    error.code = 'NO_API_KEY';
    throw error;
  }

  const body = {
    systemInstruction: { parts: [{ text: systemInstruction() }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.35,
      maxOutputTokens: 16384
    }
  };
  if (json) {
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseSchema = responseSchema;
  }

  // 503 = capacità temporaneamente esaurita: riprovo con backoff, poi fallback.
  const attempt = async (model) => {
    const response = await fetch(`${GEMINI_URL(model)}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (response.status === 503 || response.status === 429) throw Object.assign(new Error(`Gemini ${response.status}`), { retryable: true, status: response.status });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const error = new Error(`Gemini ${response.status}: ${detail.slice(0, 300)}`);
      error.code = 'GEMINI_ERROR';
      throw error;
    }
    return response.json();
  };

  let data = null;
  for (const model of [GEMINI_MODEL, GEMINI_FALLBACK_MODEL]) {
    for (let tryIndex = 0; tryIndex < 2; tryIndex += 1) {
      try {
        data = await attempt(model);
        break;
      } catch (error) {
        if (!error.retryable) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1200 * (tryIndex + 1)));
      }
    }
    if (data) break;
  }
  if (!data) {
    const error = new Error('Gemini temporaneamente sovraccarico (503)');
    error.code = 'GEMINI_BUSY';
    throw error;
  }

  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts || []).map((p) => p.text || '').join('');
  if (!text) {
    const reason = candidate?.finishReason || 'UNKNOWN';
    const feedback = (data.promptFeedback?.blockReason) || null;
    const error = new Error(`Gemini risposta vuota (finishReason=${reason}${feedback ? `, block=${feedback}` : ''})`);
    error.code = 'EMPTY';
    console.error('Gemini empty response', JSON.stringify({ reason, feedback, promptFeedback: data.promptFeedback || null }).slice(0, 500));
    throw error;
  }
  if (!json) return text;
  // I modelli recenti possono incapsulare il JSON nel blocco ```json ... ```:
  // estraggo il contenuto prima di fare il parse.
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Ultima spiaggia: cerco il primo oggetto annidato bilanciato nel testo.
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        // fall through a BAD_JSON
      }
    }
    console.error('BAD_JSON payload:', cleaned.slice(0, 800));
    const error = new Error('Risposta Gemini non in JSON valido');
    error.code = 'BAD_JSON';
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Normalizzazione: le proposte diventano righe strutturate futureWorkouts.
// ---------------------------------------------------------------------------
const VALID_TYPES = ['easy', 'long', 'interval', 'tempo', 'recovery', 'rest', 'race', 'cross', 'test'];
const VALID_ACTIONS = ['create', 'update', 'delete', 'keep'];
const VALID_WEEKS = ['S1', 'S2', 'S3', 'S4'];

function normalizeWorkout(raw, index, today) {
  if (!raw || typeof raw !== 'object') return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || '')) ? String(raw.date) : null;
  if (!date) return null;
  const type = VALID_TYPES.includes(raw.type) ? raw.type : 'easy';
  const action = VALID_ACTIONS.includes(raw.action) ? raw.action : 'update';
  return {
    id: raw.id || null,
    date,
    weekLabel: VALID_WEEKS.includes(String(raw.weekLabel || '')) ? String(raw.weekLabel) : null,
    type,
    title: String(raw.title || '').slice(0, 140) || 'Allenamento',
    purpose: String(raw.purpose || '').slice(0, 400),
    warmup: String(raw.warmup || '').slice(0, 600),
    main: String(raw.main || '').slice(0, 1200),
    cooldown: String(raw.cooldown || '').slice(0, 600),
    distanceKm: num(raw.distanceKm),
    targetPace: String(raw.targetPace || '').slice(0, 60),
    targetHr: String(raw.targetHr || '').slice(0, 60),
    notes: String(raw.notes || '').slice(0, 600),
    action,
    isPast: date < today,
    index
  };
}

// Le settimane del mesociclo derivano dalle DATE, non dal modello: giorno 1-7 =
// S1, 8-14 = S2, 15-21 = S3, 22-28 = S4. Cosi' l'etichetta non puo' essere
// spostata per errore dal LLM.
const weekFromDate = (date, firstDay) => {
  const offset = daysBetween(firstDay, date);
  if (offset == null || offset < 0) return null;
  return ['S1', 'S2', 'S3', 'S4'][Math.min(3, Math.floor(offset / 7))] || null;
};

function normalizeProposal(result, ctx) {
  const today = ctx.today;
  // Ritmo medio REALE dell'atleta (dalle ultime attivita') per i filler:
  // "a ritmo facile" senza numero e' inutile.
  const basePace = ctx.metrics?.averagePace || null;
  const paceMult = (mult) => {
    if (!basePace) return null;
    const sec = paceToSeconds(basePace);
    if (!sec) return null;
    const adj = Math.round(sec * mult);
    return `${Math.floor(adj / 60)}:${String(adj % 60).padStart(2, '0')}/km`;
  };
  const todayWorkout = result.todayDecision?.workout ? normalizeWorkout(result.todayDecision.workout, 0, today) : null;
  const changes = Array.isArray(result.planChanges)
    ? result.planChanges.map((w, i) => normalizeWorkout(w, i + 1, today)).filter(Boolean)
    : [];

  const byDate = new Map();
  if (todayWorkout) byDate.set(todayWorkout.date, { ...todayWorkout, origin: 'today' });
  changes.forEach((w) => {
    const existing = byDate.get(w.date);
    if (existing && existing.origin === 'today') return;
    byDate.set(w.date, { ...w, origin: 'plan' });
  });

  // Il mesociclo completo parte da domani: ricalcolo le settimane dalle date.
  const fullPlan = byDate.size >= 21;
  if (fullPlan) {
    const firstDay = [...byDate.values()].map((w) => w.date).sort()[0];
    byDate.forEach((w) => { w.weekLabel = weekFromDate(w.date, firstDay) || w.weekLabel; });
  }

  // BASE TAPIS: il ritmo in km/h è essenziale. Se una fase non lo contiene,
  // lo converto io dai min/km (deterministico, non delegato al modello).
  if (ctx.prefs?.base === 'tapis') {
    const paceToKmh = (minKm) => {
      const m = String(minKm).match(/(\d+):(\d{2})/);
      return m ? (60 / (Number(m[1]) * 60 + Number(m[2]))).toFixed(1) : null;
    };
    byDate.forEach((w) => {
      if (w.type === 'rest' || !w.main) return;
      if (/km\/h/i.test(w.main)) return;
      const kmh = paceToKmh(w.targetPace) || paceToKmh('5:00');
      if (!kmh) return;
      w.main = `${w.main} — [TAPIS] ${kmh} km/h`;
      w.notes = (w.notes ? w.notes + ' ' : '') + `Velocita tapis: ${kmh} km/h (calcolata dal ritmo; regola a sensazione se il tapis e' tarato diverso).`;
    });
  }

  // NOTA: niente conversione forzata rest->recovery. Il tapering legittimo
  // genera riposi (e vanno rispettati); il prompt vieta solo cancellare
  // la STRUTTURA delle sedute. La conversione generalizzata produceva piani
  // di soli recovery consecutivi.
  // VINCOLO LUNGO deterministico: se una seduta long non cade nel longDay
  // preferito, la trasformo in easy a medio volume e marco il lungo del
  // longDay come da costruire. Cosi il piano salvato rispetta il vincolo.
  if (ctx.prefs && ctx.prefs.longDay) {
    const weekdayNames = ['domenica', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato'];
    const plannedLong = [...byDate.values()].filter((w) => w.type === 'long');
    plannedLong.forEach((w) => {
      const weekday = weekdayNames[new Date(`${w.date}T12:00:00Z`).getUTCDay()];
      if (weekday !== ctx.prefs.longDay) {
        w.type = 'easy';
        w.title = (w.title || 'Corsa facile') + ' (il lungo va il ' + ctx.prefs.longDay + ')';
        if (w.distanceKm) w.distanceKm = round(w.distanceKm * 0.7, 1);
        w.weekLabel = weekFromDate(w.date, fullPlan ? [...byDate.values()].map((x) => x.date).sort()[0] : w.date) || w.weekLabel;
      }
    });
    // Sposto il titolo del lungo sul longDay se il piano non lo copre.
    const longCovered = plannedLong.some((w) => weekdayNames[new Date(`${w.date}T12:00:00Z`).getUTCDay()] === ctx.prefs.longDay);
    if (!longCovered) {
      const longDay = [...byDate.values()].find((w) => weekdayNames[new Date(`${w.date}T12:00:00Z`).getUTCDay()] === ctx.prefs.longDay);
      if (longDay && longDay.type !== 'long') {
        longDay.type = 'long';
        longDay.title = 'Lungo';
        longDay.purpose = longDay.purpose || 'Lungo settimanale: base aerobica ed economia di corsa.';
        if (!longDay.distanceKm) longDay.distanceKm = 14;
      }
    }
  }

  // VINCOLO GIORNI (deterministico): le sedute ATTIVE (non rest/cross) devono
  // cadere SOLO nei trainingDays scelti. Il modello ignora il vincolo piu
  // spesso di quanto si pensi: qui lo faccio rispettare dal codice.
  if (ctx.prefs && Array.isArray(ctx.prefs.trainingDays) && ctx.prefs.trainingDays.length) {
    const weekdayNamesFix2 = ['domenica', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato'];
    const byDateSorted = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    let displaced = [];
    byDateSorted.forEach(([date, w]) => {
      if (w.type === 'rest' || w.type === 'cross') return;
      const weekday = weekdayNamesFix2[new Date(`${date}T12:00:00Z`).getUTCDay()];
      if (!ctx.prefs.trainingDays.includes(weekday) && date > ctx.today) {
        // Trasformo in riposo la seduta fuori dai giorni scelti.
        displaced.push({ date, title: w.title, type: w.type });
        w.type = 'rest';
        w.title = 'Riposo';
        w.main = 'Riposo completo.';
        w.purpose = '';
      }
    });
    if (displaced.length) {
      console.log('VINCOLO GIORNI: spostate in riposo', JSON.stringify(displaced));
    }
  }

  // Se il modello genera un piano incompleto (es. 5 giorni su 28), completo io
  // i giorni mancanti: riposo per i giorni non richiesti, struttura coerente
  // per quelli richiesti ma omessi. Deterministico, non dipende dal LLM.
  if (ctx.prefs) {
    const trainingDays = ctx.prefs.trainingDays || [];
    const weekdayNames = ['domenica', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato'];
    const firstDay = fullPlan ? [...byDate.values()].map((w) => w.date).sort()[0] : addDays(ctx.today, 1);
    const lastGenerated = [...byDate.values()].map((w) => w.date).sort().pop() || ctx.today;
    for (let cursor = addDays(ctx.today, 1); daysBetween(cursor, firstDay || addDays(ctx.today, 1)) >= 0 && byDate.size < 28; cursor = addDays(cursor, 1)) {
      if (byDate.has(cursor)) continue;
      const weekday = weekdayNames[new Date(`${cursor}T12:00:00Z`).getUTCDay()];
      const isTrainingDay = trainingDays.includes(weekday);
      byDate.set(cursor, {
        date: cursor,
        weekLabel: weekFromDate(cursor, firstDay || addDays(ctx.today, 1)),
        type: isTrainingDay ? 'recovery' : 'rest',
        title: isTrainingDay ? 'Corsa di recupero (da integrare)' : 'Riposo',
        main: isTrainingDay ? 'Corsa di recupero 20-30 min a ritmo molto facile (il coach integra i dettagli al prossimo aggiornamento).' : 'Riposo completo.',
        purpose: isTrainingDay ? 'Recupero attivo: mantiene il ritmo di corsa senza aggiungere fatica.' : '',
        action: 'create'
      });
    }
  }

  // NOTA: la vecchia "coerenza km" (rescale delle fasi dal testo) e stata
  // rimossa: con la descrizione parlante corrompeva piu di quanto riparasse.
  // Il totale ufficiale e' distanceKm; il prompt vieta duplicazioni.

  // SEDUTE SENZA PARTE CENTRALE: una seduta attiva (non rest/cross) con main
  // vuoto e' un buco. La riparo con un contenuto coerente al tipo e al totale
  // (calcolato sul ritmo reale dell'atleta).
  byDate.forEach((w) => {
    if (w.type === 'rest' || w.type === 'cross') return;
    if (w.main && String(w.main).trim()) return;
    const tot = num(w.distanceKm) || 0;
    const parseKm = (text) => { const m = String(text || '').match(/(\d+[.,]?\d*)\s*km/i); return m ? Number(m[1].replace(',', '.')) : 0; };
    const remaining = Math.max(1, round(tot - parseKm(w.warmup) - parseKm(w.cooldown), 1));
    // Fillers CALCOLATI sui ritmi reali dell'atleta. MAI stampare "null": se
    // il ritmo medio non e' noto, il testo resta senza cifra e la seduta e'
    // marcata needsDetail (il coach la completa al prossimo check-in).
    const paceText = (mult, fallbackLabel) => paceMult(mult) || fallbackLabel;
    const fillers = {
      easy: `${remaining} km a ritmo facile${paceText(1.1, '') ? ` (${paceText(1.1, '')})` : ''}`,
      long: `${remaining} km a ritmo lungo${paceText(1.05, '') ? ` (${paceText(1.05, '')})` : ''}, con ultimi 2 km piu veloci`,
      interval: `${remaining} km: ripetute di 400 m ${paceText(0.85, 'a ritmo sostenuto')} (rec 90 s camminando)`,
      tempo: `${remaining} km: 2 km ${paceText(1.0, 'a ritmo controllato')} + ${Math.max(1, remaining - 2).toFixed(1)} km a ritmo sostenuto`,
      recovery: `${remaining} km molto facili`,
      race: `${remaining} km di gara a ritmo gara`,
      test: `${remaining} km di progressivo, ultimo km a ritmo sostenuto`
    };
    w.main = fillers[w.type] || `${remaining} km a ritmo facile`;
    w.needsDetail = !basePace; // senza ritmo medio noto: il coach completa al prossimo giro
  });

  return {
    readiness: {
      score: Math.max(0, Math.min(100, Math.round(num(result.readiness?.score, 50)))),
      status: ['verde', 'giallo', 'rosso'].includes(result.readiness?.status) ? result.readiness.status : 'giallo',
      summary: String(result.readiness?.summary || '')
    },
    analysis: String(result.analysis || ''),
    risks: Array.isArray(result.risks)
      ? result.risks.map((r) => ({
        level: ['info', 'warning', 'danger'].includes(r.level) ? r.level : 'info',
        area: String(r.area || '').slice(0, 80),
        message: String(r.message || '').slice(0, 500),
        advice: String(r.advice || '').slice(0, 500)
      }))
      : [],
    todayDecision: {
      verdict: ['conferma', 'alleggerisci', 'intensifica', 'annulla', 'sostituisci'].includes(result.todayDecision?.verdict)
        ? result.todayDecision.verdict
        : 'conferma',
      reason: String(result.todayDecision?.reason || '')
    },
    workouts: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    methodology: String(result.methodology || ''),
    raceTactic: String(result.raceTactic || ''),
    suggestions: Array.isArray(result.suggestions) ? result.suggestions.map((s) => String(s).slice(0, 400)) : []
  };
}

const WEEKDAY_NAMES = ['domenica', 'lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato'];

// ---------------------------------------------------------------------------
// GENERAZIONE A BLOCCHI SETTIMANALI: 4 chiamate da 7 giorni invece di 1 da 28.
// Perche: le risposte lunghe degradano (sedute mute a meta piano, campi persi,
// JSON troncato). Una settimana = risposta corta = qualita costante su tutto
// il mesociclo. Ogni blocco riceve il riepilogo delle settimane gia generate
// per continuita di volume e struttura.
// ---------------------------------------------------------------------------
const WEEK_ROLES = ['carico base', 'carico crescente', 'picco', 'scarico (-25/30%)'];

async function generateWeeklyBlocks({ ctx, metrics, activities, prefs, totalDays = 28 }) {
  const history = ctx.history || { checkins: [], proposals: [] };
  const weeklySummaries = [];
  const allWorkouts = [];
  let sharedAnalysis = null;
  let sharedMethodology = null;

  const weeksToBuild = Math.ceil(totalDays / 7);
  const planStart = addDays(ctx.today, 1);

  for (let weekIndex = 0; weekIndex < weeksToBuild; weekIndex += 1) {
    const weekStart = addDays(planStart, weekIndex * 7);
    const weekEnd = addDays(weekStart, 6);
    const role = WEEK_ROLES[weekIndex] || `settima ${weekIndex + 1}`;
    const weekLabel = `S${weekIndex + 1}`;

    // Gare in QUESTA settimana (se l atleta le ha pianificate).
    const racesThisWeek = (ctx.upcomingRaces || []).filter(
      (r) => String(r.date) >= weekStart && String(r.date) <= weekEnd
    );

    const payload = {
      oggi: ctx.today,
      profilo: ctx.profile || {},
      preferenze_piano: prefs,
      metriche_calcolate: metrics,
      allenamenti_recenti: weekIndex === 0 ? activities.slice(0, 30) : [],
      personal_best: weekIndex === 0 ? personalBests(ctx.allActivities) : [],
      prossima_gara: ctx.nextRace,
      gare_in_settimana: racesThisWeek,
      gare_in_programma: ctx.upcomingRaces.slice(0, 6),
      scarpe: ctx.shoes,
      settimana_da_generare: {
        numero: weekIndex + 1,
        ruolo: role,
        dal: weekStart,
        al: weekEnd,
        label: weekLabel
      },
      calendario_settimana: Array.from({ length: 7 }, (_, i) => {
        const date = addDays(weekStart, i);
        const weekday = WEEKDAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()];
        const puoi = prefs?.trainingDays?.length
          ? (prefs.trainingDays.includes(weekday) ? 'SI' : 'NO - solo riposo')
          : 'non specificato';
        return { date, weekday, puoi_allenarti: puoi };
      }),
      settimane_gia_pianificate: weeklySummaries,
      piano_futuro_esistente: ctx.futureWorkouts.filter((w) => String(w.date) >= weekStart && String(w.date) <= weekEnd)
    };

    const prompt = [
      `Sei RUNMAP COACH. Genera SOLO la settimana ${weekIndex + 1} del mesociclo (${role}), dal ${weekStart} al ${weekEnd}.`,
      '',
      'REGOLE VINCOLANTI:',
      '- ESATTAMENTE 7 sedute, una per giorno dal ' + weekStart + ' al ' + weekEnd + '. Nessun giorno omesso.',
      '- Sedute SOLO nei giorni con puoi_allenarti=SI; gli altri SONO riposo completo.',
      `- Il lungo DEVE cadere il ${prefs?.longDay || 'weekend'} (vincolo longDay).`,
      `- ${prefs?.objective ? `Obiettivo del mesociclo: ${prefs.objective}.` : 'Obiettivo: miglioramento bilanciato.'}`,
      prefs?.base === 'tapis' ? '- TUTTE le sedute in tapis: ritmi in km/h obbligatori in ogni fase.' : '',
      prefs?.disciplines?.length ? `- Sport secondari ammessi (max 1-2 questa settimana, mai il lungo): ${prefs.disciplines.join(', ')}.` : '',
      '- Se gare_in_settimana non e vuoto: quella data e type=race, con tapering nei giorni prima e recupero dopo.',
      '',
      'QUALITA DELLA DESCRIZIONE (main): come spiegato in chat — obiettivo della seduta, fasi con km e RITMI CALCOLATI SUI DATI DELL ATLETA, chilometraggio. Mai frasi generiche.',
      '',
      weeklySummaries.length
        ? `CONTINUITA: settimane gia pianificate:\n${JSON.stringify(weeklySummaries, null, 1)}\nRispetta la progressione: questa settimana (${role}) deve essere coerente con il volume e la struttura delle precedenti.`
        : 'Questa e la prima settimana del mesociclo: parti dal volume reale dell atleta (metriche_calcolate).',
      '',
      'Rispondi SOLO con JSON conforme allo schema.'
    ].filter(Boolean).join('\n');

    const result = await callGemini(prompt);
    const proposal = normalizeProposal(result, { ...ctx, prefs });

    if (!sharedAnalysis && proposal.analysis) sharedAnalysis = proposal.analysis;
    if (!sharedMethodology && proposal.methodology) sharedMethodology = proposal.methodology;

    // Riepilogo per il blocco successivo: volume e tipologie di questa settimana.
    const weekWorkouts = proposal.workouts.filter((w) => !w.isPast);
    const summary = {
      settimana: weekLabel,
      ruolo: role,
      volume_km: weekWorkouts.reduce((s, w) => s + (num(w.distanceKm, 0) || 0), 0).toFixed(1),
      tipologie: weekWorkouts.reduce((acc, w) => { acc[w.type] = (acc[w.type] || 0) + 1; return acc; }, {}),
      note: proposal.methodology ? String(proposal.methodology).slice(0, 200) : ''
    };
    weeklySummaries.push(summary);

    allWorkouts.push(...weekWorkouts.map((w) => ({ ...w, weekLabel })));
  }

  return {
    readiness: {
      score: 75,
      status: 'verde',
      summary: `Piano a ${weeksToBuild} settimane generato: ${WEEK_ROLES.join(' -> ')}.`
    },
    analysis: sharedAnalysis || `Mesociclo ${weeksToBuild} settimane generato a blocchi per qualita costante.`,
    risks: [],
    todayDecision: {
      verdict: 'conferma',
      reason: 'Nuovo piano generato: controlla le sedute e approva.'
    },
    workouts: allWorkouts,
    methodology: sharedMethodology || 'Struttura settimanale progressiva.',
    raceTactic: ctx.nextRace ? `Riferimento: ${ctx.nextRace.name || 'gara'} il ${ctx.nextRace.date}.` : '',
    suggestions: []
  };
}

// ---------------------------------------------------------------------------
// Memoria: l'agente rilegge tutto lo storico dei dialoghi e delle decisioni,
// così non riparte da zero a ogni check-in.
// ---------------------------------------------------------------------------
async function loadHistory(uid) {
  const db = getDb();
  const base = `users/${uid}`;
  const since = addDays(todayInRome(), -COACH_HISTORY_DAYS);

  const [checkinsSnap, proposalsSnap] = await Promise.all([
    safeGet(db.collection(`${base}/coachCheckins`).where('date', '>=', since), { docs: [] }),
    safeGet(db.collection(`${base}/coachProposals`).where('date', '>=', since), { docs: [] })
  ]);

  const checkins = snapshotToArray(checkinsSnap)
    .map((c) => ({
      id: c.id,
      date: c.date,
      text: String(c.text || '').slice(0, 1000),
      data: c.date,
      testo: String(c.text || '').slice(0, 1000),
      // Esito del check-in: cosa aveva deciso l'agente quel giorno.
      esito: c.outcome || null,
      prontezza: c.readiness ?? null
    }))
    .sort((a, b) => String(b.data).localeCompare(String(a.data)));

  const proposals = snapshotToArray(proposalsSnap)
    .map((p) => ({
      id: p.id,
      status: p.status || 'pending',
      date: p.date,
      data: p.date,
      stato: p.status || 'pending',
      verdetto: p.todayDecision?.verdict || null,
      motivo: String(p.todayDecision?.reason || '').slice(0, 400),
      rischi: (p.risks || []).map((r) => `${r.area}: ${r.message}`.slice(0, 200)),
      modifiche: (p.applied || []).map((a) => `${a.date} ${a.action}`),
      metodologia: String(p.methodology || '').slice(0, 300),
      tattica: String(p.raceTactic || '').slice(0, 300),
      suggerimenti: (p.suggestions || []).map((s) => String(s).slice(0, 200)),
      feedback: p.feedback || null
    }))
    .sort((a, b) => String(b.data).localeCompare(String(a.data)));

  return { checkins, proposals };
}

// Cosa è successo davvero dopo un check-in: utile per la memoria a lungo termine.
const VERDICT_TO_OUTCOME = {
  conferma: 'piano confermato',
  alleggerisci: 'seduta alleggerita',
  intensifica: 'seduta intensificata',
  annulla: 'seduta annullata',
  sostituisci: 'seduta sostituita'
};

// ---------------------------------------------------------------------------
// Check-in giornaliero ("come ti senti oggi?")
// ---------------------------------------------------------------------------
exports.coachCheckin = onRequest({ cors: true, region: 'europe-west1', timeoutSeconds: 120, invoker: 'public', memory: '512MiB' }, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST richiesto' });
  const user = await userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Login richiesto' });

  const text = String((req.body && req.body.text) || '').trim();
  if (text.length < 3) return res.status(400).json({ error: 'Scrivi come ti senti oggi' });
  if (text.length > 2000) return res.status(400).json({ error: 'Risposta troppo lunga (max 2000 caratteri)' });

  // Preferenze per un NUOVO piano (opzionali): giorni di allenamento, giorno del
  // lungo e obiettivo. Il coach le usa quando il piano e' vuoto o lo si rigenera.
  const prefs = (req.body && req.body.prefs) || null;
  if (prefs) {
    prefs.trainingDays = Array.isArray(prefs.trainingDays)
      ? prefs.trainingDays.map(String).slice(0, 7)
      : null;
    prefs.longDay = String(prefs.longDay || '').slice(0, 10) || null;
    prefs.objective = ['resistenza', 'velocita', 'miglioramento', 'costanza', 'mezza', '10k', 'maratona'].includes(prefs.objective)
      ? prefs.objective
      : null;
    // Sport secondari (bici/tapis/nuoto): restano solo quelli validi.
    prefs.disciplines = Array.isArray(prefs.disciplines)
      ? prefs.disciplines.map(String).filter((d) => ['bici', 'tapis', 'nuoto'].includes(d)).slice(0, 3)
      : [];
    prefs.gender = ['uomo', 'donna'].includes(prefs.gender) ? prefs.gender : null;
    prefs.base = ['strada', 'tapis', 'mista'].includes(prefs.base) ? prefs.base : 'strada';
  }

  // Il check-in puo' anche contenere RICHIESTE conversazionali ("spostami la
  // seduta", "perche riposo?"): in quel caso la risposta include anche reply
  // + proposedChanges, come la chat. Registrazione + conversazione in un invio.
  const chatStyle = !!(req.body && req.body.chat);

  const db = getDb();
  const base = `users/${user.uid}`;
  const today = todayInRome();

  try {
    const checkinRef = db.doc(`${base}/coachCheckins/${today}`);
    await checkinRef.set({ date: today, text, createdAt: Date.now() }, { merge: true });

    const ctx = await buildContext(user.uid);
    const historySnap = await db.collection(`${base}/coachCheckins`).orderBy('date', 'desc').limit(5).get();
    ctx.checkins = historySnap.docs.map((d) => d.data());
    ctx.history = await loadHistory(user.uid);

    const { activities } = await enrichFromIntervals(ctx);
    const metrics = computeMetrics(activities);

    const result = await callGemini(buildPrompt(ctx, metrics, activities, { text, date: today }, prefs, chatStyle));
    const proposal = normalizeProposal(result, { ...ctx, prefs });

    // Risposta conversazionale SENZA seconda chiamata a Gemini: la costruisco
    // dalla proposta gia generata. Prima erano 2 chiamate sequenziali e il
    // check-in sforava i 120s di timeout di Cloud Run.
    let chatReply = null;
    if (chatStyle) {
      const verdict = proposal.todayDecision.verdict;
      const opening = {
        conferma: 'Il piano di oggi va bene cosi.',
        alleggerisci: 'Oggi alleggeriamo.',
        intensifica: 'Oggi possiamo spingere un po\' di piu.',
        annulla: 'Oggi meglio fermarsi.',
        sostituisci: 'Oggi cambiamo seduta.'
      }[verdict] || 'Piano di oggi confermato.';
      const reason = String(proposal.todayDecision.reason || '').replace(/\s+/g, ' ').trim();
      const readiness = proposal.readiness;
      const parts = [opening];
      if (reason) parts.push(reason);
      if (readiness && readiness.summary) parts.push(readiness.summary);
      chatReply = parts.join(' ').slice(0, 800);
    }

    // Il check-in memorizza anche l'esito: nelle analisi future l'agente sa
    // cosa era stato deciso e se la seduta era stata approvata o scartata.
    await checkinRef.set(
      {
        outcome: VERDICT_TO_OUTCOME[proposal.todayDecision.verdict] || proposal.todayDecision.verdict,
        readiness: proposal.readiness.score,
        proposalId: null
      },
      { merge: true }
    );

    const proposalRef = db.collection(`${base}/coachProposals`).doc();
    await checkinRef.set({ proposalId: proposalRef.id }, { merge: true });
    await proposalRef.set({
      ...proposal,
      id: proposalRef.id,
      date: today,
      checkinText: text,
      metrics,
      intervalsEnriched: activities.some((a) => a.pace || a.avgHr),
      status: 'pending',
      createdAt: Date.now()
    });

    res.json({
      proposal: { id: proposalRef.id, ...proposal, status: 'pending', date: today, checkinText: text },
      memory: { checkins: ctx.history.checkins.length, proposte: ctx.history.proposals.length },
      chatReply
    });
  } catch (error) {
    console.error('Coach check-in failed', error);
    if (error.code === 'NO_API_KEY') {
      return res.status(503).json({ error: 'Agente AI non configurato: manca GEMINI_API_KEY nelle Cloud Functions' });
    }
    if (error.code === 'GEMINI_ERROR' && /429/.test(error.message)) {
      return res.status(429).json({ error: 'Troppe richieste all agente: riprova tra poco' });
    }
    if (error.code === 'GEMINI_BUSY') {
      return res.status(503).json({ error: 'Gemini e momentaneamente sovraccarico: riprova tra un minuto' });
    }
    res.status(502).json({ error: 'L agente non ha risposto. Riprova.' });
  }
});

// ---------------------------------------------------------------------------
// CHAT CON IL COACH — Fase 1: conversazione in lettura + proposta.
// L'agente risponde a dubbi, spiega scelte e PUO preparare modifiche come
// proposta approvabile. NON scrive mai il piano direttamente: ogni modifica
// passa dalla stessa approvazione delle proposte standard.
// ---------------------------------------------------------------------------
const CHAT_MAX_MESSAGES_PER_DAY = 30;
const CHAT_MAX_TURNS_IN_CONTEXT = 16;

const CHAT_SYSTEM = [
  'Sei RUNMAP COACH in modalita conversazione diretta con latleta.',
  'Parli italiano, come un allenatore che conosce latleta da anni: diretto, concreto, mai servile.',
  'Hai TUTTO il contesto: piano attuale, allenamenti fatti, gare, scarpe, check-in passati, metriche.',
  '',
  'COSA PUOI FARE IN CHAT:',
  '- Rispondere a dubbi sul piano: perche quella seduta, cosa significa, cosa succede se salta.',
  '- Spiegare le tue scelte con i numeri dell atleta (ritmi reali, volumi, FC).',
  '- Preparare MODIFICHE al piano: se latleta chiede o accetta un cambiamento, restituisci proposedChanges (array di sedute nel formato workout). Saranno mostrate come proposta approvabile — tu NON applichi nulla.',
  '- IMPORTANTE sugli id: per modificare una seduta ESISTENTE devi copiare il suo "id" esatto da piano_futuro e impostare action="update". Per una seduta nuova lascia id vuoto e usa action="create". Usa action="delete" SOLO se latleta chiede esplicitamente con parole come "elimina", "togli", "cancella" quel giorno specifico. Se vuoi SOSTITUIRE la seduta di un giorno, usa action="update" (o create se il giorno e vuoto) con il nuovo contenuto: MAI delete.',
  '- Chiarire dubbi su fastidi, recupero, gara: con la scala del dolore e le regole di sicurezza del tuo ruolo.',
  '',
  'COSA NON PUOI FARE:',
  '- Applicare modifiche tu stesso: proponi, latleta approva con il bottone.',
  '- Cancellare il piano o ripartire da zero in chat: suggerisci "Crea nuovo piano" per quello.',
  '- Inventare dati assenti: se manca info, dillo.',
  '',
  'STILE: risposte BREVI (max 120 parole salvo richiesta di dettaglio), concrete, numeri reali. Una domanda = una risposta. Se la modifica e chiara, proponila con proposedChanges e spiega in 1-2 frasi cosa cambia.',
  'Se NON servono modifiche, lascia proposedChanges vuoto e rispondi solo.'
].join('\n');

const CHAT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'Risposta all atleta, max 120 parole, tono da coach' },
    proposedChanges: {
      type: 'array',
      description: 'Solo se latleta ha chiesto/accettato una modifica: le sedute modificate (formato workout). Vuoto se non servono cambi.',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          weekLabel: { type: 'string' },
          type: { type: 'string' },
          title: { type: 'string' },
          purpose: { type: 'string' },
          warmup: { type: 'string' },
          main: { type: 'string' },
          cooldown: { type: 'string' },
          distanceKm: { type: 'number' },
          targetPace: { type: 'string' },
          targetHr: { type: 'string' },
          notes: { type: 'string' },
          action: { type: 'string', description: 'create | update | delete' },
          id: { type: 'string', description: 'Id della seduta esistente se update/delete' }
        },
        required: ['date', 'type', 'title', 'action']
      }
    },
    changeSummary: { type: 'string', description: 'Riassunto una-riga delle modifiche proposte (per il bottone), vuoto se nessuna' }
  },
  required: ['reply', 'proposedChanges']
};

exports.coachChat = onRequest({ cors: true, region: 'europe-west1', timeoutSeconds: 120, invoker: 'public', memory: '512MiB' }, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST richiesto' });
  const user = await userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Login richiesto' });

  const message = String((req.body && req.body.message) || '').trim();
  if (message.length < 2) return res.status(400).json({ error: 'Scrivi un messaggio' });
  if (message.length > 1000) return res.status(400).json({ error: 'Messaggio troppo lungo (max 1000 caratteri)' });

  const db = getDb();
  const base = `users/${user.uid}`;

  try {
    // Limite giornaliero: il tier gratuito non deve esplodere con chat infinite.
    const today = todayInRome();
    const usageRef = db.doc(`${base}/coachChatUsage/${today}`);
    const usageSnap = await usageRef.get();
    const used = usageSnap.exists ? (usageSnap.data().count || 0) : 0;
    if (used >= CHAT_MAX_MESSAGES_PER_DAY) {
      return res.status(429).json({ error: `Limite giornaliero chat raggiunto (${CHAT_MAX_MESSAGES_PER_DAY} messaggi). Riprova domani.` });
    }

    // Conversazione persistente: una sessione aperta, gli ultimi turni nel contesto.
    const sessionRef = db.doc(`${base}/coachChatSession/current`);
    const sessionSnap = await sessionRef.get();
    const sessionData = sessionSnap.exists ? sessionSnap.data() : { messages: [], updatedAt: 0 };
    // Se l ultima attività e piu vecchia di 3 giorni, la conversazione riparte pulita.
    const stale = Date.now() - (sessionData.updatedAt || 0) > 3 * 24 * 60 * 60 * 1000;
    const priorMessages = stale ? [] : (sessionData.messages || []).slice(-CHAT_MAX_TURNS_IN_CONTEXT);

    const ctx = await buildContext(user.uid);
    ctx.history = await loadHistory(user.uid);
    const { activities } = await enrichFromIntervals(ctx);
    const metrics = computeMetrics(activities);

    const history = ctx.history || { checkins: [], proposals: [] };
    const payload = {
      oggi: ctx.today,
      profilo: ctx.profile || {},
      metriche_calcolate: metrics,
      allenamenti_recenti: activities.slice(0, 15),
      prossima_gara: ctx.nextRace,
      gare_in_programma: ctx.upcomingRaces.slice(0, 4),
      piano_futuro: ctx.futureWorkouts.filter((w) => !w.isPast).slice(0, 20),
      scarpe: ctx.shoes,
      preferenze_piano: (req.body && req.body.prefs) || null,
      messaggi_precedenti: priorMessages.map((m) => ({ ruolo: m.role, testo: String(m.text || '').slice(0, 400) }))
    };

    const prompt = [
      CHAT_SYSTEM,
      '',
      'CONTESTO ATLETA:',
      JSON.stringify(payload, null, 1),
      '',
      'MESSAGGIO NUOVO DELL ATLETA:',
      message
    ].join('\n');

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      const error = new Error('GEMINI_API_KEY non configurata');
      error.code = 'NO_API_KEY';
      throw error;
    }
    // Retry + fallback modello: stessa protezione degli altri percorsi.
    const chatCall = async (model) => {
      const response = await fetch(`${GEMINI_URL(model)}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: CHAT_SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.5,
            maxOutputTokens: 4096,
            responseMimeType: 'application/json',
            responseSchema: CHAT_RESPONSE_SCHEMA
          }
        })
      });
      if (response.status === 503 || response.status === 429) {
        const err = new Error(`Gemini ${response.status}`);
        err.retryable = true;
        throw err;
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const error = new Error(`Gemini ${response.status}: ${detail.slice(0, 200)}`);
        error.code = 'GEMINI_ERROR';
        throw error;
      }
      return response.json();
    };

    let raw = null;
    for (const model of [GEMINI_MODEL, GEMINI_FALLBACK_MODEL]) {
      for (let attempt = 0; attempt < 2 && !raw; attempt += 1) {
        try {
          raw = await chatCall(model);
        } catch (error) {
          if (!error.retryable) throw error;
          await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
        }
      }
    }
    if (!raw) {
      const error = new Error('Gemini temporaneamente sovraccarico');
      error.code = 'GEMINI_BUSY';
      throw error;
    }
    const text = (raw.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    let parsed;
    try {
      parsed = JSON.parse(String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
    } catch {
      // Fallback: la risposta intera diventa reply, senza modifiche proposte.
      parsed = { reply: text.slice(0, 800), proposedChanges: [] };
    }

    const reply = String(parsed.reply || 'Non ho capito, riformula.').slice(0, 1200);
    const proposedChanges = Array.isArray(parsed.proposedChanges)
      ? parsed.proposedChanges.slice(0, 10)
        .map((w) => normalizeWorkout(w, 0, today))
        .filter(Boolean)
        .map(({ index, isPast, ...rest }) => {
          // Sicurezza: se il modello ha detto delete ma ha fornito un titolo e
          // contenuti, intendeva SOSTITUIRE la seduta, non eliminare il giorno.
          const hasContent = !!(rest.title && rest.main);
          if (rest.action === 'delete' && hasContent) return { ...rest, action: 'update' };
          return rest;
        })
      : [];
    const changeSummary = String(parsed.changeSummary || '').slice(0, 200);

    // Persistenza conversazione + usage in un batch.
    const newMessages = [
      ...priorMessages,
      { role: 'user', text: message, at: Date.now() },
      { role: 'coach', text: reply, at: Date.now() }
    ].slice(-CHAT_MAX_TURNS_IN_CONTEXT * 2);

    // Se l'agente ha proposto modifiche, CREO LA PROPOSAL a Firestore:
    // l'approvazione in chat segue lo stesso flusso di coachApplyProposal.
    let chatProposalId = null;
    if (proposedChanges.length) {
      const proposalRef = db.collection(`${base}/coachProposals`).doc();
      await proposalRef.set({
        id: proposalRef.id,
        date: today,
        readiness: { score: 50, status: 'giallo', summary: 'Modifiche discusse in chat' },
        analysis: '',
        risks: [],
        todayDecision: { verdict: 'conferma', reason: changeSummary || 'Modifiche discusse in chat' },
        methodology: '',
        raceTactic: '',
        suggestions: [],
        workouts: proposedChanges,
        chatSummary: changeSummary,
        checkinText: null,
        metrics: null,
        intervalsEnriched: false,
        status: 'pending',
        source: 'chat',
        createdAt: Date.now()
      });
      chatProposalId = proposalRef.id;
    }

    const batch = db.batch();
    batch.set(sessionRef, { messages: newMessages, updatedAt: Date.now() }, { merge: true });
    batch.set(usageRef, { count: used + 1, date: today }, { merge: true });
    await batch.commit();

    res.json({
      reply,
      proposedChanges,
      changeSummary,
      chatProposalId,
      usage: { used: used + 1, limit: CHAT_MAX_MESSAGES_PER_DAY }
    });
  } catch (error) {
    console.error('Coach chat failed', error);
    if (error.code === 'NO_API_KEY') return res.status(503).json({ error: 'Agente AI non configurato' });
    if (error.retryable || error.code === 'GEMINI_BUSY') return res.status(503).json({ error: 'Gemini e momentaneamente sovraccarico: riprova tra poco' });
    res.status(502).json({ error: 'Il coach non ha risposto. Riprova.' });
  }
});

// ---------------------------------------------------------------------------
// Rigenerazione piano senza check-in (es. dopo un import)
// ---------------------------------------------------------------------------
exports.coachRefreshPlan = onRequest({ cors: true, region: 'europe-west1', timeoutSeconds: 120, invoker: 'public', memory: '512MiB' }, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST richiesto' });
  const user = await userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Login richiesto' });

  const db = getDb();
  const base = `users/${user.uid}`;
  try {
    const ctx = await buildContext(user.uid);
    ctx.history = await loadHistory(user.uid);
    const todayCheckin = ctx.history.checkins.find((c) => c.data === ctx.today) || null;

    const { activities } = await enrichFromIntervals(ctx);
    const metrics = computeMetrics(activities);
    const result = await callGemini(buildPrompt(ctx, metrics, activities, todayCheckin));
    const proposal = normalizeProposal(result, ctx);

    const proposalRef = db.collection(`${base}/coachProposals`).doc();
    await proposalRef.set({
      ...proposal,
      id: proposalRef.id,
      date: ctx.today,
      checkinText: todayCheckin?.text || null,
      metrics,
      intervalsEnriched: activities.some((a) => a.pace || a.avgHr),
      status: 'pending',
      createdAt: Date.now()
    });
    res.json({ proposal: { id: proposalRef.id, ...proposal, status: 'pending', date: ctx.today }, memory: { checkins: ctx.history.checkins.length, proposte: ctx.history.proposals.length } });
  } catch (error) {
    console.error('Coach refresh failed', error);
    if (error.code === 'NO_API_KEY') return res.status(503).json({ error: 'Agente AI non configurato: manca GEMINI_API_KEY' });
    res.status(502).json({ error: 'L agente non ha risposto. Riprova.' });
  }
});

// ---------------------------------------------------------------------------
// Applicazione: SOLO dopo approvazione esplicita dell atleta.
// ---------------------------------------------------------------------------
const workoutDocId = (date, type) => `coach-${date}-${type}`;

function renderText(workout) {
  const parts = [];
  if (workout.warmup) parts.push(`Riscaldamento: ${workout.warmup}`);
  if (workout.main) parts.push(workout.main);
  if (workout.cooldown) parts.push(`Defaticamento: ${workout.cooldown}`);
  return parts.join('\n');
}

exports.coachApplyProposal = onRequest({ cors: true, region: 'europe-west1', timeoutSeconds: 60, invoker: 'public' }, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST richiesto' });
  const user = await userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Login richiesto' });

  const proposalId = String((req.body && req.body.proposalId) || '').trim();
  const dates = Array.isArray(req.body && req.body.dates) ? req.body.dates.map(String) : null;
  const skipDates = Array.isArray(req.body && req.body.skipDates) ? req.body.skipDates.map(String) : [];
  if (!proposalId) return res.status(400).json({ error: 'proposalId mancante' });

  const db = getDb();
  const base = `users/${user.uid}`;
  const proposalRef = db.doc(`${base}/coachProposals/${proposalId}`);

  try {
    const snap = await proposalRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Proposta non trovata' });
    const proposal = snap.data();
    if (proposal.status === 'applied') return res.status(409).json({ error: 'Proposta gia applicata' });

    const workouts = (proposal.workouts || []).filter((w) => !dates || dates.includes(w.date));
    const skipped = new Set(skipDates);
    const batch = db.batch();
    const applied = [];

    // Mappa delle sedute già presenti, per aggiornarle invece di duplicarle.
    // Vale anche per le righe manuali/DOC senza data: il coach le sostituisce
    // con la versione strutturata quando indicano lo stesso giorno.
    const existingSnap = await db.collection(`${base}/futureWorkouts`).get();
    const byDate = new Map();
    const byId = new Map();
    existingSnap.docs.forEach((doc) => {
      const data = doc.data();
      byId.set(doc.id, doc);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(data.date || '')) ? String(data.date) : null;
      if (date && !byDate.has(date)) byDate.set(date, doc);
    });

    console.log('coachApplyProposal: richieste', JSON.stringify(workouts.map((w) => ({ date: w.date, action: w.action, id: w.id || null, title: w.title })).slice(0, 15)));

    workouts.forEach((workout) => {
      if (skipped.has(workout.date)) return;
      // keep = "lascia la seduta esistente": non tocco il documento ESISTENTE,
      // ma i giorni di riposo NUOVI con keep vanno creati, altrimenti il piano
      // salvato perde giorni (era la causa dei 28 giorni con buchi).
      if (workout.action === 'keep' && workout.id) return;
      if (workout.action === 'keep' && byId.get(workout.id)) return;
      if (workout.isPast) return;

      const collectionRef = db.collection(`${base}/futureWorkouts`);
      if (workout.action === 'delete') {
        // Elimino SOLO se latleta ha davvero chiesto di eliminare. Una seduta
        // vuota o con titolo generico non e' una richiesta di cancellazione.
        const target = (workout.id && byId.get(workout.id)) || byDate.get(workout.date);
        if (target) {
          batch.delete(target.ref);
          applied.push({ date: workout.date, id: target.id, action: 'delete' });
        }
        return;
      }

      // Aggiorna la seduta esistente di quel giorno se c'è, altrimenti la crea.
      // Se action=update ma la seduta non esiste piu', la ricreo invece di
      // lasciare il giorno vuoto (accadeva con proposte da chat senza id).
      const target = (workout.id && byId.get(workout.id)) || byDate.get(workout.date) || null;
      const docId = target ? target.id : workoutDocId(workout.date, workout.type);
      const text = workout.type === 'rest' ? 'Riposo' : renderText(workout) || workout.title;
      const payload = {
        id: docId,
        date: workout.date,
        day: workout.date,
        text,
        type: workout.type,
        title: workout.title,
        purpose: workout.purpose || '',
        warmup: workout.warmup || '',
        main: workout.main || '',
        cooldown: workout.cooldown || '',
        distanceKm: workout.distanceKm ?? null,
        targetPace: workout.targetPace || '',
        targetHr: workout.targetHr || '',
        notes: workout.notes || '',
        source: 'coach',
        proposalId,
        updatedAt: Date.now()
      };

      if (target) {
        // Righe manuali e importate da DOC non hanno sortOrder/importedAt:
        // vengono preservate, altrimenti la nuova seduta finirebbe in fondo.
        const previous = target.data();
        if (previous.sortOrder !== undefined) payload.sortOrder = previous.sortOrder;
        if (previous.importedAt !== undefined) payload.importedAt = previous.importedAt;
      } else {
        payload.sortOrder = Date.now();
      }

      batch.set(collectionRef.doc(docId), payload, { merge: true });
      applied.push({ date: workout.date, id: docId, action: target ? 'update' : 'create' });
    });

    // L'esito entra nella memoria: in futuro l'agente saprà quali modifiche
    // sono state accettate e quali no.
    batch.set(proposalRef, { status: 'applied', appliedAt: Date.now(), applied }, { merge: true });
    await batch.commit();

    // Diagnostica: quanto è stato scritto davvero (i log parlano piu delle parole).
    console.log('coachApplyProposal OK:', JSON.stringify({
      proposalId,
      richieste: (dates || ['tutte']).length === 1 && dates ? dates.length : (dates ? dates.length : 'tutte'),
      scritte: applied.length,
      skippedPast: workouts.filter((w) => w.isPast).length,
      skippedKeep: workouts.filter((w) => w.action === 'keep').length
    }));

    res.json({ applied, status: 'applied' });
  } catch (error) {
    console.error('Coach apply failed', error);
    res.status(502).json({ error: 'Applicazione della proposta non riuscita' });
  }
});

// ---------------------------------------------------------------------------
// Scarto: l'atleta rifiuta la proposta. Resta in memoria con il motivo.
// ---------------------------------------------------------------------------
exports.coachDiscardProposal = onRequest({ cors: true, region: 'europe-west1', invoker: 'public' }, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST richiesto' });
  const user = await userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Login richiesto' });

  const proposalId = String((req.body && req.body.proposalId) || '').trim();
  const feedback = String((req.body && req.body.feedback) || '').slice(0, 500);
  if (!proposalId) return res.status(400).json({ error: 'proposalId mancante' });

  try {
    const ref = getDb().doc(`users/${user.uid}/coachProposals/${proposalId}`);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Proposta non trovata' });
    await ref.set({ status: 'discarded', discardedAt: Date.now(), feedback: feedback || null }, { merge: true });
    res.json({ status: 'discarded' });
  } catch (error) {
    console.error('Coach discard failed', error);
    res.status(502).json({ error: 'Operazione non riuscita' });
  }
});

// ---------------------------------------------------------------------------
// Lettura dell ultima proposta pendente
// ---------------------------------------------------------------------------
exports.coachLatestProposal = onRequest({ cors: true, region: 'europe-west1', invoker: 'public' }, async (req, res) => {
  const user = await userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Login richiesto' });
  try {
    const [snap, checkinsSnap] = await Promise.all([
      getDb()
        .collection(`users/${user.uid}/coachProposals`)
        .orderBy('createdAt', 'desc')
        .limit(5)
        .get(),
      // Solo il conteggio: leggero, serve all'etichetta dello storico.
      getDb().collection(`users/${user.uid}/coachCheckins`).count().get()
    ]);
    const proposals = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ today: todayInRome(), proposals, checkinsTotali: checkinsSnap.data().count });
  } catch (error) {
    console.error('Coach proposal read failed', error);
    res.status(502).json({ error: 'Lettura proposta non riuscita' });
  }
});

// ---------------------------------------------------------------------------
// Storico: tutti i dialoghi con l'agente, per consultazione e per la memoria.
// ---------------------------------------------------------------------------
exports.coachHistory = onRequest({ cors: true, region: 'europe-west1', invoker: 'public' }, async (req, res) => {
  const user = await userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Login richiesto' });
  try {
    const history = await loadHistory(user.uid);
    res.json({
      checkins: history.checkins,
      proposals: history.proposals,
      totali: { checkins: history.checkins.length, proposte: history.proposals.length }
    });
  } catch (error) {
    console.error('Coach history read failed', error);
    res.status(502).json({ error: 'Lettura storico non riuscita' });
  }
});
