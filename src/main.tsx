import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import './index.css';
import App from './App';
import { initInstallCapture } from './lib/install';
import { db, describeOpenError } from './db/db';

initInstallCapture();

const root = ReactDOM.createRoot(document.getElementById('root')!);

// Abre o banco (e aplica migrações pendentes) antes de montar o app. Se falhar,
// mostra o motivo em vez de uma tela vazia; nada é apagado ou recriado.
db.open().then(
  () =>
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    ),
  (e) => {
    console.error(e);
    root.render(
      <div role="alert" style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 520, margin: '0 auto' }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>IronTrack não conseguiu abrir seus dados</h1>
        <p style={{ marginTop: 12 }}>{describeOpenError(e)}</p>
        <p style={{ marginTop: 12, opacity: 0.7 }}>Não limpe os dados do site: isso apagaria seus registros.</p>
      </div>,
    );
  },
);
