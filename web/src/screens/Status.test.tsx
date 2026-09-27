import { screen, within } from '@testing-library/react';
import { vi } from 'vitest';
import { renderApp } from '../test/render';
import { EMPTY_STATUS, bahia, fakeApi } from '../test/fakeApi';

describe('Status', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(bahia('2026-10-10', '12:00'))); });
  afterEach(() => vi.useRealTimers());

  it('mostra cada fonte separada: última rodada e quarentena', async () => {
    const api = fakeApi({
      collectorStatus: vi.fn(async () => ({ ...EMPTY_STATUS, sources: [
        { source: 'clickbus', last_round: null, quarantine: {
          until: bahia('2026-10-10', '19:00'), since: bahia('2026-10-09', '19:00'), reason: 'HTTP 403',
          from_city: 'Salvador', to_city: 'Catu', travel_date: '2026-10-10' } },
        { source: 'queropassagem', quarantine: null, last_round: {
          started_at: bahia('2026-10-10', '07:02'), finished_at: bahia('2026-10-10', '07:25'), ok: 14, empty: 2, error: 0, blocked: 0 } },
      ] })),
    });
    renderApp(api, '#/status');
    const cb = (await screen.findByRole('heading', { name: 'ClickBus' })).closest('section')!;
    const qp = screen.getByRole('heading', { name: 'Quero Passagem' }).closest('section')!;
    expect(within(cb).getByText(/Pausada até 19:00/)).toBeInTheDocument();
    expect(within(cb).getByText(/nenhuma coleta registrada/)).toBeInTheDocument();
    expect(within(qp).getByText(/07:25 · 14 ok · 2 sem viagens/)).toBeInTheDocument();
    expect(within(qp).getByText(/não, liberada/)).toBeInTheDocument();
  });
});
