import { render } from '@testing-library/react';
import { ApiContext, type Api } from '../lib/api';
import { App } from '../App';

/** Renderiza o app inteiro numa rota (hash), com a API falsa. */
export function renderApp(api: Api, hash: string) {
  window.location.hash = hash;
  return render(<ApiContext.Provider value={api}><App /></ApiContext.Provider>);
}
