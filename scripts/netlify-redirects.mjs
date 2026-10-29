// Gera dist/_redirects para a Netlify (Prompt 21): `/api/*` vai, pela própria Netlify (mesma origem para o navegador),
// para a API na Railway. O endereço vem da variável API_PROXY_TARGET configurada no painel da Netlify — não fica no
// repositório nem no bundle do app. Sem a variável, o build falha (melhor do que publicar um app que não acha a API).
import { writeFileSync } from 'node:fs';

const raw = (process.env.API_PROXY_TARGET ?? '').trim();
let url;
try {
  url = new URL(raw);
} catch {
  console.error('API_PROXY_TARGET ausente ou inválida: configure no painel da Netlify o endereço HTTPS público da API na Railway (só a origem).');
  process.exit(1);
}
if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
  console.error('API_PROXY_TARGET deve ser só a origem HTTPS da API (ex.: o domínio público do serviço na Railway), sem caminho, parâmetros ou credenciais.');
  process.exit(1);
}
const origin = url.origin;
// 200 = proxy (reescrita), não redirecionamento: o navegador só fala com a Netlify; o cookie é da origem do app.
writeFileSync('dist/_redirects', `/api/*  ${origin}/api/:splat  200!\n`);
console.log('dist/_redirects gerado (proxy /api/* → API).');
