# Run Map — Note di manutenzione

## Coach AI (aggiunto 27/10/2026)

Agente allenatore/fisioterapista basato su **Gemini** (`gemini-3.8-flash`, fallback
`gemini-3.5-flash-lite`). Chiede il check-in giornaliero ("Come ti senti oggi?"), analizza
tutti i dati dell'app e propone modifiche **strutturate** al piano. Le proposte vanno
**sempre approvate dall'atleta**: l'agente non scrive mai il piano da solo.

### Funzioni (in `functions/ai-coach.js`)

| Funzione | Ruolo |
|---|---|
| `coachChat` | Conversazione libera con il coach (Fase 1: proposta, mai scrittura diretta) |
| `coachCheckin` | Check-in + analisi + proposta (POST, token Bearer); con `chat:true` risponde anche in stile chat |
| `coachRefreshPlan` | Rigenera piano senza check-in (dopo un import) |
| `coachApplyProposal` | Applica SOLO le date selezionate dall'atleta |
| `coachDiscardProposal` | Scarta la proposta (resta in memoria con feedback) |
| `coachLatestProposal` | Ultima proposta pendente di oggi |
| `coachHistory` | Storico completo di check-in e decisioni |

Tutte in `europe-west1`, CORS aperto, `invoker: public`, autenticazione via Bearer token
Firebase (`verifyIdToken`). Nessuna chiave nel frontend.

### Configurazione Gemini

- **Secret Firebase**: `firebase functions:secrets:set GEMINI_API_KEY` (mai in Git)
- Anche in `functions/.env` per il deploy (`GEMINI_API_KEY=...`)
- Modello override: `GEMINI_MODEL` / `GEMINI_FALLBACK_MODEL` in `.env`
- Tier gratuito: sufficiente per un atleta; su 503 il backend riprova 2 volte con
  backoff e poi passa al modello di fallback

### Collezioni Firestore nuove (sotto `users/{uid}/`)

- `coachCheckins/{YYYY-MM-DD}` — testo del check-in + esito + readiness
- `coachProposals/{autoId}` — proposta completa, `status: pending/applied/discarded`

Sonno coperte dalle regole esistenti (`users/{uid}/{document=**}`).

### Formato allenamenti del coach

Le sedute create dal coach in `futureWorkouts` sono **strutturate**: `date` ISO,
`type` (easy/long/interval/tempo/recovery/rest/race/cross/test), `title`, `purpose`,
`warmup`, `main`, `cooldown`, `distanceKm`, `targetPace`, `targetHr`, `source: 'coach'`.
Le righe manuali e i DOC importati restano invariati (campo `day` testuale).
`coachApplyProposal` **aggiorna** la seduta esistente dello stesso giorno invece di
duplicarla, e preserva `sortOrder`/`importedAt`.

### Punti delicati

- `loadHistory` usa `.where('date', '>=', since)`: richiede l'indice automatico su
  `date`; se Firestore lo chiede, crearlo dal link nel log.
