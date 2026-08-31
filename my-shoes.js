import { getApps,getApp,initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth,onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore,collection,getDocs,setDoc,deleteDoc,doc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const app=getApps().length?getApp():initializeApp(firebaseConfig);
const auth=getAuth(app),db=getFirestore(app);
const shelfId='runmap-shoe-shelf';
let owner=null,items=[];
const el=id=>document.getElementById(id);
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number=value=>Number(value||0).toLocaleString('it-IT',{maximumFractionDigits:0});

function paint(){
  const list=el('shoeShelfList');if(!list)return;
  list.innerHTML=items.length?items.map(item=>{const limit=Math.max(1,Number(item.distanceLimit)||800),covered=Math.max(0,Number(item.distanceCovered)||0),ratio=Math.min(100,covered/limit*100),left=Math.max(0,limit-covered);return `<article class="shoe-entry"><div class="shoe-entry-top"><div><span class="shoe-status">${ratio>=100?'DA SOSTITUIRE':ratio>=80?'QUASI ESAURITA':'IN USO'}</span><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml([item.brand,item.model].filter(Boolean).join(' ')||'Scarpa da running')}</p></div><button class="shoe-remove" type="button" data-shoe-remove="${escapeHtml(item.id)}" aria-label="Elimina scarpa">×</button></div><div class="shoe-progress-label"><strong>${number(covered)} km</strong><span>di ${number(limit)} km</span></div><div class="shoe-progress" aria-label="${number(ratio)} percento del chilometraggio"><i style="width:${ratio}%"></i></div><div class="shoe-entry-bottom"><span>${number(left)} km rimanenti</span><button class="shoe-edit" type="button" data-shoe-edit="${escapeHtml(item.id)}">Modifica</button></div></article>`}).join(''):'<p class="shoe-empty">Nessuna scarpa aggiunta.</p>';
  document.querySelectorAll('[data-shoe-remove]').forEach(button=>button.onclick=()=>removeShoe(button.dataset.shoeRemove));
  document.querySelectorAll('[data-shoe-edit]').forEach(button=>button.onclick=()=>openEditor(items.find(item=>item.id===button.dataset.shoeEdit)));
}
async function refresh(){if(!owner)return;const snapshot=await getDocs(collection(db,'users',owner.uid,'shoeShelf'));items=snapshot.docs.map(entry=>entry.data());paint()}
function closeEditor(){el('shoeEditor')?.remove()}
function openEditor(item={}){
  const modal=document.createElement('div');modal.className='shoe-editor-backdrop';modal.id='shoeEditor';
  modal.innerHTML=`<section class="shoe-editor" role="dialog" aria-modal="true" aria-labelledby="shoeEditorTitle"><button class="shoe-editor-close" type="button" aria-label="Chiudi">×</button><p class="shoe-editor-kicker">${item.id?'MODIFICA SCARPA':'NUOVA SCARPA'}</p><h2 id="shoeEditorTitle">${item.id?'Dettagli scarpa':'Aggiungi scarpa'}</h2><form id="shoeEditorForm"><label>Nome scarpa<input name="name" required value="${escapeHtml(item.name)}" placeholder="es. Pegasus 41"></label><div class="shoe-form-grid"><label>Marca<input name="brand" value="${escapeHtml(item.brand)}" placeholder="es. Nike"></label><label>Modello<input name="model" value="${escapeHtml(item.model)}" placeholder="es. Air Zoom"></label></div><div class="shoe-form-grid"><label>Chilometri percorsi<input name="distanceCovered" type="number" min="0" step="1" required value="${Number(item.distanceCovered)||0}"></label><label>Durata prevista (km)<input name="distanceLimit" type="number" min="1" step="1" required value="${Number(item.distanceLimit)||800}"></label></div><button class="primary full" type="submit">${item.id?'Salva modifiche':'Aggiungi scarpa'}</button></form></section>`;
  document.body.append(modal);modal.querySelector('.shoe-editor-close').onclick=closeEditor;modal.onclick=event=>{if(event.target===modal)closeEditor()};
  modal.querySelector('form').onsubmit=async event=>{event.preventDefault();if(!owner)return;const form=new FormData(event.target),id=item.id||`shoe-${Date.now()}`;await setDoc(doc(db,'users',owner.uid,'shoeShelf',id),{id,name:String(form.get('name')).trim(),brand:String(form.get('brand')).trim(),model:String(form.get('model')).trim(),distanceCovered:Number(form.get('distanceCovered')),distanceLimit:Number(form.get('distanceLimit')),updatedAt:Date.now()});closeEditor();await refresh()};
}
async function removeShoe(id){if(!owner||!confirm('Eliminare questa scarpa?'))return;await deleteDoc(doc(db,'users',owner.uid,'shoeShelf',id));await refresh()}
function init(){el('addShoeButton').onclick=()=>openEditor();onAuthStateChanged(auth,user=>{owner=user;if(user)refresh();else{items=[];paint()}})}
init();
