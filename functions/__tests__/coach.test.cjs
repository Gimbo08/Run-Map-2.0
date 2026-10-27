// Test offline dell'agente: verifica che il contesto legga TUTTE le sezioni
// dell'app e che la proposta venga normalizzata e applicata correttamente.
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const FUNCTIONS = path.join(ROOT, 'functions');
const Module = require('module');

const fake = {
  runActivities: [
    { id: 'a1', date: '2026-10-20', km: 10, type: 'run', intervalsId: '111', shoeId: 's1' },
    { id: 'a2', date: '2026-10-22', km: 5.2, type: 'run', shoeId: 's1' },
    { id: 'a3', date: '2026-10-25', km: 21.1, type: 'run', shoeId: 's2' }
  ],
  futureWorkouts: [
    { id: 'm1', day: 'LUNEDI 27', text: 'Riposo', sortOrder: 1 },
    { id: 'c1', date: '2026-10-29', day: '2026-10-29', text: 'Ripetute', type: 'interval', sortOrder: 2 }
  ],
  plannedNotes: [{ id: 'p1', name: 'Maratona Roma', date: '2027-03-15', distance: 42.195, place: 'Roma' }],
  futureRaces: [{ id: 'f1', name: 'Mezza Bologna', date: '2026-11-10', distance: 21.1, place: 'Bologna' }],
  shoeShelf: [{ id: 's1', brand: 'Nike', model: 'Pegasus', distanceCovered: 600, distanceLimit: 700 }],
  races: [
    { id: 'r1', date: '2026-09-20', name: '10km Modena', city: 'Modena', distance: 10, time: '00:42:30', absolutePlace: 12 },
    { id: 'r2', date: '2026-05-10', name: 'Maratona', city: 'Reggio', distance: 42.195, time: '03:15:00', absolutePlace: 80 }
  ],
  coachCheckins: [
    { id: '2026-10-26', date: '2026-10-26', text: 'Dormito male, gambe stanche', outcome: 'seduta alleggerita', readiness: 50 }
  ],
  coachProposals: [
    { id: 'old1', date: '2026-10-26', status: 'applied', todayDecision: { verdict: 'alleggerisci', reason: 'Stanchezza' }, applied: [{ date: '2026-10-26', action: 'update' }], suggestions: ['Dormire di piu'] }
  ]
};

const toSnap = (docs) => ({ docs: docs.map((d) => ({ id: d.id, data: () => d, ref: { id: d.id } })) });

let written = null;
const dbMock = {
  collection: (p) => {
    const name = p.split('/').pop();
    return {
      get: async () => toSnap(fake[name] || []),
      where: () => ({ get: async () => toSnap(fake[name] || []) }),
      orderBy: () => ({ limit: () => ({ get: async () => toSnap(fake[name] || []) }) }),
      doc: (id) => ({ id, set: async (v) => { written = { id, value: v }; }, get: async () => ({ exists: false, data: () => ({}) }) })
    };
  },
  doc: (p) => ({ get: async () => ({ exists: false, data: () => ({}) }), set: async (v) => { written = { id: p, value: v }; } }),
  batch: () => ({ set: () => {}, delete: () => {}, commit: async () => {} })
};

const modPath = path.join(FUNCTIONS, 'ai-coach.js');

// Intercetto la chiamata a Gemini e restituisco una risposta realistica.
let capturedPrompt = null;
global.fetch = async (url, options) => {
  if (String(url).includes('generativelanguage')) {
    capturedPrompt = JSON.parse(options.body).contents[0].parts[0].text;
    const body = {
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              readiness: { score: 45, status: 'giallo', summary: 'Gambe pesanti, meglio scaricare.' },
              analysis: 'Settimana da 36 km, +12% sul volume.',
              risks: [{ level: 'warning', area: 'tendine', message: 'Fastidio dichiarato', advice: 'Ridurre intensità' }],
              todayDecision: {
                verdict: 'alleggerisci',
                reason: 'Check-in negativo',
                workout: { date: '2026-10-27', type: 'easy', title: 'Corsa facile 6 km', main: '6 km a 5:30', action: 'update' }
              },
              planChanges: [
                { date: '2026-10-29', type: 'recovery', title: 'Recupero', main: '5 km lenti', action: 'update', id: 'c1' },
                { date: '2026-10-31', type: 'long', title: 'Lungo 14 km', main: '14 km a 5:20', action: 'create' },
                { date: '2026-10-20', type: 'easy', title: 'Passato', main: 'x', action: 'update' }
              ],
              methodology: 'Polarizzato 80/20',
              raceTactic: 'Mezza Bologna: 4:20 nei primi 10 km',
              suggestions: ['Dormire di più', 'Controllare le scarpe']
            })
          }]
        }
      }]
    };
    return { ok: true, status: 200, json: async () => body, text: async () => '' };
  }
  if (String(url).includes('intervals.icu')) {
    return {
      ok: true,
      status: 200,
      json: async () => [{ id: '111', distance: 10000, moving_time: 2520, average_heartrate: 158, icu_training_load: 78 }]
    };
  }
  throw new Error('fetch inatteso: ' + url);
};

