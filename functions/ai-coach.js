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
  // Intervals include anche attività fuori dal campione importato in Firestore:
  // le unisco per gli ultimi 90 giorni, così l'agente non ignora corse recenti.
  const knownIds = new Set(ctx.activities.map((activity) => String(activity.intervalsId || '')));
  const activities = ctx.activities.map((activity) => {
    const match = byId.get(String(activity.intervalsId || ''));
    if (!match) return activity;
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

  const paces = activities.filter((a) => a.pace).map((a) => paceToSeconds(a.pace)).filter(Boolean);
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
      description: 'Modifiche ai prossimi 14 giorni. Solo le righe che cambiano.',
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
    '4. Proponi le modifiche ai prossimi 14 giorni SOLO dove serve, indicando action = update/create/delete/keep.',
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
    'FORMATO ALLENAMENTO: mai una riga vaga. Ogni seduta deve avere riscaldamento, parte centrale con volumi e ritmi precisi, defaticamento, distanza e obiettivo.',
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

function buildPrompt(ctx, metrics, activities, checkin) {
  const history = ctx.history || { checkins: [], proposals: [] };
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
    }
  };
  return [
    'Ecco il contesto completo dell atleta in formato JSON, letto da tutte le sezioni dell app:',
    JSON.stringify(payload, null, 1),
    '',
    checkin
      ? `L atleta ha risposto al check-in di oggi: "${checkin.text}". Valuta questa risposta con priorità assoluta sulla decisione per oggi.`
      : 'Non c è ancora un check-in per oggi: basati su carico, storico e gare in programma.',
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

function normalizeWorkout(raw, index, today) {
  if (!raw || typeof raw !== 'object') return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || '')) ? String(raw.date) : null;
  if (!date) return null;
  const type = VALID_TYPES.includes(raw.type) ? raw.type : 'easy';
  const action = VALID_ACTIONS.includes(raw.action) ? raw.action : 'update';
  return {
    id: raw.id || null,
    date,
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

function normalizeProposal(result, ctx) {
  const today = ctx.today;
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

    const result = await callGemini(buildPrompt(ctx, metrics, activities, { text, date: today }));
    const proposal = normalizeProposal(result, ctx);

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
      memory: { checkins: ctx.history.checkins.length, proposte: ctx.history.proposals.length }
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

    workouts.forEach((workout) => {
      if (skipped.has(workout.date)) return;
      if (workout.action === 'keep') return;
      if (workout.isPast) return;

      const collectionRef = db.collection(`${base}/futureWorkouts`);
      if (workout.action === 'delete') {
        const target = (workout.id && byId.get(workout.id)) || byDate.get(workout.date);
        if (target) batch.delete(target.ref);
        return;
      }

      // Aggiorna la seduta esistente di quel giorno se c'è, altrimenti la crea.
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
    const snap = await getDb()
      .collection(`users/${user.uid}/coachProposals`)
      .orderBy('createdAt', 'desc')
      .limit(5)
      .get();
    const proposals = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ today: todayInRome(), proposals });
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
