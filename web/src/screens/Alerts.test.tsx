import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import type { WatchStatus } from '../lib/types';
import { renderApp } from '../test/render';
import { CATU, FEIRA, bahia, fakeApi } from '../test/fakeApi';

const w = (o: Partial<WatchStatus> = {}): WatchStatus => ({
  id: 1, origin_city_id: FEIRA.id, origin_city: 'Feira de Santana', dest_city_id: CATU.id, dest_city: 'Catu',
  travel_date: '2026-10-10', max_price: 60, min_seats_alert: 5, telegram_chat_id: null, last_alerted_at: null,
  depart_after: null, arrive_by: null,
  best_price: 57.43, best_service_fee: 17.22, best_departure_at: bahia('2026-10-10', '14:30'),
  best_arrival_at: bahia('2026-10-10', '18:10'), best_via: 'Alagoinhas', best_min_seats: 3,
  data_as_of: bahia('2026-10-07', '07:12'), ...o,
});

describe('Alertas', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(bahia('2026-10-07', '10:00'))); });
  afterEach(() => vi.useRealTimers());

  it('lista os alertas com a melhor opção de agora e os destaques', async () => {
    const api = fakeApi({ watchStatus: vi.fn(async () => [w(), w({ id: 2, travel_date: '2026-10-12', best_price: null,
      best_departure_at: null, best_arrival_at: null, best_min_seats: null, max_price: null, data_as_of: null })]) });
    renderApp(api, '#/alertas');
    const cards = await screen.findAllByRole('article');
    const first = within(cards[0]!);
    expect(first.getByText('Alvo: R$ 60,00 · avisa com 5 lugares ou menos')).toBeInTheDocument();
    expect(first.getByText(/14:30 → 18:10 via Alagoinhas/)).toBeInTheDocument();
    expect(first.getByText('R$ 57,43')).toBeInTheDocument();
    expect(first.getByText('Abaixo do alvo')).toBeInTheDocument();
    expect(first.getByText('Poucos lugares (3)')).toBeInTheDocument();
    expect(first.getByRole('link', { name: 'Ver combinações' }))
      .toHaveAttribute('href', `#/r?o=${FEIRA.id}&d=${CATU.id}&date=2026-10-10&sort=price`);
    const second = within(cards[1]!);
    expect(second.getByText('Sem preço-alvo · avisa com 5 lugares ou menos')).toBeInTheDocument();
    expect(second.getByText('Ainda sem combinações coletadas para essa data.')).toBeInTheDocument();
  });

  it('vindo dos resultados, já preenche sentido e data; cria o alerta', async () => {
    const api = fakeApi();
    renderApp(api, `#/alertas?o=${CATU.id}&d=${FEIRA.id}&date=2026-10-12`);
    expect(await screen.findByRole('button', { name: 'Catu → Feira de Santana' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByDisplayValue('2026-10-12')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Avisar se ficar até (R$)'), '90');
    await userEvent.click(screen.getByRole('button', { name: 'Monitorar' }));
    expect(api.addWatch).toHaveBeenCalledWith({ origin: CATU.id, dest: FEIRA.id, date: '2026-10-12',
      maxPrice: 90, minSeats: 5, telegramChatId: null, departAfter: null, arriveBy: null });
    await waitFor(() => expect(api.watchStatus).toHaveBeenCalledTimes(2)); // recarrega a lista
  });

  it('janela de horário: vem preenchida dos filtros da busca, é enviada e aparece no card', async () => {
    const api = fakeApi({ watchStatus: vi.fn(async () => [w({ depart_after: '10:00:00', arrive_by: '20:00:00' })]) });
    renderApp(api, `#/alertas?o=${FEIRA.id}&d=${CATU.id}&date=2026-10-10&after=10:00&until=20:00`);
    expect(await screen.findByLabelText('Sair depois de (opcional)')).toHaveValue('10:00');
    expect(screen.getByLabelText('Chegar até (opcional)')).toHaveValue('20:00');
    expect(await screen.findByText('Sair depois de 10:00 · chegar até 20:00')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Monitorar' }));
    expect(api.addWatch).toHaveBeenCalledWith(expect.objectContaining({ departAfter: '10:00', arriveBy: '20:00' }));
  });

  it('janela invertida não é enviada', async () => {
    const api = fakeApi();
    renderApp(api, `#/alertas?after=20:00&until=10:00`);
    await userEvent.click(await screen.findByRole('button', { name: 'Monitorar' }));
    expect(await screen.findByText('"Sair depois de" precisa ser antes de "Chegar até".')).toBeInTheDocument();
    expect(api.addWatch).not.toHaveBeenCalled();
  });

  it('alerta repetido: mensagem clara', async () => {
    const api = fakeApi({ addWatch: vi.fn(async () => { throw new Error('duplicate'); }) });
    renderApp(api, '#/alertas');
    await userEvent.click(await screen.findByRole('button', { name: 'Monitorar' }));
    expect(await screen.findByText('Você já monitora esse sentido nessa data.')).toBeInTheDocument();
  });

  it('parar de monitorar', async () => {
    const api = fakeApi({ watchStatus: vi.fn(async () => [w()]) });
    renderApp(api, '#/alertas');
    await userEvent.click(await screen.findByRole('button', { name: 'Parar de monitorar' }));
    expect(api.removeWatch).toHaveBeenCalledWith(1);
  });

  it('link "Monitorar" nos resultados leva para cá com a busca e os horários', async () => {
    const api = fakeApi();
    renderApp(api, `#/r?o=${FEIRA.id}&d=${CATU.id}&date=2026-10-10&after=10:00`);
    expect(await screen.findByRole('link', { name: 'Monitorar' }))
      .toHaveAttribute('href', `#/alertas?o=${FEIRA.id}&d=${CATU.id}&date=2026-10-10&after=10%3A00`);
  });
});