process.env.GEMINI_API_KEY = 'test-key';

// Accedo alle funzioni interne tramite richiesta HTTP simulata.
const { EventEmitter } = require('events');
const call = (handler, body) => new Promise((resolve) => {
  const req = { method: 'POST', headers: { authorization: 'Bearer finto' }, body };
  const res = new EventEmitter();
  res.statusCode = 200;
  res.setHeader = () => { };
  res.getHeader = () => undefined;
  res.end = () => res.emit('finish');
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { resolve({ code: res.statusCode, payload }); res.emit('finish'); return res; };
  handler(req, res);
});

// Stub Firebase Admin e Firebase Functions a livello di modulo prima di caricare
// il coach: il test non contatta un progetto Firebase reale.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'firebase-admin') {
    return {
      firestore: () => dbMock,
      auth: () => ({ verifyIdToken: async () => ({ uid: 'test-uid' })
    };
  }
  if (request === 'firebase-functions/v2/https') {
    return { onRequest: (_options, handler) => handler };
  }
  return originalLoad.apply(this, arguments);
};
const mod = require(modPath);
Module._load = originalLoad;

(async () => {
  const result = await call(mod.coachCheckin, { text: 'Gambe pesanti e fastidio al tendine destro' });
  if (!result.payload || !result.payload.proposal) {
    console.log('RISPOSTA INATTESA:', result.code, JSON.stringify(result.payload));
    process.exit(1);
  }
  const p = result.payload.proposal;

  const checks = [
    ['risposta 200', result.code === 200],
    ['prompt contiene gare effettuate', /gare_effettuate/.test(capturedPrompt)],
    ['prompt contiene gare in programma', /gare_in_programma/.test(capturedPrompt)],
    ['prompt contiene scarpe', /scarpe/.test(capturedPrompt)],
    ['prompt contiene piano futuro', /piano_futuro/.test(capturedPrompt)],
    ['prompt contiene personal best', /personal_best/.test(capturedPrompt)],
    ['scarpe calcolate con km usati', /Nike Pegasus/.test(capturedPrompt)],
    ['readiness 45', p.readiness.score === 45],
    ['verdetto alleggerisci', p.todayDecision.verdict === 'alleggerisci'],
    ['3 sedute in proposta', p.workouts.length === 3],
    ['seduta passata marcata', p.workouts.some((w) => w.isPast)],
    ['tipo invalido ripulito', p.workouts.every((w) => ['easy', 'long', 'interval', 'tempo', 'recovery', 'rest', 'race', 'cross', 'test'].includes(w.type))],
    ['rischi normalizzati', p.risks.length === 1 && p.risks[0].level === 'warning'],
    ['gara futura presente', /Mezza Bologna/.test(capturedPrompt)],
    ['memoria: check-in passati nel prompt', /storico_checkin/.test(capturedPrompt) && /Dormito male/.test(capturedPrompt)],
    ['memoria: decisioni approvate nel prompt', /storico_decisioni_approvate/.test(capturedPrompt) && /alleggerisci/.test(capturedPrompt)],
    ['check-in aggiornato con esito', written && /outcome|seduta/.test(JSON.stringify(written))],
    ['proposta salvata come pending', written && /pending|readiness/.test(JSON.stringify(written))]
  ];

  checks.forEach(([name, ok]) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`));
  const failed = checks.filter(([, ok]) => !ok).length;
  const message = failed ? `${failed} controlli falliti` : 'TUTTI I CONTROLLI SUPERATI';
  process.stdout.write(`\n${message}\n`, () => process.exit(failed ? 1 : 0));
})();
