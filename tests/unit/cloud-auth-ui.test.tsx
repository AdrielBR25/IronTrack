// Telas de conta (Prompt 21): validação acessível, indicador de senha, cadastro e entrada pela API (fetch falso),
// senha nunca guardada no navegador.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { LoginForm, SignupForm } from '@/cloud/ui/authForms';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  localStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const render = (el: React.ReactElement) => act(() => root.render(<MemoryRouter>{el}</MemoryRouter>));
const input = (label: string) => {
  const l = [...host.querySelectorAll('label')].find((x) => x.textContent?.trim() === label)!;
  return document.getElementById(l.htmlFor) as HTMLInputElement;
};
function type(el: HTMLInputElement, v: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const submit = async (name: string) => {
  await act(async () => {
    host.querySelector<HTMLFormElement>(`form[aria-label="${name}"]`)!.requestSubmit();
  });
};
const ACCOUNT = { id: '11111111-1111-4111-8111-111111111111', name: 'Ana', email: 'ana@exemplo.com', emailVerified: false, dataProfileId: '22222222-2222-4222-8222-222222222222', createdAt: '2026-10-29T00:00:00Z' };

describe('cadastro', () => {
  it('erros ligados aos campos, foco no primeiro erro e requisitos da senha em texto', async () => {
    render(<SignupForm onAuthenticated={() => undefined} />);
    await submit('Criar conta');
    const name = input('Nome');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(name.getAttribute('aria-describedby')!.split(' ')[0])!.textContent).toBe('Informe seu nome.');
    expect(document.activeElement).toBe(name);
    expect(host.textContent).toContain('Para criar a conta, aceite os termos');
    type(input('Senha'), 'curta');
    const reqs = host.querySelector('[aria-label="Requisitos da senha"]')!;
    expect(reqs.textContent).toContain('Pelo menos 10 caracteres (pendente)');
    expect(reqs.textContent).toContain('Pelo menos uma letra (atendido)');
  });

  it('envia nome, e-mail, senha e aceite; senha não fica em storage', async () => {
    const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init!.body)), headers: init!.headers as Record<string, string> });
      return new Response(JSON.stringify({ account: ACCOUNT, features: { email: true, ai: false, aiRequiresVerifiedEmail: true, signup: true }, verificationEmail: 'sent' }), { status: 201 });
    });
    const done = vi.fn();
    render(<SignupForm onAuthenticated={done} />);
    type(input('Nome'), 'Ana');
    type(input('E-mail'), 'ana@exemplo.com');
    type(input('Senha'), 'barra-olimpica-2026');
    type(input('Confirmar senha'), 'barra-olimpica-2026');
    act(() => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await submit('Criar conta');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/v1/auth/signup');
    expect(calls[0].body).toEqual({ name: 'Ana', email: 'ana@exemplo.com', password: 'barra-olimpica-2026', acceptTerms: true });
    expect(calls[0].headers['x-irontrack-csrf']).toBe('1');
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ account: ACCOUNT }));
    expect(JSON.stringify({ ...localStorage })).not.toContain('barra-olimpica');
  });
});

describe('entrar', () => {
  it('credenciais erradas: mensagem genérica (sem revelar se o e-mail existe)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 'invalid_credentials', message: 'x' } }), { status: 401 }));
    render(<LoginForm onAuthenticated={() => undefined} />);
    type(input('E-mail'), 'ana@exemplo.com');
    type(input('Senha'), 'qualquer-coisa-1');
    await submit('Entrar');
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('E-mail ou senha incorretos.');
  });

  it('servidor fora do ar: mensagem de conexão', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    render(<LoginForm onAuthenticated={() => undefined} />);
    type(input('E-mail'), 'ana@exemplo.com');
    type(input('Senha'), 'qualquer-coisa-1');
    await submit('Entrar');
    expect(host.querySelector('[role="alert"]')!.textContent).toMatch(/Sem conexão com o servidor/);
  });
});
