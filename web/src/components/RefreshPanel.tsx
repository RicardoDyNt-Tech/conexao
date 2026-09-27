import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../lib/api';
import type { CollectRequest } from '../lib/types';
import { fmtStamp } from '../lib/time';

const POLL_MS = 15_000; // rede de segurança se o Realtime cair

interface Props {
  origin: number; dest: number; date: string;
  /** Chamado quando um pedido termina (done/error): a tela recarrega os resultados. */
  onFinished: () => void;
  label?: string;
}

function statusText(r: CollectRequest): string {
  switch (r.status) {
    case 'pending': return `Pedido na fila desde ${fmtStamp(r.created_at)}`;
    case 'running': return 'Coletando agora…';
    case 'done': return `Atualizado às ${fmtStamp(r.done_at ?? r.created_at)}`;
    case 'error': return `A coleta falhou${r.error ? `: ${r.error}` : ''}`;
  }
}

/** "Atualizar agora": cria (ou reaproveita) o pedido e acompanha pending → running → done/error. */
/** A quarentena aparece no banner da tela (QuarantineBanner); o pedido é aceito mesmo assim. */
export function RefreshPanel({ origin, dest, date, onFinished, label = 'Atualizar agora' }: Props) {
  const api = useApi();
  const [req, setReq] = useState<CollectRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  const lastStatus = useRef<CollectRequest['status'] | null>(null);

  // Guarda o pedido; se ele acabou de terminar, avisa a tela para recarregar.
  const update = useCallback((r: CollectRequest | null) => {
    const prev = lastStatus.current;
    lastStatus.current = r?.status ?? null;
    setReq(r);
    if (r && prev && prev !== r.status && (r.status === 'done' || r.status === 'error')) finished.current();
  }, []);

  // Pedido já em aberto para esta busca (de outra pessoa ou de antes).
  useEffect(() => {
    let alive = true;
    update(null);
    api.openRequest({ origin, dest, date }).then((r) => alive && update(r)).catch(() => {});
    return () => { alive = false; };
  }, [api, origin, dest, date, update]);

  const open = req && (req.status === 'pending' || req.status === 'running');

  // Acompanha o pedido em aberto: Realtime + polling.
  useEffect(() => {
    if (!open || !req) return;
    const stop = api.watchRequest(req.id, update);
    const t = setInterval(() => { api.getRequest(req.id).then((r) => r && update(r)).catch(() => {}); }, POLL_MS);
    return () => { stop(); clearInterval(t); };
  }, [api, open, req?.id, update]);

  async function ask() {
    setBusy(true); setErr(null);
    try { update(await api.requestCollect({ origin, dest, date })); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <section className="refresh" aria-live="polite">
      {!open && (
        <button className="button" onClick={ask} disabled={busy}>{busy ? 'Enviando…' : label}</button>
      )}
      {req && <p className={`request-status ${req.status}`}>{statusText(req)}</p>}
      {err && <p className="error">Não deu para pedir: {err}</p>}
      <p className="hint">Depende do PC do Ricardo estar ligado.</p>
    </section>
  );
}