- Il parse della risposta Gemini tollera blocchi ` ```json ` e oggetti annidati;
  `maxOutputTokens: 16384` perché le proposte lunghe troncate producevano BAD_JSON.
- Il frontend (`ai-coach.js`) ha timeout 90s + 1 retry con `AbortController`.
- La sezione Coach nell'ordine dashboard dipende da `order` in `app.js`
  (`orderDashboardSections`) **e** dalla posizione fisica in `index.html`:
  aggiornarle entrambe se si riordina.

## Importazione attivita': Intervals.icu (non piu' Strava)

L'importazione **NON usa piu' Strava**. Strava ha riservato l'accesso alle API ai soli
abbonati: ogni chiamata a `/athlete/activities` rispondeva **403** anche con token valido e
scope corretto, quindi l'importazione non era piu' utilizzabile senza abbonamento.

Ora le attivita' arrivano da **Intervals.icu**, che riceve automaticamente i dati da
**Suunto** (e da altre piattaforme) e offre un'API con **chiave personale**, senza
abbonamento e senza approvazione.

```
Suunto Run -> app Suunto -> Intervals.icu -> questa app (API key)
```

### Configurazione (menu profilo / ingranaggio)

1. **API key** personale di Intervals.icu (Settings -> Developer Settings)
2. **Athlete ID** (nell'URL di intervals.icu, es. `i716162`)

Il backend `intervalsConnect` **verifica** le credenziali prima di salvarle in
`users/{uid}/integrations/intervals`.

### Cosa importa

`intervalsImport` scarica gli ultimi 90 giorni e importa le **10 attivita' piu' recenti**
(`INTERVALS_MAX_ACTIVITIES`), con gli stessi campi di prima: `type`, `date`, `km`
(piu' `source: 'intervals'` e `intervalsId`).

**Nessun duplicato**: la deduplicazione usa tre chiavi (intervalsId, id documento
`intervals-{id}`, data+km). Premere "Importa" piu' volte aggiorna, non moltiplica.

### Funzioni Cloud Run

| Attive | Rimosse |
|---|---|
| `intervalsConnect` | `stravaStart` |
| `intervalsDisconnect` | `stravaCallback` |
| `intervalsImport` | `stravaImport` |

## Dove vivono le cose

Il frontend ha **due sistemi separati**:

- **Gare** — gestite in `app.js`
- **Allenamenti** — gestiti in `my-workouts.js` (funzione `importIntervals`)

Non confonderli: modificare l'uno non tocca l'altro.

## Manutenzione e backup

**Prima di modificare** `app.js`, `index.html`, `my-workouts.js` o `functions/workouts.js`,
crea un **backup**: il login vive in `app.js`/`index.html` ed e' fragile — un errore lo
rompe su desktop o su mobile.

**Backup di riferimento dello stato funzionante:**
`backup-PRE-COACH-V2-*.zip` (stato pre-Coach, 27/10/2026) e `BACKUP FAILSAFE APP FINALE.zip`
(più vecchio, 17/09). Crearne sempre uno nuovo con timestamp prima di modifiche grandi.

## Attenzione all'encoding

Salvare **sempre** i file in **UTF-8 senza BOM**. Salvataggi ripetuti con l'encoding
sbagliato hanno gia' corrotto gli accenti italiani in passato (es. `può` -> `puÃ...`,
`‹` -> `âŸ¨`). Verifica sempre dopo aver scritto un file.

### Incidente 27/10/2026 (risolto)

Una riparazione automatica della stringa corrotta `"non puÃ...Â² essere annullata"` in
`app.js` ha **divorato parte del codice adiacente** e il deploy successivo ha rotto il
login per tutti (`SyntaxError: missing ) after argument list` in `app.js?v=intervals-1`).

Lezioni:

- **Non deployare senza verifica visiva del login** dopo modifiche a `app.js`/`index.html`:
  il QA headless non esegue il login reale e non colpisce le rotture di sintassi se il
  modulo non viene eseguito (o se il controllo e' solo su `node --check` di moduli ali).
- `node --check` **non basta**: verifica che il modulo **venga caricato** dal browser
  (es. `--eval` su una variabile esportata o un'azione visibile).
- Correggere stringhe corrotte a mano, un replace per volta, controllando il contesto
  che circonda il replace PRIMA e DOPO.
- Ripristino di riferimento usato: `backup-PRE-COACH-V2-*.zip` (app.js integro).

## README non aggiornato

`README.md` parla ancora di **Strava** per l'importazione: e' superato, vedi la sezione
Intervals.icu sopra. Da riscrivere prima di una eventuale pubblicazione pubblica del repo.

## Login

Usa `signInWithPopup` (Firebase Auth).

- **Se il login non risponde su desktop**: controllare l'icona del **blocco popup** nella
  barra degli indirizzi del browser.
- **Non passare a `signInWithRedirect`** senza testare il mobile: da mobile **rompe** il
  login. E' stato provato e ha causato un blocco totale.
- I pulsanti del menu usano la **delega di eventi** su `document`
  (`ev.target.closest(...)`), **non** `element.onclick`: con `onclick` l'handler si perde
  se il menu viene ricreato.


### Fase 2 (28/10/2026) — check-in ibrido + generazione a blocchi settimanali

- **Check-in = anche chat**: l'invio di "come ti senti oggi?" ora passa `chat:true`;
  il backend genera oltre alla proposta anche una `chatReply` conversazionale che
  finisce nella log della chat (`chatBubble`). Un solo invio = registrazione memoria + dialogo.
- **Generazione piano a blocchi settimanali**: il mesociclo (28 giorni, S1→S4)
  viene generato in **4 blocchi da 7 giorni** (`generateWeeklyBlocks`), uno per
  settimana; ogni blocco riceve il riepilogo delle settimane già generate per
  continuità di volume/tipologie. Motivo: risposte lunghe degradavano (schede
  mute a metà piano, JSON troncato). Costo: 4 richieste Gemini per piano.
- Vincoli giorni/lungo applicati DUE volte: calendario esplicito nel prompt
  (`puoi_allenarti` per ogni data) e enforcement nel codice dopo ogni risposta.
