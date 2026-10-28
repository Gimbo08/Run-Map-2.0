import { getApps, getApp, initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { firebaseConfig } from './firebase-config.js';

// ---------------------------------------------------------------------------
// RUNMAP COACH — interfaccia dell'agente AI.
// L'agente non modifica mai il piano da solo: produce una proposta e l'atleta
// la approva. Solo dopo l'approvazione gli allenamenti vengono scritti.
// ---------------------------------------------------------------------------

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const $ = (id) => document.getElementById(id);
const api = () => window.RUNMAP_API_URL || '';

let currentUser = null;
let proposal = null;
let selectedDates = new Set();
let history = [];

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TYPE_LABELS = {
  easy: 'Corsa facile',
  long: 'Lungo',
  interval: 'Ripetute',
  tempo: 'Tempo run',
  recovery: 'Recupero',
  rest: 'Riposo',
  race: 'Gara',
  cross: 'Cross training',
  test: 'Test'
};

const VERDICT_LABELS = {
  conferma: 'Conferma il piano',
  alleggerisci: 'Alleggerisci',
  intensifica: 'Intensifica',
  annulla: 'Annulla la seduta',
  sostituisci: 'Sostituisci'
};

const ACTION_LABELS = {
  create: 'nuova',
  update: 'modificata',
  delete: 'eliminata',
  keep: 'invariata'
};

// Etichette leggibili delle settimane del mesociclo.
const WEEK_LABELS = { S1: 'Settimana 1 · carico base', S2: 'Settimana 2 · carico crescente', S3: 'Settimana 3 · picco', S4: 'Settimana 4 · scarico' };

// Raggruppa le sedute per settimana del mesociclo: la progressione si vede a colpo d'occhio.
const groupByWeek = (workouts) => {
  const groups = new Map();
  workouts.forEach((w) => {
    const key = w.weekLabel || 'solo';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(w);
  });
  return [...groups.entries()]
    .sort((a, b) => (a[0] === 'solo' ? 1 : b[0] === 'solo' ? -1 : a[0].localeCompare(b[0])))
    .map(([week, items]) => ({
      label: WEEK_LABELS[week] || (week === 'solo' ? 'Modifiche singole' : week),
      items: items.sort((a, b) => a.date.localeCompare(b.date))
    }));
};

const formatDate = (iso) => {
  const [y, m, d] = String(iso || '').slice(0, 10).split('-');
  if (!y || !m || !d) return String(iso || '');
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return date.toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: 'short' });
};

// I testi dell agente arrivano come righe "- punto" (o righe libere):
// li trasformo in elenchi puntati leggibili invece di un muro di testo.
const bulletList = (value) => {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-–—*]\s*/, ''))
    .map((line) => line.replace(/^\d+\.\s*/, ''));
  if (!lines.length) return '';
  return `<ul class="coach-bullets">${lines.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>`;
};

