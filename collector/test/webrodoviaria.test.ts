import { describe, expect, it } from 'vitest';
import {
  addDays, brDate, matchesCity, normalizeName, postFieldNames, redactHtml, redactJsonKeys, redactPostData, redactWrUrl,
  typedQuery, viacao,
} from '../src/sources/webrodoviaria.js';

const VS = 'H4sIAAAAAAAAAKtWyk0tLk5MT1WyUlAqSc0rSVVISQ';

describe('Venda Web: utilitários do spike', () => {
  it('conhece as duas viações e recusa outra', () => {
    expect(viacao('rota').baseUrl).toBe('https://rotatransportes.webrodoviaria.com.br/VendaWebRotaTransportes/');
    expect(viacao('cidadesol').name).toBe('Cidade Sol');
    expect(() => viacao('clickbus')).toThrow(/desconhecida/);
  });

  it('compara nomes de cidade sem acento, caixa ou formato da UF', () => {
    expect(normalizeName('Feira de Santana-BA')).toBe('FEIRA DE SANTANA - BA');
    expect(matchesCity('SALVADOR - BA', 'SALVADOR - BA')).toBe(true);
    expect(matchesCity(' Catu/BA ', 'CATU - BA')).toBe(true);
    expect(matchesCity('CATU (BA)', 'CATU - BA')).toBe(true);
    expect(matchesCity('Feira de Santana - BA', 'FEIRA DE SANTANA - BA')).toBe(true);
    expect(matchesCity('SALVADOR - BA (TODOS)', 'SALVADOR - BA')).toBe(false);
    expect(matchesCity('SANTO AMARO - BA', 'SALVADOR - BA')).toBe(false);
    expect(typedQuery('FEIRA DE SANTANA - BA')).toBe('FEIRA DE SANTANA');
  });

  it('formata e soma datas de calendário', () => {
    expect(brDate('2026-10-10')).toBe('10/10/2026');
    expect(addDays('2026-10-10', 1)).toBe('2026-10-11');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  });

  it('oculta jsessionid e parâmetros sensíveis na URL', () => {
    expect(redactWrUrl('https://x.webrodoviaria.com.br/VendaWeb/consulta;jsessionid=ABC123DEF?origem=1&csrf=zz9'))
      .toBe('https://x.webrodoviaria.com.br/VendaWeb/consulta;jsessionid=<token>?origem=1&csrf=<token>');
  });

  it('oculta ViewState/CSRF no POST, mas mantém os nomes e os campos comuns', () => {
    const pd = `javax.faces.ViewState=${VS}&frm%3Aorigem=SALVADOR+-+BA&frm%3AdataIda=10%2F10%2F2026&_csrf=abcdef123`;
    const r = redactPostData(pd)!;
    expect(r).not.toContain(VS);
    expect(r).toContain('javax.faces.ViewState=<token>');
    expect(r).toContain('frm%3Aorigem=SALVADOR+-+BA');
    expect(r).toContain('_csrf=<token>');
    expect(postFieldNames(pd)).toEqual(['javax.faces.ViewState', 'frm:origem', 'frm:dataIda', '_csrf']);
    expect(redactPostData(JSON.stringify({ origem: 1, token: 'abc' }))).toBe('{"origem":1,"token":"<token>"}');
    expect(redactPostData(null)).toBeNull();
  });

  it('oculta ViewState em input, partial-response do JSF, meta CSRF e JS inline', () => {
    const html = `<input type="hidden" name="javax.faces.ViewState" id="j_id1:javax.faces.ViewState:0" value="${VS}" />
      <input name="frm:origem" value="SALVADOR - BA">
      <meta name="_csrf" content="c5f1a2b3">
      <a href="consulta;jsessionid=XYZ987">x</a>
      <a onclick="go('dia=11/10&amp;javax.faces.ViewState=${VS}')">11/10</a>
      <partial-response><changes><update id="j_id1:javax.faces.ViewState:0"><![CDATA[${VS}]]></update></changes></partial-response>`;
    const r = redactHtml(html);
    expect(r).not.toContain(VS);
    expect(r).not.toContain('c5f1a2b3');
    expect(r).not.toContain('XYZ987');
    expect(r).toContain('value="SALVADOR - BA"');
    expect(r).toContain('11/10');
  });

  it('oculta chaves sensíveis e tokens soltos em JSON', () => {
    expect(redactJsonKeys({ id: 881, sessionId: 'abc', nome: 'CATU - BA', attrs: [`onclick=f('ViewState=${VS}')`] }))
      .toEqual({ id: 881, sessionId: '<token>', nome: 'CATU - BA', attrs: ["onclick=f('ViewState=<token>')"] });
  });
});
