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

  const workoutHtml = futureWorkouts.length
    ? futureWorkouts
      .map((w) => {
        const checked = selectedDates.has(w.date) ? 'checked' : '';
        const isToday = w.origin === 'today';
        return `<article class="coach-workout ${isToday ? 'is-today' : ''}" data-date="${esc(w.date)}">
            <label class="coach-workout-pick">
              <input type="checkbox" data-pick="${esc(w.date)}" ${checked}>
              <span class="coach-workout-date">${esc(formatDate(w.date))}${isToday ? ' · oggi' : ''}</span>
            </label>
            <div class="coach-workout-body">
              <div class="coach-workout-head">
                <strong>${esc(w.title || 'Allenamento')}</strong>
                <span class="coach-badge type-${esc(w.type)}">${esc(TYPE_LABELS[w.type] || w.type)}</span>
                <span class="coach-badge action-${esc(w.action)}">${esc(w.action)}</span>
              </div>
              ${w.purpose ? `<p class="coach-workout-purpose">${esc(w.purpose)}</p>` : ''}
              <dl class="coach-workout-detail">
                ${w.warmup ? `<dt>Riscaldamento</dt><dd>${esc(w.warmup)}</dd>` : ''}
                ${w.main ? `<dt>Parte centrale</dt><dd>${esc(w.main)}</dd>` : ''}
                ${w.cooldown ? `<dt>Defaticamento</dt><dd>${esc(w.cooldown)}</dd>` : ''}
                ${w.distanceKm ? `<dt>Distanza</dt><dd>${esc(w.distanceKm)} km</dd>` : ''}
                ${w.targetPace ? `<dt>Passo</dt><dd>${esc(w.targetPace)}</dd>` : ''}
                ${w.targetHr ? `<dt>FC</dt><dd>${esc(w.targetHr)}</dd>` : ''}
                ${w.notes ? `<dt>Note</dt><dd>${esc(w.notes)}</dd>` : ''}
              </dl>
            </div>
          </article>`;
      })
      .join('')
    : '<p class="coach-empty">L\'agente non propone modifiche ai prossimi giorni.</p>';

  root.innerHTML = `
    <div class="coach-readiness">
      <div class="coach-score tone-${esc(readiness.status)}">
        <strong>${esc(readiness.score)}</strong><small>/100</small>
      </div>
      <div>
        <span class="coach-eyebrow">Prontezza di oggi</span>
        <p>${esc(readiness.summary || 'Valutazione non disponibile')}</p>
      </div>
    </div>

    ${proposal.analysis ? `<section class="coach-block"><h3>Analisi</h3>${bulletList(proposal.analysis)}</section>` : ''}
    ${riskHtml ? `<section class="coach-block"><h3>Rischi e fastidi</h3>${riskHtml}</section>` : ''}

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

    ${proposal.methodology ? `<section class="coach-block"><h3>Metodologia</h3>${bulletList(proposal.methodology)}</section>` : ''}
    ${proposal.raceTactic ? `<section class="coach-block"><h3>Tattica gara</h3>${bulletList(proposal.raceTactic)}</section>` : ''}
    ${(proposal.suggestions || []).length
      ? `<section class="coach-block"><h3>Suggerimenti</h3><ul class="coach-suggestions">${proposal.suggestions
        .map((s) => `<li>${esc(s)}</li>`)
        .join('')}</ul></section>`
      : ''
    }

    <div class="coach-actions">
      <button class="primary" type="button" id="coachApprove">Approva modifiche selezionate</button>
      <button class="secondary" type="button" id="coachDiscard">Scarta proposta</button>
    </div>
    ${proposal.status === 'applied' ? '<p class="coach-applied">Proposta gia applicata al piano.</p>' : ''}
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
  if (text.length < 3) {
    renderStatus('Scrivi almeno qualche parola su come ti senti oggi.', 'warn');
    return;
  }

  const button = $('coachCheckinSubmit');
  const original = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'L\'agente sta analizzando...';
  }
  renderStatus('Analisi di allenamenti, carico e gara in corso...', 'info');

  try {
    const data = await callFunction('coachCheckin', { text });
    proposal = data.proposal;
    selectedDates = new Set((proposal.workouts || []).filter((w) => !w.isPast && w.action !== 'keep').map((w) => w.date));
    renderProposal();
    renderStatus('Proposta pronta: controlla e approva solo ciò che condividi.', 'ok');
    if (data.memory) {
      renderStatus(`Proposta pronta. Il coach ricorda ${data.memory.checkins} check-in e ${data.memory.proposte} decisioni passate.`, 'ok');
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
  const button = $('coachRefresh');
  const original = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Analisi...';
  }
  renderStatus('Rigenerazione del piano in corso...', 'info');
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
    history = data.checkins || [];
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
    const pending = (data.proposals || []).find((p) => p.status === 'pending' && p.date === data.today);
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
function init() {
  const form = $('coachCheckinForm');
  if (form) form.addEventListener('submit', submitCheckin);

  const refresh = $('coachRefresh');
  if (refresh) refresh.addEventListener('click', refreshPlan);

  const historyToggle = $('coachHistoryToggle');
  if (historyToggle) {
    historyToggle.addEventListener('click', () => {
      const list = $('coachHistory');
      if (!list) return;
      list.hidden = !list.hidden;
      historyToggle.textContent = list.hidden ? 'Mostra' : 'Nascondi';
      if (!list.hidden && !history.length) loadHistory();
    });
  }

  renderProposal();

  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    if (user) {
      loadLatest();
      loadHistory();
    }
  });
}

init();
