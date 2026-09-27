import { describe, expect, it } from 'vitest';
import { pickFields, redactForm, redactHtml, redactJson, redactTokenLike } from '../src/webrodoviaria-capture.js';

const f = (o: Record<string, unknown>) => ({ idx: 0, tag: 'input', type: 'text', name: '', id: '', placeholder: '', aria: '',
  cls: '', label: '', text: '', readonly: false, formMethod: null, formAction: null, ...o }) as never;

describe('webrodoviaria: ocultação de sessão/estado', () => {
  it('POST de formulário: ViewState, token e valores longos saem ocultos', () => {
    const body = `javax.faces.ViewState=${'V'.repeat(120)}&origem=SALVADOR+-+BA&csrf_token=abc&dataIda=10%2F10%2F2026&x=${'y'.repeat(70)}`;
    expect(redactForm(body)).toBe('javax.faces.ViewState=<redacted>&origem=SALVADOR+-+BA&csrf_token=<redacted>&dataIda=10%2F10%2F2026&x=<redacted>');
  });

  it('POST em JSON: chaves sensíveis ocultas, o resto fica', () => {
    const out = JSON.parse(redactForm(JSON.stringify({ origem: 'SALVADOR - BA', data: '10/10/2026', token: 'abc', sessionId: '1' })));
    expect(out).toEqual({ origem: 'SALVADOR - BA', data: '10/10/2026', token: '<redacted>', sessionId: '<redacted>' });
  });

  it('JSON de resposta e HTML: sem tokens nem ViewState', () => {
    expect(redactJson({ viagens: [{ id: 'T1', auth: 'segredo', obs: 'z'.repeat(250) }] }))
      .toEqual({ viagens: [{ id: 'T1', auth: '<redacted>', obs: '<redacted>' }] });
    const html = `<input type="hidden" name="javax.faces.ViewState" value="${'W'.repeat(80)}"><input type="text" value="SALVADOR">`;
    expect(redactHtml(html)).toBe('<input type="hidden" name="javax.faces.ViewState" value="<redacted>"><input type="text" value="SALVADOR">');
    expect(redactTokenLike([{ label: 'V'.repeat(50), text: 'PESQUISAR', url: `https://x.com/${'a'.repeat(50)}` }]))
      .toEqual([{ label: '<redacted>', text: 'PESQUISAR', url: `https://x.com/${'a'.repeat(50)}` }]);
  });
});

describe('webrodoviaria: escolha dos campos do formulário', () => {
  it('acha origem, destino, data e botão por rótulo/placeholder', () => {
    const fields = [
      f({ idx: 0, id: 'txtOrigem', placeholder: 'De onde você vai sair?' }),
      f({ idx: 1, id: 'txtDestino', label: 'Destino' }),
      f({ idx: 2, name: 'dataIda', label: 'Data de ida', readonly: true }),
      f({ idx: 3, tag: 'button', type: 'button', text: 'PESQUISAR' }),
    ];
    const p = pickFields(fields);
    expect([p.origin?.idx, p.dest?.idx, p.date?.idx, p.submit?.idx]).toEqual([0, 1, 2, 3]);
  });

  it('ignora campos ocultos/botões ao escolher os inputs; aceita select', () => {
    const fields = [
      f({ idx: 0, type: 'hidden', name: 'origemId' }),
      f({ idx: 1, tag: 'select', type: '', name: 'origem', options: ['SALVADOR - BA'] }),
      f({ idx: 2, tag: 'select', type: '', name: 'destino' }),
      f({ idx: 3, type: 'submit', tag: 'input', text: 'Consultar' }),
    ];
    const p = pickFields(fields);
    expect([p.origin?.idx, p.dest?.idx, p.date, p.submit?.idx]).toEqual([1, 2, undefined, 3]);
  });

  it('sem botão de pesquisa: não inventa', () => {
    expect(pickFields([f({ idx: 0, id: 'origem' }), f({ idx: 1, id: 'destino' })]).submit).toBeUndefined();
  });
});
