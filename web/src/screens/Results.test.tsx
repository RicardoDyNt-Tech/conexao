import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import type { CollectRequest } from '../lib/types';
import { renderApp } from '../test/render';
import { CATU, EMPTY_STATUS, FEIRA, bahia, conn, coverage, fakeApi } from '../test/fakeApi';

const D = '2026-10-10';
const NOW = new Date(bahia(D, '15:00'));
const hash = (extra = '') => `#/r?o=${FEIRA.id}&d=${CATU.id}&date=${D}${extra}`;
const COLLECTED = coverage(D, [
  [null, 'Feira de Santana', 'Catu', null],
  ['Alagoinhas', 'Feira de Santana', 'Alagoinhas', 'empty', 0],
  ['Alagoinhas', 'Alagoinhas', 'Catu', 'ok', 12],
  ['Salvador', 'Feira de Santana', 'Salvador', 'ok', 40],
  ['Salvador', 'Salvador', 'Catu', 'ok', 18],
]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('Resultados', () => {
  it('lista na ordem que o banco devolve; trocar a ordenação consulta de novo com p_order', async () => {
    const early = conn({ date: D, dep: '06:00', arr1: '07:30', dep2: '09:00', arr: '10:00', price: 70 });
    const cheap = conn({ date: D, dep: '14:30', arr1: '16:00', dep2: '17:30', arr: '18:10', price: 57.43, via: 'Alagoinhas' });
    const api = fakeApi({
      findConnections: vi.fn(async ({ sort }) => (sort === 'price' ? [cheap, early] : [early, cheap])),
      dateCoverage: vi.fn(async () => COLLECTED),
    });
    renderApp(api, hash());
    await screen.findByText(/06:00 → 10:00/);
    const times = () => screen.getAllByText(/→ \d\d:\d\d$/).map((e) => e.textContent);
    expect(times()).toEqual(['06:00 → 10:00', '14:30 → 18:10']);
    expect(api.findConnections).toHaveBeenLastCalledWith({ origin: FEIRA.id, dest: CATU.id, date: D, sort: 'arrival' });

    await userEvent.selectOptions(screen.getByLabelText('Ordenar por'), 'price');
    await waitFor(() => expect(times()).toEqual(['14:30 → 18:10', '06:00 → 10:00']));
    expect(api.findConnections).toHaveBeenLastCalledWith({ origin: FEIRA.id, dest: CATU.id, date: D, sort: 'price' });
  });

  it('rodapé "Dados de HH:MM" e aviso amarelo com mais de 12 h', async () => {
    const api = fakeApi({
      findConnections: vi.fn(async () => [conn({ date: D, dep: '06:00', arr1: '07:30', dep2: '09:00', arr: '10:00', asOf: bahia('2026-10-09', '19:00') })]),
      dateCoverage: vi.fn(async () => COLLECTED),
    });
    renderApp(api, hash());
    expect(await screen.findByText(/Dados de 09\/10 19:00/)).toBeInTheDocument();
    expect(screen.getByText(/mais de 12 h atrás/)).toBeInTheDocument();
  });

  it('dados recentes: sem aviso', async () => {
    const api = fakeApi({
      findConnections: vi.fn(async () => [conn({ date: D, dep: '06:00', arr1: '07:30', dep2: '09:00', arr: '10:00', asOf: bahia(D, '07:12') })]),
      dateCoverage: vi.fn(async () => COLLECTED),
    });
    renderApp(api, hash());
    expect(await screen.findByText('Dados de 07:12')).toBeInTheDocument();
    expect(screen.queryByText(/mais de 12 h/)).not.toBeInTheDocument();
  });

  describe('estado vazio (a): ainda não coletamos essa data', () => {
    const notCollected = coverage(D, [[null, 'Feira de Santana', 'Catu', null], ['Salvador', 'Feira de Santana', 'Salvador', null]]);

    it('botão "Buscar essa data" cria o pedido e mostra a fila', async () => {
      const api = fakeApi({ dateCoverage: vi.fn(async () => notCollected) });
      renderApp(api, hash());
      expect(await screen.findByText('Ainda não coletamos essa data')).toBeInTheDocument();
      expect(screen.getByText('Depende do PC do Ricardo estar ligado.')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Buscar essa data' }));
      expect(api.requestCollect).toHaveBeenCalledWith({ origin: FEIRA.id, dest: CATU.id, date: D });
      expect(await screen.findByText('Pedido na fila desde 15:00')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Buscar essa data' })).not.toBeInTheDocument();
    });

    it('pedido já pendente: "Pedido na fila desde HH:MM", sem botão', async () => {
      const pending: CollectRequest = { id: 3, origin_city_id: FEIRA.id, dest_city_id: CATU.id, travel_date: D,
        status: 'pending', created_at: bahia(D, '09:15'), done_at: null, error: null };
      const api = fakeApi({ dateCoverage: vi.fn(async () => notCollected), openRequest: vi.fn(async () => pending) });
      renderApp(api, hash());
      expect(await screen.findByText('Pedido na fila desde 09:15')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Buscar essa data' })).not.toBeInTheDocument();
    });

    it('quando o pedido termina (Realtime), recarrega os resultados', async () => {
      const pending: CollectRequest = { id: 3, origin_city_id: FEIRA.id, dest_city_id: CATU.id, travel_date: D,
        status: 'pending', created_at: bahia(D, '09:15'), done_at: null, error: null };
      let push: ((r: CollectRequest) => void) | null = null;
      const api = fakeApi({
        dateCoverage: vi.fn(async () => notCollected),
        openRequest: vi.fn(async () => pending),
        watchRequest: vi.fn((_id, cb) => { push = cb; return () => {}; }),
      });
      renderApp(api, hash());
      await screen.findByText('Pedido na fila desde 09:15');
      await waitFor(() => expect(push).not.toBeNull());
      act(() => push!({ ...pending, status: 'running' }));
      expect(await screen.findByText('Coletando agora…')).toBeInTheDocument();
      const calls = vi.mocked(api.findConnections).mock.calls.length;
      act(() => push!({ ...pending, status: 'done', done_at: bahia(D, '14:58') }));
      await waitFor(() => expect(vi.mocked(api.findConnections).mock.calls.length).toBe(calls + 1));
    });
  });

  describe('estado vazio (b): coletado, mas sem combinação', () => {
    it('explica por qual hub faltou ônibus e sugere o dia seguinte', async () => {
      const api = fakeApi({ dateCoverage: vi.fn(async () => COLLECTED) });
      renderApp(api, hash());
      expect(await screen.findByText('Sem combinações nessa data')).toBeInTheDocument();
      expect(screen.getByText('Via Alagoinhas: sem ônibus Feira de Santana → Alagoinhas nesse dia.')).toBeInTheDocument();
      expect(screen.queryByText('Ainda não coletamos essa data')).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Ver dom, 11/10' }));
      await waitFor(() => expect(api.findConnections).toHaveBeenLastCalledWith(expect.objectContaining({ date: '2026-10-11' })));
    });

    it('filtros que escondem tudo: oferece limpar', async () => {
      const api = fakeApi({
        findConnections: vi.fn(async () => [conn({ date: D, dep: '06:00', arr1: '07:30', dep2: '09:00', arr: '10:00' })]),
        dateCoverage: vi.fn(async () => COLLECTED),
      });
      renderApp(api, hash('&after=12:00'));
      expect(await screen.findByText('Nenhuma combinação nesse horário')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
      expect(await screen.findByText(/06:00 → 10:00/)).toBeInTheDocument();
    });
  });

  describe('quarentena', () => {
    const quarantined = { ...EMPTY_STATUS, quarantine: {
      until: bahia(D, '19:00'), since: bahia('2026-10-09', '19:00'), reason: 'HTTP 403',
      from_city: 'Salvador', to_city: 'Catu', travel_date: D } };

    it('banner "Coletor pausado até HH:MM" e o pedido continua possível', async () => {
      const api = fakeApi({
        findConnections: vi.fn(async () => [conn({ date: D, dep: '06:00', arr1: '07:30', dep2: '09:00', arr: '10:00' })]),
        dateCoverage: vi.fn(async () => COLLECTED),
        collectorStatus: vi.fn(async () => quarantined),
      });
      renderApp(api, hash());
      expect(await screen.findByRole('status')).toHaveTextContent(
        'Coletor pausado até 19:00 (o site bloqueou temporariamente). O pedido fica na fila mesmo assim.');
      await userEvent.click(screen.getByRole('button', { name: 'Atualizar agora' }));
      expect(api.requestCollect).toHaveBeenCalled();
      expect(await screen.findByText('Pedido na fila desde 15:00')).toBeInTheDocument();
    });

    it('sem quarentena: sem banner', async () => {
      const api = fakeApi({
        findConnections: vi.fn(async () => [conn({ date: D, dep: '06:00', arr1: '07:30', dep2: '09:00', arr: '10:00' })]),
        dateCoverage: vi.fn(async () => COLLECTED),
      });
      renderApp(api, hash());
      await screen.findByText(/06:00 → 10:00/);
      expect(screen.queryByText(/Coletor pausado/)).not.toBeInTheDocument();
    });
  });
});
