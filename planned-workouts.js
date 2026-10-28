// ============================================================================
// ALLENAMENTI FUTURI — lista del piano, scritta dal Coach AI + righe manuali.
// Riscritta da zero per robustezza: niente listener che muoiono, niente
// ternari annidati, binding a prova di re-render.
// ============================================================================

import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, collection, getDocs, setDoc, deleteDoc, doc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);

let workouts = [];
let showRest = false;
let started = false;

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function prettyDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return String(iso || '');
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: '2-digit', month: 'short' }).format(d).replace('.', '');
}

function isCoach(item) {
  return item.source === 'coach' || !!item.type;
}

function isRest(item) {
  return item.type === 'rest' || /^riposo$/i.test(String(item.text || '').trim());
}

// ---------------------------------------------------------------------------
// Caricamento
// ---------------------------------------------------------------------------
async function loadWorkouts() {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  try {
    const snap = await getDocs(collection(db, 'users', uid, 'futureWorkouts'));
    workouts = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const da = String(a.date || '9999');
        const dbb = String(b.date || '9999');
        if (da !== dbb) return da.localeCompare(dbb);
        return (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0);
      });
    render();
  } catch (error) {
    console.error('Caricamento allenamenti futuri fallito', error);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function workoutCard(item) {
  const coach = isCoach(item);
  const dayLabel = item.date ? prettyDate(item.date) : esc(item.day || '');

  // --- Struttura canonica dell'allenamento ---
  // KM TOTALI in evidenza + fasi (riscaldamento/centrale/defaticamento) con
  // andatura esplicita riga per riga + descrizione/obiettivo.
  const phases = [];
  if (coach) {
    // Il modello descrive in chat: warmup/main/cooldown vengono mostrati COME
    // SONO, senza re-parsing né somme dal testo. Il totale ufficiale è
    // distanceKm dichiarato — era la fonte dei doppioni e dei totali sforati.
    if (item.warmup) phases.push({ label: 'Riscaldamento', text: item.warmup });
    if (item.main) phases.push({ label: 'La seduta', text: item.main });
    if (item.cooldown) phases.push({ label: 'Defaticamento', text: item.cooldown });
  }
  const phaseRows = phases
    .map((p) => `<tr><td class="pw-phase-label">${esc(p.label)}</td><td class="pw-phase-text ${p.label === 'La seduta' ? 'pw-narrative' : ''}">${esc(p.text)}</td></tr>`)
    .join('');
  const table = phaseRows
    ? `<table class="pw-phases"><tbody>${phaseRows}</tbody></table>`
    : `<div class="pw-text">${esc(item.text || '')}</div>`;

  // Obiettivo/descrizione della seduta: SOLO se il coach l'ha scritta davvero
  // (niente frasi segnaposto).
  const purpose = coach && item.purpose
    ? `<p class="pw-purpose"><b>Obiettivo:</b> ${esc(item.purpose)}${item.notes ? ` · <b>Note:</b> ${esc(item.notes)}` : ''}</p>`
    : '';

  const meta = [];
  if (coach && item.targetPace) meta.push(`${esc(item.targetPace)}/km`);
  if (coach && item.targetHr) meta.push(`FC ${esc(item.targetHr)}`);
  const metaHtml = meta.length ? `<span class="pw-meta">${meta.join(' · ')}</span>` : '';

  // KM TOTALI: quello dichiarato dal coach (distanceKm). Nessuna somma dal
  // testo: descrizioni narrative contengono numeri che non vanno ri-sommati.
  const total = coach && item.distanceKm
    ? `<span class="pw-total">${esc(item.distanceKm)} km</span>`
    : '';

  const title = coach && item.title
    ? `<span class="pw-title">${esc(item.title)}</span>`
    : '';

  return `
    <article class="pw-card ${coach ? 'pw-coach' : ''}" data-id="${esc(item.id)}">
      <div class="pw-day">
        <span class="pw-date">${esc(dayLabel)}</span>
        ${title}
        ${metaHtml}
      </div>
      <div class="pw-body">
        ${total ? `<div class="pw-total-row">${total}<span class="pw-total-label">km totali (fasi incluse)</span></div>` : ''}
        ${table}
        ${purpose}
      </div>
      ${coach ? '<span class="pw-source">Coach AI</span>' : ''}
      <button class="pw-delete" type="button" data-del="${esc(item.id)}" aria-label="Elimina">✕</button>
    </article>`;
}

function render() {
  const list = $('plannedWorkoutList');
  if (!list) return;

  // ARCHIVIAZIONE VISIVA: le sedute con data < oggi escono dalla vista
  // (sono gia in "Allenamenti effettuati" via import). Restano a DB per il coach.
  const today = todayISO();
  const futureItems = workouts.filter((item) => !item.date || String(item.date) >= today);
  const pastCount = workouts.length - futureItems.length;

  if (!workouts.length) {
    list.innerHTML = '<p class="intro">Non hai ancora allenamenti futuri in programma. Creane uno dal Coach AI oppure aggiungilo a mano.</p>';
    return;
  }

  const rows = [];
  let restCount = 0;

  futureItems.forEach((item) => {
    if (isRest(item) && !showRest) { restCount += 1; return; }
    rows.push(workoutCard(item));
  });

  if (restCount) {
    rows.push(`<button class="pw-rest-toggle" id="pwRestToggle" type="button">${showRest ? 'Nascondi' : 'Mostra'} i ${restCount} riposi</button>`);
  }
  if (pastCount) {
    rows.push(`<p class="pw-archive-note">${pastCount} sedute gia trascorse sono in "Allenamenti effettuati".</p>`);
  }

  list.innerHTML = rows.join('');
}

// ---------------------------------------------------------------------------
// Azioni
// ---------------------------------------------------------------------------
function openEditor(item = null) {
  const modal = $('plannedWorkoutModal');
  if (!modal) return;
  $('plannedWorkoutId').value = item?.id || `manual-${Date.now()}`;
  $('plannedWorkoutDay').value = item?.day || item?.date || '';
  $('plannedWorkoutText').value = item?.text || '';
  $('plannedWorkoutTitle').textContent = item ? 'Modifica allenamento' : 'Aggiungi allenamento';
  modal.classList.add('open');
}

function closeModal() {
  $('plannedWorkoutModal')?.classList.remove('open');
}

async function saveFromModal(event) {
  event.preventDefault();
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const id = $('plannedWorkoutId').value;
  const text = $('plannedWorkoutText').value.trim();
  if (!text) return;
  try {
    await setDoc(doc(db, 'users', uid, 'futureWorkouts', id), {
      id,
      day: $('plannedWorkoutDay').value.trim(),
      text,
      updatedAt: Date.now()
    });
    closeModal();
    await loadWorkouts();
  } catch (error) {
    console.error('Salvataggio fallito', error);
    alert('Impossibile salvare. Riprova.');
  }
}

async function deleteWorkout(id) {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  if (!confirm('Eliminare questo allenamento?')) return;
  try {
    await deleteDoc(doc(db, 'users', uid, 'futureWorkouts', id));
    await loadWorkouts();
  } catch (error) {
    console.error('Eliminazione fallita', error);
  }
}

async function deleteAll() {
  if (!workouts.length) return;
  if (!confirm(`Eliminare tutti i ${workouts.length} allenamenti futuri?`)) return;
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  try {
    await Promise.all(workouts.map((item) => deleteDoc(doc(db, 'users', uid, 'futureWorkouts', item.id))));
    await loadWorkouts();
  } catch (error) {
    console.error('Eliminazione massiva fallita', error);
  }
}

// ---------------------------------------------------------------------------
// Eventi (delegati: sopravvivono ai re-render)
// ---------------------------------------------------------------------------
function bindEvents() {
  $('addPlannedWorkout')?.addEventListener('click', () => openEditor());

  $('deleteAllPlannedWorkouts')?.addEventListener('click', deleteAll);

  $('plannedWorkoutList')?.addEventListener('click', (event) => {
    const del = event.target.closest('[data-del]');
    if (del) {
      deleteWorkout(del.dataset.del);
      return;
    }
    const toggle = event.target.closest('#pwRestToggle');
    if (toggle) {
      showRest = !showRest;
      render();
      return;
    }
    const card = event.target.closest('.pw-card');
    if (card && !card.classList.contains('pw-coach')) {
      const item = workouts.find((w) => w.id === card.dataset.id);
      if (item) openEditor(item);
    }
  });

  $('plannedWorkoutModal')?.addEventListener('click', (event) => {
    if (event.target.classList.contains('modal-backdrop')) closeModal();
    if (event.target.closest('.close-modal')) closeModal();
  });

  $('plannedWorkoutForm')?.addEventListener('submit', saveFromModal);
}

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------
function start() {
  if (started || !$('plannedWorkoutList')) return;
  started = true;
  bindEvents();
  loadWorkouts();
  // Espongo il refresh al Coach AI: al posto del solo evento CustomEvent
  // (fragile all'ordine dei moduli), una chiamata diretta e affidabile.
  window.runmapReloadPlan = loadWorkouts;
}

onAuthStateChanged(auth, (user) => {
  if (user) start();
});
