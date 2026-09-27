import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../lib/api';
import type { CollectorStatus, Connection, CoverageLeg, Route, SortKey } from '../lib/types';
import { applyTimeFilters, oldestDataAsOf } from '../lib/connections';
import { navigate } from '../lib/router';
import { addDays } from '../lib/time';
import { ConnectionCard } from '../components/ConnectionCard';
import { DataAge } from '../components/DataAge';
import { EmptyState } from '../components/EmptyState';
import { QuarantineBanner } from '../components/QuarantineBanner';
import { RefreshPanel } from '../components/RefreshPanel';
import { SearchHeader } from './SearchHeader';

const SORTS: Array<[SortKey, string]> = [['arrival', 'Chegada'], ['price', 'Preço'], ['duration', 'Duração']];

interface Data { list: Connection[]; coverage: CoverageLeg[]; status: CollectorStatus | null }

export function Results({ route, params }: { route: Route; params: URLSearchParams }) {
  const api = useApi();
  const date = params.get('date')!;
  const after = params.get('after') ?? undefined, until = params.get('until') ?? undefined;
  const sort = (params.get('sort') as SortKey | null) ?? 'arrival';
  const origin = route.origin.id, dest = route.dest.id;

  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setErr(null);
    Promise.all([
      api.findConnections({ origin, dest, date, sort }),
      api.dateCoverage({ origin, dest, date }),
      api.collectorStatus().catch(() => null), // status é acessório: não derruba a busca
    ]).then(([list, coverage, status]) => alive && setData({ list, coverage, status }))
      .catch((e) => alive && setErr((e as Error).message));
    return () => { alive = false; };
  }, [api, origin, dest, date, sort, reload]);

  const onFinished = useCallback(() => setReload((n) => n + 1), []);
  const set = (changes: Record<string, string | undefined>) =>
    navigate('/r', { ...Object.fromEntries(params.entries()), ...changes }, true);

  const shown = data ? applyTimeFilters(data.list, date, after, until) : [];
  const quarantine = data?.status?.quarantine ?? null;

  return (
    <main className="screen">
      <SearchHeader route={route} params={params} tab="r" />
      <QuarantineBanner q={quarantine} />
      {err && <p className="error">Erro ao buscar: {err}</p>}
      {!data && !err && <p className="muted">Carregando…</p>}

      {data && shown.length > 0 && (
        <>
          <label className="sort">
            Ordenar por
            <select value={sort} onChange={(e) => set({ sort: e.target.value })}>
              {SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </label>
          <div className="list">
            {shown.map((c) => <ConnectionCard key={`${c.leg1_trip_id}-${c.leg2_trip_id ?? 0}`} c={c} date={date} />)}
          </div>
          <DataAge asOf={oldestDataAsOf(shown)} />
          <RefreshPanel origin={origin} dest={dest} date={date} onFinished={onFinished} />
        </>
      )}

      {data && shown.length === 0 && (
        <EmptyState coverage={data.coverage} total={data.list.length} origin={origin} dest={dest} date={date}
          onFinished={onFinished}
          onNextDay={() => set({ date: addDays(date, 1) })}
          onClearFilters={() => set({ after: undefined, until: undefined })} />
      )}
    </main>
  );
}
