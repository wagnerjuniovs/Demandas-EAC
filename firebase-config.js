// ======================================================================
// CONFIGURAÇÃO DO FIREBASE — projeto "dashboard-recorrencia"
// ----------------------------------------------------------------------
// Lembretes no console do Firebase:
//  1) Authentication > Sign-in method > Anônimo: ATIVO
//  2) Firestore Database: criado (região southamerica-east1)
//  3) Regras do Firestore: cole o conteúdo de firestore.rules
//  4) Depois de publicar no GitHub Pages, adicione o domínio
//     (ex: seu-usuario.github.io) em Authentication > Settings
//     > Authorized domains
// ======================================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js';

const firebaseConfig = {
  apiKey: "AIzaSyCAntRKLAt7kEJPOSde0Eglx7qcSMh4jkM",
  authDomain: "dashboard-recorrencia.firebaseapp.com",
  projectId: "dashboard-recorrencia",
  storageBucket: "dashboard-recorrencia.firebasestorage.app",
  messagingSenderId: "679030221269",
  appId: "1:679030221269:web:53e89b493a4c01324ff55c"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// Sign-in anônimo automático (necessário para as regras do Firestore)
export const ensureAuth = () => new Promise((resolve, reject) => {
  const unsub = onAuthStateChanged(auth, (user) => {
    if (user) { unsub(); resolve(user); }
    else { signInAnonymously(auth).catch(reject); }
  });
});
