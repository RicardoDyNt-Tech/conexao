import { describe, expect, it } from 'vitest';
import { appLink, watchAlertMessage } from '../src/notify/alerts.js';
import { watchedQueries, type WatchAlert } from '../src/store.js';

const F = 2910800, A = 2900702, S = 2927408, C = 2907509;
const bahia = (d: string, t: string) => new Date(Date.parse(`${d}T${t}:00Z`) + 3 * 3600_000).toISOString();

const alert = (o: Partial<WatchAlert> = {}): WatchAlert => ({
  watch_id: 1, kind: 'price', telegram_chat_id: null, origin_city_id: F, origin_city: 'Feira de Santana',
  dest_city_id: C, dest_city: 'Catu', travel_date: '2026-10-10', max_price: '60.00', min_seats_alert: 5,
  total_price: '57.43', service_fee: '17.22', departure_at: bahia('2026-10-10', '14:30'), arrival_at: bahia('2026-10-10', '18:10'),
  via_city: 'Alagoinhas', min_seats: 3, seats_leg: 1, option_key: '10-20', data_as_of: bahia('2026-10-10', '07:12'), ...o,
});

describe('mensagens de alerta', () => {
  it('preço-alvo', () => {
    expect(watchAlertMessage(alert(), 'https://conexao.servorico.workers.dev/')).toBe([
      '🔔 Conexão: preço-alvo atingido',
      'Feira de Santana → Catu · sáb, 10/10',
      'R$ 57,43 (seu alvo: R$ 60,00)',
      '14:30 → 18:10 via Alagoinhas',
      '+ R$ 17,22 de taxa no pagamento (Quero Passagem)',
      'Dados de 10/10 07:12',
      'https://conexao.servorico.workers.dev/#/r?o=2910800&d=2907509&date=2026-10-10&sort=price',
    ].join('\n'));
  });

  it('assentos acabando, chegada no dia seguinte, sem taxa e sem link', () => {
    const msg = watchAlertMessage(alert({ kind: 'seats', service_fee: 0, min_seats: 2, seats_leg: 2,
      departure_at: bahia('2026-10-10', '20:00'), arrival_at: bahia('2026-10-11', '00:20'), via_city: 'Salvador' }));
    expect(msg).toBe([
      '⚠️ Conexão: poucos lugares',
      'Feira de Santana → Catu · sáb, 10/10',
      '20:00 → 00:20 (+1) via Salvador, R$ 57,43',
      'Só 2 lugares no 2º trecho.',
      'Dados de 10/10 07:12',
    ].join('\n'));
  });

  it('direta e 1 lugar', () => {
    const msg = watchAlertMessage(alert({ kind: 'seats', via_city: null, min_seats: 1, service_fee: null }));
    expect(msg).toContain('14:30 → 18:10 direto, R$ 57,43');
    expect(msg).toContain('Só 1 lugar.');
  });

  it('link só com APP_URL', () => {
    expect(appLink(alert())).toBeNull();
  });
});

describe('watchedQueries (datas monitoradas na coleta)', () => {
  const slugs = new Map([[F, 'feira'], [A, 'alagoinhas'], [S, 'salvador'], [C, 'catu']]);
  const hubs = [
    { origin_city_id: F, dest_city_id: C, hub_city_id: A }, { origin_city_id: F, dest_city_id: C, hub_city_id: S },
    { origin_city_id: C, dest_city_id: F, hub_city_id: A }, { origin_city_id: C, dest_city_id: F, hub_city_id: S },
  ];

  it('trechos do sentido monitorado, na data dele, sem repetir o que a janela já coleta', () => {
    const already = [{ from: 'feira', to: 'salvador', date: '2026-10-20' }];
    const q = watchedQueries([
      { origin_city_id: F, dest_city_id: C, travel_date: '2026-10-20' },
      { origin_city_id: F, dest_city_id: C, travel_date: '2026-10-20' }, // repetido (2 usuários)
    ], hubs, slugs, 'clickbus', already);
    expect(q.map((x) => `${x.from}>${x.to}@${x.date}`)).toEqual([
      'feira>catu@2026-10-20', 'feira>alagoinhas@2026-10-20', 'alagoinhas>catu@2026-10-20', 'salvador>catu@2026-10-20',
    ]);
  });

  it('várias datas em ordem', () => {
    const q = watchedQueries([
      { origin_city_id: C, dest_city_id: F, travel_date: '2026-10-25' },
      { origin_city_id: F, dest_city_id: C, travel_date: '2026-10-20' },
    ], hubs, slugs, 'clickbus');
    expect(q[0]!.date).toBe('2026-10-20');
    expect(q.at(-1)!.date).toBe('2026-10-25');
    expect(q).toHaveLength(10);
  });
});
