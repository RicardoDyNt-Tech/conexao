import { describe, expect, it } from 'vitest';
import { isSearchUrl, qpSearchUrl, redactUrl, summarizeSearchBody } from '../src/sources/queropassagem.js';

describe('Quero Passagem: utilitários do spike', () => {
  it('monta a URL pública com a data em DD-MM-AAAA', () => {
    expect(qpSearchUrl('salvador-ba', 'catu', '2026-10-10'))
      .toBe('https://www.queropassagem.com.br/onibus/salvador-ba-para-catu?ida=10-10-2026');
  });

  it('reconhece as respostas de busca', () => {
    expect(isSearchUrl('https://www.queropassagem.com.br/search/aaa.bbb.ccc')).toBe(true);
    expect(isSearchUrl('https://www.queropassagem.com.br/search-connections/tok/18')).toBe(true);
    expect(isSearchUrl('https://www.queropassagem.com.br/onibus/a-para-b?ida=10-10-2026')).toBe(false);
    expect(isSearchUrl('lixo')).toBe(false);
  });

  it('oculta o JWT e guarda só as claims do payload', () => {
    const payload = Buffer.from(JSON.stringify({ gds: 7, from: 73, to: 1705, date: '2026-10-10' })).toString('base64url');
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${payload}.c2lnbmF0dXJlLWZha2UtMTIz`;
    const r = redactUrl(`https://www.queropassagem.com.br/search/${jwt}`);
    expect(r.url).toBe('https://www.queropassagem.com.br/search/<jwt>');
    expect(r.url).not.toContain('signature');
    expect(r.claims).toEqual([{ gds: 7, from: 73, to: 1705, date: '2026-10-10' }]);
  });

  it('resume respostas de busca', () => {
    expect(summarizeSearchBody({ source: 'x', itens: [{}, {}] })).toEqual({ items: 2, source: 'x' });
    expect(summarizeSearchBody([{}, {}, {}])).toEqual({ items: 3, source: null });
    expect(summarizeSearchBody('texto')).toEqual({ items: null, source: null });
  });
});
