import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';
import { ApiContext, supabaseApi } from './lib/api';
import { App } from './App';
import './styles.css';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY; // anon/publishable: o acesso é decidido pelo RLS
const root = createRoot(document.getElementById('root')!);

if (!url || !key) {
  root.render(<p style={{ padding: 16 }}>Faltam VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY (web/.env.local).</p>);
} else {
  const api = supabaseApi(createClient(url, key));
  root.render(
    <StrictMode>
      <ApiContext.Provider value={api}>
        <App />
      </ApiContext.Provider>
    </StrictMode>,
  );
}

// Service worker só em produção: guarda o app shell, nunca os dados (ver public/sw.js).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js'); });
}
