import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { renderApp } from '../test/render';
import { CATU, FEIRA, bahia, fakeApi } from '../test/fakeApi';

describe('Buscar', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(bahia('2026-10-07', '10:00'))); });
  afterEach(() => vi.useRealTimers());

  it('sentidos vêm do banco; atalhos de data; buscar leva aos resultados', async () => {
    const api = fakeApi();
    renderApp(api, '#/');
    expect(await screen.findByRole('button', { name: 'Feira de Santana → Catu' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Catu → Feira de Santana' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sexta' }));
    expect(screen.getByText('sex, 09/10')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    await waitFor(() => expect(api.findConnections).toHaveBeenCalledWith(
      { origin: CATU.id, dest: FEIRA.id, date: '2026-10-09', sort: 'arrival' }));
  });

  it('num domingo, "Domingo" é o da semana que vem (não repete "Hoje")', async () => {
    vi.setSystemTime(new Date(bahia('2026-10-11', '10:00')));
    renderApp(fakeApi(), '#/');
    await userEvent.click(await screen.findByRole('button', { name: 'Domingo' }));
    expect(screen.getByText('dom, 18/10')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hoje' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('sem sessão: tela de login com magic link', async () => {
    const api = fakeApi({ getSession: vi.fn(async () => null) });
    renderApp(api, '#/');
    await userEvent.type(await screen.findByLabelText('E-mail'), 'carol@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Receber link de acesso' }));
    expect(api.sendMagicLink).toHaveBeenCalledWith('carol@example.com');
    expect(await screen.findByText(/Link enviado para/)).toBeInTheDocument();
  });
});

describe('mensagens de erro do login', () => {
  it('traduz os erros comuns do Supabase Auth', async () => {
    const { loginError } = await import('./Login');
    expect(loginError('Signups not allowed for otp')).toBe('Esse e-mail não tem acesso ao app.');
    expect(loginError('Email address not authorized')).toMatch(/equipe do projeto/);
    expect(loginError('email rate limit exceeded')).toMatch(/daqui a uma hora/);
  });
});
