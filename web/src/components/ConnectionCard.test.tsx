import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectionCard } from './ConnectionCard';
import { conn, offer } from '../test/fakeApi';

const D = '2026-10-10';

describe('ConnectionCard', () => {
  it('mostra saída → chegada em horário da Bahia, via, espera e total', () => {
    render(<ConnectionCard date={D} c={conn({ date: D, dep: '14:30', arr1: '16:00', dep2: '17:05', arr: '18:10', via: 'Alagoinhas' })} />);
    expect(screen.getByText(/14:30 → 18:10/)).toBeInTheDocument();
    expect(screen.getByText(/3h40 · via Alagoinhas · espera 1h05/)).toBeInTheDocument();
    expect(screen.getByText('R$ 57,43')).toBeInTheDocument();
    expect(screen.getByText('Conexão apertada')).toBeInTheDocument(); // 65 min
  });

  it('sem badge com espera de 90 min ou mais; marca chegada no dia seguinte', () => {
    render(<ConnectionCard date={D} c={conn({ date: D, dep: '20:00', arr1: '21:30', dep2: '23:00', arr: '00:20', arrDate: '2026-10-11' })} />);
    expect(screen.queryByText('Conexão apertada')).not.toBeInTheDocument();
    expect(screen.getByText(/\+1/)).toBeInTheDocument();
  });

  it('avisa troca de rodoviária', () => {
    render(<ConnectionCard date={D} c={conn({ date: D, dep: '06:00', arr1: '07:30', dep2: '10:00', arr: '11:00', same_station: false })} />);
    expect(screen.getByText('Troca de rodoviária')).toBeInTheDocument();
  });

  it('expandido: os dois trechos, cada um com "Comprar" em nova aba', async () => {
    const c = conn({ date: D, dep: '06:00', arr1: '07:30', dep2: '10:00', arr: '11:00' });
    render(<ConnectionCard date={D} c={c} />);
    await userEvent.click(screen.getByRole('button', { expanded: false }));
    const l1 = screen.getByRole('link', { name: 'Comprar 1º trecho' });
    const l2 = screen.getByRole('link', { name: 'Comprar 2º trecho' });
    expect(l1).toHaveAttribute('href', c.leg1_buy_url);
    expect(l2).toHaveAttribute('href', c.leg2_buy_url);
    expect(l1).toHaveAttribute('target', '_blank');
    expect(l1.getAttribute('rel')).toContain('noopener');
    expect(screen.getByText(/Rota · Executivo · 30 lugares/)).toBeInTheDocument();
  });

  it('mesmo ônibus nas duas fontes: os 2 preços, cada um com o seu "Comprar"', async () => {
    const c = conn({ date: D, dep: '06:00', arr1: '07:30', dep2: '09:00', arr: '10:00',
      leg2Offers: [offer('clickbus', 28.99), offer('queropassagem', 32.29, 9.68)] });
    render(<ConnectionCard date={D} c={c} />);
    await userEvent.click(screen.getByRole('button', { expanded: false }));
    const cb = screen.getByRole('link', { name: 'Comprar 2º trecho no ClickBus' });
    const qp = screen.getByRole('link', { name: 'Comprar 2º trecho no Quero Passagem' });
    expect(cb).toHaveAttribute('href', 'https://clickbus.example/comprar/28.99');
    expect(qp).toHaveAttribute('href', 'https://queropassagem.example/comprar/32.29');
    expect(qp).toHaveAttribute('target', '_blank');
    expect(screen.getByText('R$ 32,29')).toBeInTheDocument();
    expect(screen.getByText(/\+ R\$ 9,68 de taxa/)).toBeInTheDocument();
    // 1º trecho com uma fonte só: o botão de sempre
    expect(screen.getByRole('link', { name: 'Comprar 1º trecho' })).toBeInTheDocument();
  });

  it('trecho só no Quero Passagem: badge da fonte e taxa', async () => {
    const c = conn({ date: D, dep: '06:00', arr1: '07:30', dep2: '09:00', arr: '10:00',
      leg1Source: 'queropassagem', leg1Offers: [offer('queropassagem', 40, 12)] });
    render(<ConnectionCard date={D} c={c} />);
    await userEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('Quero Passagem')).toHaveClass('badge');
    expect(screen.getByText(/\+ R\$ 12,00 de taxa/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Comprar 1º trecho' })).toHaveAttribute('href', 'https://queropassagem.example/comprar/40');
  });
});
