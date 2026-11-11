import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import './index.css';
import App from './App';
import { initInstallCapture } from './lib/install';
import { installStaleChunkGuard, reloadOnceForStaleChunk } from './lib/staleChunks';
import { db, describeOpenError } from './db/db';
import { chooseBootMode, startAccountRuntime } from './cloud/runtime';
import { IS_STAGING } from './cloud/config';

initInstallCapture();
if (IS_STAGING) document.title = `[Homologação] ${document.title}`;
installStaleChunkGuard();

const root = ReactDOM.createRoot(document.getElementById('root')!);

// P21: com contas ligadas (VITE_ACCOUNTS=on), decide antes de abrir qualquer banco: tela de entrada, modo sem conta
// (banco `irontrack`, como sempre) ou o banco da conta. Sem contas ligadas, nada muda.
const mode = chooseBootMode();

if (mode.kind === 'auth') {
  import('./cloud/ui/AuthApp').then(
    ({ default: AuthApp }) =>
      root.render(
        <React.StrictMode>
          <AuthApp />
        </React.StrictMode>,
      ),
    // Fase 07: sem isto, uma falha ao baixar a tela de entrada (versão antiga em cache, sem conexão) deixava a tela branca.
    (e) => {
      console.error(e);
      if (navigator.onLine !== false && reloadOnceForStaleChunk()) return;
      root.render(
        <div role="alert" style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 520, margin: '0 auto' }}>
          <h1 style={{ fontSize: 20, fontWeight: 700 }}>Não foi possível abrir a tela de entrada</h1>
          <p style={{ marginTop: 12 }}>Confira a conexão com a internet e recarregue a página. Nenhum dado deste aparelho foi alterado.</p>
          <button type="button" style={{ marginTop: 16, padding: '10px 16px', borderRadius: 12 }} onClick={() => window.location.reload()}>
            Recarregar
          </button>
        </div>,
      );
    },
  );
} else {
  // Abre o banco (e aplica migrações pendentes) antes de montar o app. Se falhar,
  // mostra o motivo em vez de uma tela vazia; nada é apagado ou recriado.
  db.open()
    .then(async () => {
      if (mode.kind === 'account') await startAccountRuntime(mode);
    })
    .then(
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
}
