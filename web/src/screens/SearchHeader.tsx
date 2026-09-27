import type { Route } from '../lib/types';
import { href } from '../lib/router';
import { fmtDate } from '../lib/time';

/** Cabeçalho das telas de resultado: resumo da busca + abas Combinações / Monte você mesmo. */
export function SearchHeader({ route, params, tab }: { route: Route; params: URLSearchParams; tab: 'r' | 'm' }) {
  const p = Object.fromEntries(params.entries());
  const after = params.get('after'), until = params.get('until');
  return (
    <header className="search-header">
      <div className="row">
        <div>
          <strong>{route.origin.name} → {route.dest.name}</strong>
          <div className="muted">
            {fmtDate(params.get('date') ?? '')}
            {after && ` · sair depois de ${after}`}
            {until && ` · chegar até ${until}`}
          </div>
        </div>
        <span className="header-links">
          <a className="link" href={href('/alertas', { o: p.o, d: p.d, date: p.date, after: p.after, until: p.until })}>Monitorar</a>
          <a className="link" href={href('/', p)}>Alterar</a>
        </span>
      </div>
      <nav className="tabs">
        <a href={href('/r', p)} aria-current={tab === 'r' ? 'page' : undefined}>Combinações</a>
        <a href={href('/m', p)} aria-current={tab === 'm' ? 'page' : undefined}>Monte você mesmo</a>
      </nav>
    </header>
  );
}
