import { describe, expect, it } from 'vitest';
import { isSearchUrl, qpSearchUrl, redactTokens, redactUrl, summarizeSearchBody } from '../src/sources/queropassagem.js';

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

  it('oculta JWT embrulhado em base64 (URL de /search-connections/ e campo "tag")', () => {
    const payload = Buffer.from(JSON.stringify({ from: '73', to: '1720', gds: 1 })).toString('base64url');
    const wrapped = Buffer.from(`eyJhbGciOiJIUzI1NiJ9.${payload}.QXNtV29kbzM4Z3ZsdS1uM21vblFM`).toString('base64');
    const r = redactUrl(`https://queropassagem.com.br/search-connections/${wrapped}/18`);
    expect(r.url).toBe('https://queropassagem.com.br/search-connections/<jwt>/18');
    expect(r.claims).toEqual([{ from: '73', to: '1720', gds: 1 }]);

    const item = { id: '1721e81f9d2e61313d1895b430e8cce7', tag: wrapped, company: { name: 'Cidade Sol' } };
    expect(redactTokens(item)).toEqual({ id: '1721e81f9d2e61313d1895b430e8cce7', tag: '<jwt>', company: { name: 'Cidade Sol' } });
  });

  it('não mexe em base64 que não é token (ex.: ids em hex, textos)', () => {
    expect(redactUrl('https://assets.queropassagem.com.br/public/Upload/autoviacao/viacao-cidade-sol.svg').url)
      .toBe('https://assets.queropassagem.com.br/public/Upload/autoviacao/viacao-cidade-sol.svg');
    expect(redactTokens({ id: '77a600ed33033f35807ac1b33c74bded77a600ed' })).toEqual({ id: '77a600ed33033f35807ac1b33c74bded77a600ed' });
  });

  it('resume respostas de busca', () => {
    expect(summarizeSearchBody({ source: 'x', itens: [{}, {}] })).toEqual({ items: 2, source: 'x' });
    expect(summarizeSearchBody([{}, {}, {}])).toEqual({ items: 3, source: null });
    expect(summarizeSearchBody('texto')).toEqual({ items: null, source: null });
  });
});
