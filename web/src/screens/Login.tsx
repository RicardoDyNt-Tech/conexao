import { useState, type FormEvent } from 'react';
import { useApi } from '../lib/api';

/** Mensagens do Supabase Auth em português. */
export function loginError(msg: string): string {
  // Cadastro desligado: e-mail sem convite volta "Signups not allowed for otp".
  if (/signup|not allowed|not found/i.test(msg)) return 'Esse e-mail não tem acesso ao app.';
  // SMTP padrão do Supabase só envia para membros da equipe do projeto (ver web/README.md).
  if (/not authorized/i.test(msg)) return 'O Supabase recusou enviar para esse e-mail (precisa ser da equipe do projeto ou ter SMTP próprio).';
  if (/rate limit/i.test(msg)) return 'Muitos e-mails em pouco tempo. Tente de novo daqui a uma hora.';
  return msg;
}

export function Login() {
  const api = useApi();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setState('sending'); setErr(null);
    try {
      await api.sendMagicLink(email.trim());
      setState('sent');
    } catch (e2) {
      const msg = (e2 as Error).message;
      setErr(loginError(msg));
      setState('idle');
    }
  }

  return (
    <main className="screen login">
      <h1>Conexão</h1>
      <p className="muted">Ônibus com conexão, só para quem foi convidado.</p>
      {state === 'sent' ? (
        <div className="banner ok" role="status">
          Link enviado para <strong>{email}</strong>. Abra o e-mail <strong>neste celular</strong> e toque no link
          para entrar. Pode levar um minuto; confira o spam.
        </div>
      ) : (
        <form onSubmit={submit} className="stack">
          <label>
            E-mail
            <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <button className="button" disabled={state === 'sending'}>
            {state === 'sending' ? 'Enviando…' : 'Receber link de acesso'}
          </button>
          <p className="hint">Você recebe um link por e-mail; não tem senha.</p>
          {err && <p className="error">{err}</p>}
        </form>
      )}
    </main>
  );
}
