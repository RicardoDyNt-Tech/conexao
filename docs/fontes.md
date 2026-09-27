# Fontes de dados — ClickBus (rascunho da Fase 0)

> Atualizado em 26/09/2026 com as capturas do Ricardo (data de viagem testada: **domingo, 04/10/2026**).
> Status: **parcial**. Falta capturar o endpoint que devolve a lista de viagens (seção 3).

---

## 1. Autocomplete de cidades ✅

```
GET https://bff.clickbus.com/web/api/v4/places
    ?clientId=3&limit=5&name=catu
    &fields=id,name,slug,useGroupByCity,city,isNotPlace,distanceKm
```

Resposta (JSON, lista):
```json
{ "id": 4680, "name": "Catu, BA", "slug": "catu-ba",
  "useGroupByCity": false, "city": { "id": "923", "name": "Catu" } }
```

- O campo que importa para montar a busca é o **`slug`**.
- Headers enviados pelo navegador: `cb-client-type: w`, `cb-client-side: browser`, `fp-cb`, `st-cb-px`, `x-customer-session-id`, `x-transaction-id`, `origin: https://www.clickbus.com.br`.
- **A testar:** se funciona sem `fp-cb`, `st-cb-px` e `x-customer-session-id` (parecem ser fingerprint/anti-bot).

### Slugs confirmados

| Cidade | Slug |
|---|---|
| Feira de Santana (todas as rodoviárias) | `feira-de-santana-todos` ⚠️ não é `feira-de-santana-ba` |
| Alagoinhas | `alagoinhas-ba` |
| Salvador | `salvador-ba` |
| Catu | `catu-ba` |

---

## 2. Página de resultados (HTML / RSC) ⚠️ não traz as viagens

```
GET https://www.clickbus.com.br/onibus/{origem}/{destino}?departureDate=AAAA-MM-DD
GET ...mesma URL...&_rsc=<qualquer>   com headers  rsc: 1  e  next-url: /search/{origem}/{destino}
```

- ✅ Funciona **sem cookies**, a partir do PC do Ricardo (IP residencial).
- ❌ **Não contém a lista de viagens.** O payload do Next.js vem com `"trips":[]`: a lista é carregada depois, pelo navegador, numa chamada separada (seção 3).
- ✅ Contém dados úteis:
  - **Resumo de preços** (schema.org `AggregateOffer`): `lowPrice`, `highPrice`, `offerCount`.
  - **Rodoviárias** (`terminals`): nome e endereço. Ex.: `Novo Terminal Rodoviário de Salvador — Rodovia BR 324 sentido Feira de Santana, KM 7,5, Águas Claras`.
  - **Configuração de filtros/ordenação**, que revela o formato das viagens:
    - `trips[*].price`
    - `trips[*].parts[0].departure.time`, `trips[*].parts[last].arrival.time`
    - `trips[*].parts[0].departure.slug`
    - `trips[*].parts[*].travelCompany.slug`
    - `trips[*].parts[*].serviceClass.id`
    - `trips[*].parts[0].isLowFare` (ClickOferta)
    - `trips[*].duration.hours`
    - **`parts[]` sugere que a ClickBus modela viagens com mais de um trecho**, ou seja, suporta conexão.
- Config de runtime: `BFF_API_URL = https://bff.clickbus.com/web/api`, `FRONTEND_API_PROXY = /api/v4`. A busca de viagens provavelmente usa um desses dois.

### Resumo por trecho (04/10/2026, domingo)

| Trecho | Menor | Maior | Ofertas |
|---|---|---|---|
| Feira → Alagoinhas | — | — | **nenhuma** |
| Alagoinhas → Catu | R$ 13,05 | R$ 18,75 | 17 |
| Feira → Salvador | R$ 37,29 | R$ 84,20 | 47 |
| Salvador → Catu | R$ 28,99 | R$ 45,80 | 24 |
| Catu → Alagoinhas | R$ 10,25 | R$ 14,00 | 11 |
| Alagoinhas → Feira | R$ 39,19 | R$ 39,19 | 1 |
| Catu → Salvador | R$ 34,15 | R$ 38,15 | 12 |
| Salvador → Feira | R$ 42,25 | R$ 96,25 | 57 |
| **Feira → Catu (direto)** | — | — | **nenhuma** (`isRedirectResult: true`) |

