import type { CoverageLeg } from '../lib/types';
import { emptyKind, noCombinationReasons } from '../lib/connections';
import { addDays, fmtDate } from '../lib/time';
import { RefreshPanel } from './RefreshPanel';

interface Props {
  coverage: CoverageLeg[];
  total: number;              // combinações antes dos filtros de horário
  origin: number; dest: number; date: string;
  onFinished: () => void;
  onNextDay: () => void;
  onClearFilters: () => void;
}

export function EmptyState(p: Props) {
  const kind = emptyKind(p.coverage, p.total);

  if (kind === 'not_collected') {
    return (
      <section className="empty">
        <h2>Ainda não coletamos essa data</h2>
        <p>Nenhum trecho de {fmtDate(p.date)} foi buscado no site ainda.</p>
        <RefreshPanel origin={p.origin} dest={p.dest} date={p.date} onFinished={p.onFinished} label="Buscar essa data" />
      </section>
    );
  }

  if (kind === 'filtered') {
    return (
      <section className="empty">
        <h2>Nenhuma combinação nesse horário</h2>
        <p>Há {p.total} opção(ões) nesse dia fora dos filtros de horário.</p>
        <button className="button secondary" onClick={p.onClearFilters}>Limpar filtros</button>
      </section>
    );
  }

  return (
    <section className="empty">
      <h2>Sem combinações nessa data</h2>
      <ul className="reasons">
        {noCombinationReasons(p.coverage).map((r) => <li key={r}>{r}</li>)}
      </ul>
      <p className="muted">Alguns trechos só têm ônibus em certos dias da semana.</p>
      <button className="button secondary" onClick={p.onNextDay}>Ver {fmtDate(addDays(p.date, 1))}</button>
    </section>
  );
}