async function callFunction(name, body, { timeoutMs = 90000, retries = 1 } = {}) {
  const token = await currentUser.getIdToken();
  const url = `${api()}/${name}`;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Richiesta non riuscita');
      return data;
    } catch (error) {
      // Abort = timeout; TypeError = rete bloccata o interrotta. In entrambi
      // i casi ha senso riprovare una volta prima di mostrare l'errore.
      const transient = error.name === 'AbortError' || error.name === 'TypeError';
      if (!transient || attempt >= retries) {
        if (error.name === 'AbortError') throw new Error('L analisi sta impiegando troppo tempo: riprova tra qualche minuto');
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderStatus(text, tone = '') {
  const el = $('coachStatus');
  if (!el) return;
  el.textContent = text || '';
  el.className = `coach-status ${tone}`.trim();
  el.hidden = !text;
}

// Riassunto in una riga: cosa decide l'agente oggi + quanti giorni cambiano.
const buildSummaryLine = () => {
  const verdict = VERDICT_LABELS[proposal.todayDecision?.verdict] || 'piano confermato';
  const changes = (proposal.workouts || []).filter((w) => !w.isPast && w.action !== 'keep').length;
  const nextChange = (proposal.workouts || []).filter((w) => !w.isPast && w.action !== 'keep')
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  const when = nextChange ? `Prima modifica ${formatDate(nextChange.date)}` : 'Nessuna modifica ai prossimi giorni';
  return `Oggi: ${verdict.toLowerCase()}${nextChange ? ` · ${changes} ${changes === 1 ? 'modifica' : 'modifiche'} in arrivo · ${when}` : ''}`;
};

// Blocco richiudibile: titolo con conteggio, contenuto nascosto finché serve.
const collapsible = (title, inner, open = false) => `
  <details class="coach-fold"${open ? ' open' : ''}>
    <summary>${esc(title)}<span class="coach-fold-arrow" aria-hidden="true"></span></summary>
    <div class="coach-fold-body">${inner}</div>
  </details>`;

// Conta le righe che bulletList mostrera' (stessa logica di split):
// niente conteggi doppi o fantasmi.
const countBullets = (value) =>
  String(value || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).length;

function renderProposal() {
  const root = $('coachProposal');
  if (!root) return;

  if (!proposal) {
    root.innerHTML = '<p class="coach-empty">Nessuna proposta attiva. Rispondi al check-in per far analizzare i tuoi allenamenti.</p>';
    return;
  }

  const readiness = proposal.readiness || { score: 0, status: 'giallo', summary: '' };
  const risks = proposal.risks || [];
  const workouts = proposal.workouts || [];
  const futureWorkouts = workouts.filter((w) => !w.isPast);
  const todayWorkout = workouts.find((w) => w.origin === 'today') || null;

  const riskHtml = risks.length
    ? `<ul class="coach-risks">${risks
      .map(
        (r) =>
          `<li class="risk-${esc(r.level)}"><strong>${esc(r.area)}</strong><span>${esc(r.message)}</span>${r.advice ? `<em>${esc(r.advice)}</em>` : ''}</li>`
      )
      .join('')}</ul>`
    : '';

  // Raggruppo per settimana se il piano porta le etichette S1-S4: la
  // progressione del mesociclo si legge a colpo d'occhio.
  const hasWeeks = futureWorkouts.some((w) => w.weekLabel);
  const weekGroups = hasWeeks ? groupByWeek(futureWorkouts) : null;
  const workoutHtml = futureWorkouts.length
    ? (weekGroups
      ? weekGroups
        .map((group) => `<div class="coach-week-group"><p class="coach-week-label">${esc(group.label)}</p>${group.items.map(renderWorkoutCard).join('')}</div>`)
        .join('')
      : futureWorkouts.map(renderWorkoutCard).join(''))
    : '<p class="coach-empty">L\'agente non propone modifiche ai prossimi giorni.</p>';

  root.innerHTML = `
    <div class="coach-readiness">
      <div class="coach-score tone-${esc(readiness.status)}">
        <strong>${esc(readiness.score)}</strong><small>/100</small>
      </div>
      <div>
        <span class="coach-eyebrow">Prontezza di oggi</span>
        <p>${esc(readiness.summary || 'Valutazione non disponibile')}</p>
        <p class="coach-summary-line">${esc(buildSummaryLine())}</p>
      </div>
    </div>

    ${risks.length ? collapsible('Rischi e fastidi', `<ul class="coach-risks">${riskHtml.replace(/^<ul[^>]*>|<\/ul>$/g, '')}</ul>`, risks.some((r) => r.level === 'danger')) : ''}

    <section class="coach-block coach-decision">
      <h3>Decisione di oggi</h3>
      <p class="coach-verdict verdict-${esc(proposal.todayDecision?.verdict)}">${esc(VERDICT_LABELS[proposal.todayDecision?.verdict] || '')}</p>
      ${bulletList(proposal.todayDecision?.reason)}
      ${todayWorkout ? `<p class="coach-today-title"><strong>${esc(todayWorkout.title)}</strong>${todayWorkout.main ? ` — ${esc(todayWorkout.main)}` : ''}</p>` : ''}
    </section>

    <section class="coach-block">
      <div class="coach-block-head">
        <h3>Proposta di piano</h3>
        <button class="coach-link" type="button" id="coachToggleAll">Seleziona tutto</button>
      </div>
      <div class="coach-workouts">${workoutHtml}</div>
    </section>

    ${proposal.analysis ? collapsible('Analisi', bulletList(proposal.analysis)) : ''}
    ${proposal.methodology ? collapsible('Metodologia', bulletList(proposal.methodology)) : ''}
    ${proposal.raceTactic ? collapsible('Tattica gara', bulletList(proposal.raceTactic)) : ''}
    ${(proposal.suggestions || []).length
      ? collapsible('Suggerimenti', `<ul class="coach-suggestions">${proposal.suggestions.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`)
      : ''
    }

  <div class="coach-actions">
      <button class="primary" type="button" id="coachApprove" ${proposal.status === 'applied' ? 'disabled' : ''}>Approva modifiche selezionate</button>
      <button class="secondary" type="button" id="coachDiscard">Scarta proposta</button>
    </div>
    ${proposal.status === 'applied' ? '<p class="coach-applied">Proposta gia applicata. Se "Allenamenti futuri" e vuoto, rigenera il piano da "Crea nuovo piano".</p>' : ''}
  `;

  bindProposalEvents(futureWorkouts);
}

// Storico: l'agente ricorda tutto, e l'atleta può rileggerlo.
function renderHistory() {
  const root = $('coachHistory');
  if (!root) return;
  if (!history.length) {
    root.innerHTML = '<p class="coach-empty">Nessun check-in registrato. Il primo sarà la base della memoria del coach.</p>';
    return;
  }
  root.innerHTML = history
    .map((item) => {
      const outcome = item.outcome ? `<span class="coach-badge">${esc(item.outcome)}</span>` : '';
      const readiness = item.readiness != null ? `<span class="coach-badge">prontezza ${esc(item.readiness)}</span>` : '';
      return `<article class="coach-history-row">
        <div class="coach-history-date">${esc(formatDate(item.data))}</div>
        <div class="coach-history-text">${esc(item.testo)}</div>
        <div class="coach-history-meta">${outcome}${readiness}</div>
      </article>`;
    })
    .join('');
}

function renderWorkoutCard(w) {
  const checked = selectedDates.has(w.date) ? 'checked' : '';
  const isToday = w.origin === 'today';
  const headline = [w.distanceKm ? `${esc(w.distanceKm)} km` : '', w.targetPace ? `${esc(w.targetPace)}/km` : '', w.targetHr ? `FC ${esc(w.targetHr)}` : '']
    .filter(Boolean)
    .join(' · ');
  const details = [
    w.purpose ? `<dt>Obiettivo</dt><dd>${esc(w.purpose)}</dd>` : '',
    w.warmup ? `<dt>Riscaldamento</dt><dd>${esc(w.warmup)}</dd>` : '',
    w.main ? `<dt>Parte centrale</dt><dd>${esc(w.main)}</dd>` : '',
    w.cooldown ? `<dt>Defaticamento</dt><dd>${esc(w.cooldown)}</dd>` : '',
    w.notes ? `<dt>Note</dt><dd>${esc(w.notes)}</dd>` : ''
  ].filter(Boolean).join('');
  return `<article class="coach-workout ${isToday ? 'is-today' : ''}" data-date="${esc(w.date)}">
    <label class="coach-workout-pick">
      <input type="checkbox" data-pick="${esc(w.date)}" ${checked}>
      <span class="coach-workout-date">${esc(formatDate(w.date))}${isToday ? ' · oggi' : ''}</span>
    </label>
    <div class="coach-workout-body">
      <div class="coach-workout-head">
        <strong>${esc(w.title || 'Allenamento')}</strong>
        <span class="coach-badge type-${esc(w.type)}">${esc(TYPE_LABELS[w.type] || w.type)}</span>
        <span class="coach-badge action-${esc(w.action)} coach-action-badge">${esc(ACTION_LABELS[w.action] || w.action)}</span>
      </div>
      ${headline ? `<p class="coach-workout-headline">${headline}</p>` : ''}
      ${details ? `<details class="coach-workout-more"><summary>Dettagli</summary><dl class="coach-workout-detail">${details}</dl></details>` : ''}
    </div>
  </article>`;
}

function bindProposalEvents(workouts) {
  document.querySelectorAll('[data-pick]').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) selectedDates.add(input.dataset.pick);
      else selectedDates.delete(input.dataset.pick);
      updateApproveLabel();
    });
  });

  const toggle = $('coachToggleAll');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const allSelected = workouts.every((w) => selectedDates.has(w.date));
      workouts.forEach((w) => (allSelected ? selectedDates.delete(w.date) : selectedDates.add(w.date)));
      renderProposal();
    });
  }

  const approve = $('coachApprove');
  if (approve) {
    approve.disabled = !workouts.length || proposal.status === 'applied';
    approve.addEventListener('click', applyProposal);
  }

  const discard = $('coachDiscard');
  if (discard) {
    discard.addEventListener('click', async () => {
      if (!proposal) return;
      const current = proposal;
      proposal = null;
      selectedDates = new Set();
      renderProposal();
      renderStatus('Proposta scartata: il piano non è stato modificato. Il coach se ne ricorderà.', 'info');
      // Lo scarto resta in memoria: l'agente non riproporrà le stesse modifiche.
      try {
        await callFunction('coachDiscardProposal', { proposalId: current.id });
      } catch (error) {
        console.warn('Scarto non registrato', error);
      }
      loadHistory();
    });
  }

  updateApproveLabel();
}