Observações:
- **Não existe bilhete único Feira → Catu na ClickBus.** A hipótese de conexão vendida pronta caiu.
- **Feira → Alagoinhas não tem oferta nesse domingo.** Pode não operar aos domingos ou não ser vendida na ClickBus. Testar um dia útil e o Quero Passagem.
- `offerCount` parece contar viagem × classe (Salvador → Catu: 24 ofertas para ~12 horários).

---

## 3. Busca de viagens ✅ (endpoint principal)

```
GET https://bff.clickbus.com/web/api/v6/trips
    ?from=salvador-ba&to=catu-ba&departureDate=2026-10-04&clientId=2
```

JSON limpo. Fixture: `trips-salvador-ba_catu-ba_2026-10-04.json` (18 viagens).

Headers enviados pelo navegador: `origin: https://www.clickbus.com.br`, `cb-front-version`, `fp-cb`, `st-cb-px`, `x-customer-session-id`, `x-transaction-id`, `if-none-match` (cache/ETag).

### ⚠️ Proteção anti-robô (testado em 26/09/2026, do PC do Ricardo)

| Teste | Resultado |
|---|---|
| Só `origin` + `user-agent` | 403 `ST: Forbidden request` |
| Conjunto completo de headers, **mesma URL capturada** | ✅ 18 viagens |
| Só `st-cb-px` | 403 `Forbidden resource` |
| Só `fp-cb` | 403 `ST: Forbidden request` |
| Conjunto completo, **outro trecho** | 403 `Forbidden resource` |
| Conjunto completo, **outra data** | 403 `Forbidden resource` |

Conclusão provisória: `st-cb-px` (40 caracteres hex, formato de SHA-1) é uma **assinatura gerada pelo site para cada URL**. Ela só vale para a requisição exata que foi capturada, então **não dá para reaproveitar**. O sufixo "px" sugere um serviço anti-bot comercial (ex.: PerimeterX/HUMAN), que costuma bloquear navegadores automatizados rodando em datacenter.

**Decisão:** não vamos fazer engenharia reversa da assinatura. Isso seria contornar deliberadamente uma proteção de acesso. Caminhos que seguem abertos:
1. **Quero Passagem** (testar se a API é aberta).
2. **Navegador automatizado (Playwright)** usando o site como um usuário normal e lendo a resposta de `v6/trips`, de preferência no PC do Ricardo (IP residencial).
3. **Parceria/afiliados ClickBus** (API oficial), se um dia fizer sentido.

### Estrutura (o que o coletor usa)

```jsonc
{
  "trips": [{
    "type": "direct",                // existe outro tipo? ("connection"?) — ver isMergedTrips
    "price": 33.99,                   // preço total da viagem
    "originalPrice": 37.9,
    "duration": { "hours": "2h 0m", "days": 0 },   // days=1 quando chega no dia seguinte
    "isMergedTrips": false,
    "parts": [{                       // 1 parte por trecho
      "tripId": "50114996-...",       // ID estável da viagem → usar na chave única
      "price": 33.99,
      "waitingTime": null,            // provavelmente preenchido em conexões
      "departure": { "date": "2026-10-04", "time": "06:00:00",
                     "name": "Novo Terminal Rodoviário de Salvador",
                     "slug": "salvador-ba", "id": 3874 },   // id = rodoviária
      "arrival":   { "date": "2026-10-04", "time": "08:00:00",
                     "name": "Catu, BA", "slug": "catu-ba", "id": 4680 },
      "serviceClass":  { "id": 1, "name": "Convencional" },
      "travelCompany": { "name": "Cidade Sol", "slug": "cidade-sol" },
      "availableSeats": 38, "totalSeats": 42,
      "lowFareAvailableSeats": 8,     // assentos no preço promocional
      "isLowFare": true
    }]
  }],
  "terminals": [...], "travelCompanies": [...],
  "alternativeDate": null, "errors": [], "isRedirectResult": false
}
```

### Mapeamento para a tabela `trips`

| Campo do banco | Origem no JSON |
|---|---|
| `source` | `'clickbus'` |
| `company` | `parts[0].travelCompany.slug` |
| `origin_station` | `parts[0].departure.name` (+ `id`) |
| `dest_station` | `parts[last].arrival.name` (+ `id`) |
| `departure_at` | `parts[0].departure.date + time`, fuso America/Bahia |
| `arrival_at` | `parts[last].arrival.date + time`, fuso America/Bahia (já trata a virada do dia) |
| `service_class` | `parts[0].serviceClass.name` |
| `price` | `trips[].price` |
| `seats_available` | `parts[0].availableSeats` |
| chave única | `parts[0].tripId` |
| `buy_url` | `https://www.clickbus.com.br/onibus/{from}/{to}?departureDate={date}` (link direto para a viagem: a descobrir) |

