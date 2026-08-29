# Run Map
Dashboard pubblicabile su GitHub Pages con Firebase per autenticazione, gare, note e foto.

## Configurazione obbligatoria
1. Crea un progetto su [Firebase Console](https://console.firebase.google.com/).
2. Abilita **Authentication > Google**, **Firestore Database** e **Storage**.
3. Copia la configurazione Web in `firebase-config.js`.
4. Pubblica `index.html`, `styles.css`, `app.js` e `firebase-config.js` su GitHub Pages.
5. Aggiungi il dominio GitHub Pages tra gli **Authorized domains** di Firebase Authentication.

L'app non usa `localStorage`: gare, note e URL delle foto vengono salvati in Firestore/Storage.

Il catalogo `cities.json` comprende comuni, frazioni e località italiane presenti nel dataset GeoNames. Per aggiornarlo, scarica `IT.zip` da [GeoNames](https://download.geonames.org/export/dump/IT.zip), estrailo nella cartella temporanea `geonames-it` e avvia `./build-cities.ps1`.

## Scraping
La Cloud Function `functions/index.js` espone `GET /importRaces` e va pubblicata con Firebase CLI. Il vecchio `server.cjs` resta utile solo per sviluppo locale; GitHub Pages esegue solo file statici. Dopo il deploy, l'URL configurato in `index.html` punta alla funzione cloud. Per pubblicare:

```powershell
firebase login
cd functions
npm install
cd ..
firebase deploy --only functions,firestore:rules,storage
```

Per un progetto già attivo, assicurati che il piano Firebase consenta l'uso delle Cloud Functions e che l'API di geocoding sia utilizzata rispettando i limiti di Nominatim.

Imposta nel frontend l'URL del backend con:

```html
<script>window.RUNMAP_API_URL = 'https://tuo-backend.example.com';</script>
```

prima di `app.js`. Il backend attuale è uno scheletro di importazione: prima della pubblicazione va completato il parser dei campi gara e va sostituito il controllo provvisorio dell'header Bearer con la verifica Firebase Admin SDK.

## Regole Firebase
Le regole di esempio sono in `firestore.rules` e `storage.rules`: ogni utente può leggere e modificare esclusivamente il proprio archivio.