function updateApproveLabel() {
  const button = $('coachApprove');
  if (!button) return;
  const count = selectedDates.size;
  button.textContent = count ? `Approva ${count} modifiche` : 'Approva modifiche selezionate';
  button.disabled = !count;
}

// ---------------------------------------------------------------------------
// Azioni
// ---------------------------------------------------------------------------
async function submitCheckin(event) {
  event.preventDefault();
  const field = $('coachCheckinText');
  const text = (field?.value || '').trim();

  // UNICO pulsante "Invia": con testo = check-in+analisi; campo vuoto =
  // aggiorna piano (l'analisi senza check-in). Un pulsante in meno in pagina.
  if (text.length < 3) {
    await refreshPlan();
    return;
  }

  const button = $('coachCheckinSubmit');
  const original = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Invio al coach...';
  }
  renderStatus('Analisi di allenamenti, carico e gara in corso...', 'info');

  try {
    const data = await callFunction('coachCheckin', { text, chat: true });
    proposal = data.proposal;
    selectedDates = new Set((proposal.workouts || []).filter((w) => !w.isPast && w.action !== 'keep').map((w) => w.date));
    renderProposal();
    renderStatus('Proposta pronta: controlla e approva solo ciò che condividi.', 'ok');
    if (data.memory) {
      renderStatus(`Proposta pronta. Il coach ricorda ${data.memory.checkins} check-in e ${data.memory.proposte} decisioni passate.`, 'ok');
    }
    // La parte conversazionale della risposta finisce anche nella chat:
    // un solo invio = registrazione + dialogo.
    if (data.chatReply) {
      chatBubble('coach', data.chatReply);
    }
    field.value = '';
    loadHistory();
  } catch (error) {
    console.error(error);
    renderStatus(error.message || 'L\'agente non ha risposto. Riprova.', 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

async function refreshPlan() {
  const button = $('coachCheckinSubmit'); // il pulsante unificato
  const original = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Analisi...';
  }
  renderStatus('Aggiornamento del piano in corso...', 'info');
  try {
    const data = await callFunction('coachRefreshPlan', {});
    proposal = data.proposal;
    selectedDates = new Set((proposal.workouts || []).filter((w) => !w.isPast && w.action !== 'keep').map((w) => w.date));
    renderProposal();
    renderStatus('Nuova proposta generata.', 'ok');
  } catch (error) {
    console.error(error);
    renderStatus(error.message || 'Rigenerazione non riuscita.', 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

async function applyProposal() {
  if (!proposal || !selectedDates.size) return;
  const count = selectedDates.size;
  if (!confirm(`Applicare ${count} modifiche al piano di allenamento?`)) return;

  const button = $('coachApprove');
  if (button) {
    button.disabled = true;
    button.textContent = 'Applicazione...';
  }

  try {
    await callFunction('coachApplyProposal', { proposalId: proposal.id, dates: [...selectedDates] });
    proposal.status = 'applied';
    renderStatus('Piano aggiornato. Gli allenamenti sono visibili in "Allenamenti futuri".', 'ok');
    renderProposal();
    // Aggiorno la lista allenamenti futuri senza refresh: chiamata diretta
    // (se il modulo e' gia caricato) + evento CustomEvent come fallback.
    if (typeof window.runmapReloadPlan === 'function') window.runmapReloadPlan();
    window.dispatchEvent(new CustomEvent('runmap:plan-updated'));
  } catch (error) {
    console.error(error);
    renderStatus(error.message || 'Applicazione non riuscita.', 'error');
    if (button) button.disabled = false;
  }
}

async function loadHistory() {
  if (!currentUser) return;
  try {
    const token = await currentUser.getIdToken();
    const response = await fetch(`${api()}/coachHistory`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return;
    const data = await response.json();
    // Il coach legge tutto (lato backend), la UI mostra solo gli ultimi 10:
    // un menu a scomparsa con 400 voci sarebbe inutilizzabile.
    history = (data.checkins || []).slice(0, 10);
    renderHistory();
  } catch (error) {
    console.warn('Storico coach non disponibile', error);
  }
}

async function loadLatest() {
  try {
    const token = await currentUser.getIdToken();
    const response = await fetch(`${api()}/coachLatestProposal`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return;
    const data = await response.json();
    // La proposta pendente PIU' RECENTE si mostra sempre: un piano 28 giorni
    // generato ieri e' ancora valido da approvare oggi (il filtro "solo di oggi"
    // lo nascondeva e l'approvazione diventava impossibile).
    const pending = (data.proposals || []).find((p) => p.status === 'pending');
    if (pending) {
      proposal = pending;
      selectedDates = new Set((pending.workouts || []).filter((w) => !w.isPast && w.action !== 'keep').map((w) => w.date));
      renderProposal();
      renderStatus('C\'è una proposta in attesa di approvazione.', 'info');
    } else {
      renderProposal();
    }
  } catch (error) {
    console.warn('Proposta precedente non disponibile', error);
    renderProposal();
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
// --- Creazione nuovo piano: preferenze esplicite dell'atleta ---
const DAY_ORDER = ['lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato', 'domenica'];

function readPlanPrefs() {
  const days = [...document.querySelectorAll('input[name="coachPlanDay"]:checked')].map((el) => el.value);
  const disciplines = [...document.querySelectorAll('input[name="coachPlanDiscipline"]:checked')].map((el) => el.value);
  const gender = document.querySelector('input[name="coachPlanGender"]:checked')?.value || '';
  const base = document.querySelector('input[name="coachPlanBase"]:checked')?.value || 'strada';
  const longDay = $('coachPlanLongDay')?.value || '';
  const objective = $('coachPlanObjective')?.value || '';
  if (!days.length) return { error: 'Seleziona almeno un giorno di allenamento' };
  if (!longDay) return { error: 'Scegli il giorno del lungo' };
  if (!DAY_ORDER.includes(longDay)) return { error: 'Giorno del lungo non valido' };
  return { prefs: { gender, trainingDays: days, disciplines, longDay, objective, base } };
}

async function createPlan(event) {
  event.preventDefault();
  const parsed = readPlanPrefs();
  if (parsed.error) { renderStatus(parsed.error, 'warn'); return; }

  const button = event.target.querySelector('button[type=submit]');
  const original = button?.textContent;
  if (button) { button.disabled = true; button.textContent = 'Il coach sta costruendo il piano...'; }
  renderStatus('Generazione del piano in corso...', 'info');

  try {
    const data = await callFunction('coachCheckin', {
      text: 'Nuovo piano: configura le prossime settimane secondo le mie preferenze.',
      prefs: parsed.prefs
    });
    proposal = data.proposal;
    selectedDates = new Set((proposal.workouts || []).filter((w) => !w.isPast && w.action !== 'keep').map((w) => w.date));
    renderProposal();
    renderStatus('Piano generato: controlla le sedute e approva quelle che vuoi.', 'ok');
    // Dopo la generazione chiudo il form: la proposta e' la cosa importante.
    if (planSetup) planSetup.hidden = true;
    if (planToggle) { planToggle.setAttribute('aria-expanded', 'false'); planToggle.classList.remove('is-open'); }
  } catch (error) {
    console.error(error);
    renderStatus(error.message || 'Generazione non riuscita.', 'error');
  } finally {
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

// ---------------------------------------------------------------------------
// CHAT CON IL COACH (Fase 1: lettura + proposta, nessuna scrittura diretta)
// ---------------------------------------------------------------------------
let chatBusy = false;

function chatBubble(role, text, actions = null) {
  const log = $('coachChatLog');
  if (!log) return;
  log.hidden = false;
  const bubble = document.createElement('div');
  bubble.className = `coach-chat-bubble ${role === 'user' ? 'is-user' : 'is-coach'}`;
  bubble.innerHTML = `<div class="coach-chat-text">${esc(text).replace(/\n/g, '<br>')}</div>`;
  if (actions) {
    const bar = document.createElement('div');
    bar.className = 'coach-chat-actions';
    actions.forEach((action) => {
      const btn = document.createElement('button');
      btn.className = 'secondary';
      btn.type = 'button';
      btn.textContent = action.label;
      btn.onclick = action.onClick;
      bar.appendChild(btn);
    });
    bubble.appendChild(bar);
  }
  log.appendChild(bubble);
  log.scrollTop = log.scrollHeight;
}

function renderChatProposal(changes, summary, proposalId = null) {
  // Le modifiche proposte in chat diventano una PROPOSTA approvabile:
  // il backend la ha GIA salvata a Firestore (chatProposalId), quindi
  // coachApplyProposal la trova e la applica come le altre.
  proposal = {
    id: proposalId,
    readiness: proposal?.readiness || { score: 50, status: 'giallo', summary: '' },
    analysis: proposal?.analysis || '',
    risks: proposal?.risks || [],
    todayDecision: proposal?.todayDecision || { verdict: 'conferma', reason: '' },
    methodology: proposal?.methodology || '',
    raceTactic: proposal?.raceTactic || '',
    suggestions: proposal?.suggestions || [],
    workouts: changes.map((w) => ({ ...w, origin: 'plan', isPast: false })),
    status: 'pending',
    chatProposal: true,
    chatSummary: summary
  };
  selectedDates = new Set((proposal.workouts || []).filter((w) => !w.isPast).map((w) => w.date));
  renderProposal();
}

async function sendChatMessage(event) {
  event.preventDefault();
  if (chatBusy) return;
  const input = $('coachChatInput');
  const message = (input?.value || '').trim();
  if (message.length < 2) return;

  chatBusy = true;
  const sendBtn = $('coachChatSend');
  if (sendBtn) sendBtn.disabled = true;
  chatBubble('user', message);
  if (input) input.value = '';

  const thinking = $('coachChatLog');
  let thinkingBubble = null;
  if (thinking) {
    thinking.hidden = false;
    thinkingBubble = document.createElement('div');
    thinkingBubble.className = 'coach-chat-bubble is-coach is-thinking';
    thinkingBubble.textContent = 'Il coach sta leggendo il piano...';
    thinking.appendChild(thinkingBubble);
    thinking.scrollTop = thinking.scrollHeight;
  }

  try {
    const data = await callFunction('coachChat', { message });
    if (thinkingBubble) thinkingBubble.remove();
    chatBubble('coach', data.reply);
    if (data.usage) {
      const usage = $('coachChatUsage');
      if (usage) usage.textContent = `${data.usage.used}/${data.usage.limit} oggi`;
    }
    if (data.proposedChanges?.length) {
      const summary = data.changeSummary || `${data.proposedChanges.length} modifiche proposte`;
      chatBubble('coach', summary, [{
        label: 'Vedi e approva le modifiche',
        onClick: () => renderChatProposal(data.proposedChanges, summary, data.chatProposalId)
      }]);
    }
  } catch (error) {
    if (thinkingBubble) thinkingBubble.remove();
    chatBubble('coach', error.message || 'Il coach non ha risposto. Riprova.');
  } finally {
    chatBusy = false;
    if (sendBtn) sendBtn.disabled = false;
  }
}

function init() {
  const form = $('coachCheckinForm');
  if (form) form.addEventListener('submit', submitCheckin);

  const planForm = $('coachPlanForm');
  if (planForm) planForm.addEventListener('submit', createPlan);

  const planToggle = $('coachPlanToggle');
  const planSetup = $('coachPlanSetup');
  if (planToggle && planSetup) {
    // Il tasto apre/chiude il form di configurazione (come un fold).
    planToggle.addEventListener('click', () => {
      const open = planSetup.hidden;
      planSetup.hidden = !open;
      planToggle.setAttribute('aria-expanded', String(open));
      planToggle.classList.toggle('is-open', open);
    });
  }

  // Il pulsante Invia è unico: fa il check-in con testo, aggiorna il piano
  // senza testo. (coachRefresh era il pulsante separato, ora rimosso.)
  const chatForm = $('coachChatForm');
  if (chatForm) chatForm.addEventListener('submit', sendChatMessage);

  const checkinForm = $('coachCheckinForm');
  if (checkinForm) checkinForm.addEventListener('submit', submitCheckin);

  const historyToggle = $('coachHistoryToggle');
  if (historyToggle) {
    // L'intera intestazione e' cliccabile/tappabile, non solo un piccolo pulsante.
    const toggleHistory = () => {
      const list = $('coachHistory');
      if (!list) return;
      list.hidden = !list.hidden;
      historyToggle.setAttribute('aria-expanded', String(!list.hidden));
    };
    historyToggle.addEventListener('click', toggleHistory);
    historyToggle.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleHistory();
      }
    });
  }

  renderProposal();

  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    // Lo storico si scarica subito e resta compresso: niente azioni manuali.
    // Il coach lo rilegge comunque a ogni analisi, indipendentemente dalla UI.
    if (user) { loadLatest(); loadHistory(); }
  });
}

init();