### Observações
- **Salvador → Catu, domingo 04/10: 18 viagens entre 06:00 e 23:00** (16 Cidade Sol, 2 Rota). Muito mais que as ~12 estimadas.
- A viagem das 23:00 chega às 00:20 do dia seguinte (`arrival.date` = 05/10, `duration.days` = 1). Esse é um caso de borda real e confirmado.
- Os valores de `type` e `isMergedTrips` sugerem que a ClickBus também devolve **viagens com conexão já montadas** em algumas rotas. Vale investigar, porque poderia ser usado no lugar do nosso cruzamento.

---

## 5. Quero Passagem (explorado no Chrome em 26/09/2026)

### URL de busca (pública)
```
https://queropassagem.com.br/onibus/{origem}-para-{destino}?ida=DD-MM-AAAA
```
- Slugs: `salvador-ba`, `feira-de-santana-ba` (mostra "Feira de Santana, BA - TODOS"), `catu`, `alagoinhas`. ⚠️ Catu e Alagoinhas **sem** `-ba`.
- A data vai em `?ida=04-10-2026` (dia-mês-ano). Outros formatos dão 404.

### Onde estão os dados
1. **No HTML da página** (schema.org `BusTrip`, JSON-LD): um item por viagem, com viação, rodoviária e `departureTime` correto (ex.: `2026-10-04T06:00:00-03:00`).
   - `arrivalTime` vem **com defeito** (ano 2083 e hora deslocada em +3h). Não usar.
   - Preço só aparece agregado (`AggregateOffer` por viação), **sem preço por viagem e sem assentos**.
2. **Dados completos** vêm de `GET /search/{JWT}`, **uma chamada por provedor** (campo `gds`: 1, 3, 6, 7, 9, 29, 33):
   - Resposta JSON `{ source, itens: [{ company.name, from, to, departure: "2026-09-27 06:00:00", arrival, availableSeats, seatClass, price, tax, insurance, travelDuration, ... }] }`. Formato ótimo.
   - O JWT (HS256) é **assinado pelo servidor**: `{ gds, from: 73, to: 1705, date, from_is_city, to_is_city }`. Não aparece no HTML. A investigação parou aqui, porque a origem do token envolve o endpoint de autenticação do site. Não vamos forjar nem extrair tokens.
3. `GET /search-connections/{token}/18`: **busca de conexões** do próprio Quero Passagem.

### 🎯 Achado importante: o Quero Passagem vende Feira → Catu COM CONEXÃO
Segunda, 05/10/2026, 3 opções (todas com "1 conexão", vendidas como uma compra só):

| Saída | Chegada | Duração | Classe | Viação | Preço |
|---|---|---|---|---|---|
| 02:15 | 07:00 | 4h45 | Executivo | Cidade Sol | R$ 89,28 |
| 03:20 | 07:30 | 4h10 | Executivo | Cidade Sol | R$ 100,50 |
| 03:25 | 09:50 | 6h25 | Convencional | Rota | R$ 73,49 |

Leitura:
- Existe conexão pronta, mas **só de madrugada, poucas opções e mais cara**. Montando os dois trechos separados (ex.: Feira → Salvador a partir de ~R$ 37 + Salvador → Catu a partir de ~R$ 27), sai por ~R$ 64–70, com dezenas de horários ao longo do dia.
- Isso **valida o valor do app**: o que falta no mercado é justamente combinar os trechos em qualquer horário.
- O app pode mostrar essas conexões prontas como uma opção a mais ("vendida como bilhete único").

---

## 6. Próximos testes

- [x] Capturar o endpoint de viagens (seção 3).
- [ ] Testar `v6/trips` sem os headers de fingerprint (`fp-cb`, `st-cb-px`, `x-customer-session-id`).
- [ ] Testar o autocomplete sem os headers de fingerprint.
- [ ] Repetir Feira → Alagoinhas num dia útil.
- [ ] Testar tudo a partir de uma Supabase Edge Function (Fase 1).
