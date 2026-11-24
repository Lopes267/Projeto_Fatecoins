# Reconstrução 3D (teste)

Protótipo da [ESPECIFICACAO.md](ESPECIFICACAO.md): o celular dá a volta num objeto,
manda profundidade + pose por WebSocket, e o computador funde tudo num volume TSDF
(Open3D) e devolve um `.glb` em tamanho real, no formato que o site já usa
(`modelo_3d_url` + `escalaReal` lido pelo `ar-viewer.js`).

**Estado (24/11/2026):** funciona de ponta a ponta com captura sintética e com um
WebXR simulado no Chrome. **Ainda não foi testado num celular de verdade.** O
Galaxy A14 5G aparece na lista do ARCore, mas sem a nota "Supports Depth API" — a
página `/captura` diz na hora se o aparelho tem ou não.

No painel do site, o botão **"Escanear com a câmera"** (cadastro do produto) abre
este serviço já com o login do lojista: no celular cai na captura, no computador no
visualizador. O `.glb` baixado entra no produto pelo botão "Enviar .glb". O servidor
Node não serve esta pasta (bloqueada em `server.js`). Online, roda como um serviço
Python separado no Render (ver abaixo).

## Online (Render)

O site (Node) não consegue rodar o Open3D, que precisa de bibliotecas do sistema
(`libGL`, `libEGL`, `libX11`, `libudev`, `libusb`, lidas da própria roda do
`open3d-cpu`). Por isso a reconstrução é um **segundo serviço**, em Docker:
[Dockerfile](Dockerfile) + [render.yaml](../render.yaml) na raiz do repositório.

Criar uma vez:

1. Render → **New → Blueprint** → repositório `Projeto_Fatecoins`, branch `Detalhes_Finais`.
2. Ele lê o `render.yaml` e cria `mercado-local-reconstrucao-3d` (plano grátis).
   O site não é alterado.
3. Se o endereço criado não for `https://mercado-local-reconstrucao-3d.onrender.com`
   (nome já usado por outra pessoa), troque `URL_ESCANEAMENTO_3D` em `dashboard.html`.

Usar: entre no painel do site (celular ou computador), abra um produto e toque em
**Escanear com a câmera**. Online já é HTTPS, então o celular não precisa de cabo.

Quem entra: só quem está logado no site. O painel manda o ID token do Firebase
depois do `#` do endereço (não vai para servidor nem log); o serviço confere com as
chaves públicas do Google (`backend/acesso.py`, projeto `fatecoin-mercado`) e guarda
um cookie próprio, assinado, por 7 dias. Sem login, páginas, sessões e WebSockets
recusam (só `/saude`, `/entrar` e os `.js` das páginas são públicos). O bloqueio liga
sozinho no Render (variável `RENDER`); no computador fica aberto como antes.
`CHAVE_ACESSO`, se for definida, vira uma segunda porta (útil para o envio sintético:
`.venv\Scripts\python -m backend.sintetico.enviar wss://<serviço>.onrender.com --chave <CHAVE>`).

Limites do plano grátis: 0,1 CPU (a fusão fica ~10× mais lenta e quadros são
descartados — a prévia sai a cada 3 s, `INTERVALO_MALHA`), 512 MB de memória (o
servidor usou no máximo 212 MB numa captura), o serviço dorme depois de 15 min sem
uso (a primeira abertura leva ~1 min) e as sessões somem a cada deploy.

O `Dockerfile` não foi construído nesta máquina (sem Docker); as dependências
foram conferidas baixando as rodas Linux de Python 3.12 e lendo o que o
`libOpen3D.so` pede ao sistema.

## Rodar

```bat
iniciar.bat
```

Na primeira vez cria o `.venv` e instala o `requirements.txt` (Python 3.13). Depois:

| O quê | Onde |
|---|---|
| Visualizador (computador) | http://localhost:8000 |
| Captura (Chrome do celular, pelo cabo) | http://localhost:8000/captura |
| Modelo no visualizador do site | botão "Ver como o cliente" no visualizador |

O celular chega ao computador pelo cabo: `adb reverse tcp:8000 tcp:8000` (o
`iniciar.bat` já faz). O WebXR só abre em página segura (`localhost` ou HTTPS),
por isso Wi-Fi puro não serve — precisaria de certificado.

Demonstração sem celular (com o servidor rodando, abra o visualizador antes):

```bat
.venv\Scripts\python -m backend.sintetico.enviar
```

Reprocessar uma captura gravada (todo quadro recebido fica em `sessoes/<id>/quadros/`):

```bat
.venv\Scripts\python -m backend.reprocessar sessoes\<id> --voxel 0.003 --trunc 3
```

## Testes

```bat
.venv\Scripts\python -m pytest backend\testes -q      :: 35 testes, ~20 s
node testes-navegador\rodar.mjs                         :: 17 conferências no Chrome headless
```

- `test_geometria.py` — convenções: projeção do WebXR → intrínsecos, giro do mapa
  de profundidade, eixos OpenGL → OpenCV, motor sem espelho, GLB ida e volta,
  quadros inválidos recusados.
- `test_ponta_a_ponta.py` — servidor de verdade + WebSocket + caneca sintética,
  medida contra a caneca verdadeira.
- `test_acesso.py` — login do site (tokens RS256 no formato do Firebase: válido,
  expirado, outro projeto, assinatura falsa…), cookie assinado e chave opcional.
- `testes-navegador/` — a página `/captura` real com um WebXR falso injetado
  (parede a 1 m), o visualizador ao vivo e o `.glb` dentro do `ar-viewer.js` do site.

## Resultados medidos (caneca sintética, 90 quadros, 160×90)

Caneca de 8 cm × 9,5 cm com alça (11,0 × 9,5 × 8,0 cm no total), numa mesa, com uma
caixa ao lado que não pode entrar no modelo.

| | erro médio | erro p95 | superfície coberta | erro nas medidas | sobras (mesa/caixa) |
|---|---|---|---|---|---|
| sem ruído | 1,05 mm | 3,1 mm | 100 % | ≤ 4 mm | 0 |
| ruído tipo ARCore + deriva da pose | 1,57 mm | 5,6 mm | 91 % | ≤ 4,6 mm | 0 |

- Fusão: ~10–15 ms por quadro na CPU (a meta da especificação era 5–10 quadros/s).
- Tempo real: quadros mais rápidos que a fusão são descartados e a latência fica em ~25–50 ms.
- O ruído simulado (1 % da distância, manchas, bordas borradas, 3 % de buracos) é um
  palpite: o ARCore de verdade pode ser pior, principalmente em superfícies lisas.

**Limite conhecido:** com ruído, a borda da caneca (parede de 4 mm) some e a alça
fica fina — paredes mais finas que ~2× o ruído do sensor são um limite do TSDF.

## O que veio de cada repositório

- **[Software_3D_engine](https://github.com/StanislavPetrovV/Software_3D_engine)** (MIT) →
  `backend/sintetico/motor.py`: matrizes, câmera, projeção e o caminho
  `vértices @ câmera @ projeção / w @ tela`, com Numba. Usado para **gerar** as
  capturas de teste (com verdade conhecida). Foi preciso acrescentar Z-buffer e
  triângulos preenchidos e corrigir dois erros do original:
  - a câmera usa `right = +x` fixo olhando para `+z`, o que **espelha** a imagem
    (uma câmera de verdade teria a direita em `-x`);
  - `v_fov = h_fov · altura/largura` só vale para ângulo pequeno (60° em 16:9 dá
    33,75° em vez de 36,0°, pixels não quadrados).
- **[Objectron](https://github.com/akshaybahadur21/Objectron)** (MIT) → estrutura do
  `backend/servidor.py` (FastAPI + WebSocket + gerente de conexões) e do
  `web/visualizador.js` (Three.js + OrbitControls). **Atenção:** este repositório
  **não** é o MediaPipe Objectron descrito na especificação: é um app de desenhar no
  ar com a mão (MediaPipe Hands) que extruda o traço em 3D. Não detecta nem reconstrói
  objetos, então nada de visão dele entrou aqui. (O MediaPipe Objectron de verdade foi
  descontinuado em 2023.)

## Onde o teste se afasta da especificação

| Especificação | Aqui | Por quê |
|---|---|---|
| App Android em Kotlin + ARCore | Página web com WebXR no Chrome (`/captura`) | O Chrome do Android usa o próprio ARCore (pose + Depth API). Cabe no projeto web, não precisa de Android Studio/SDK (não instalados) e é testável no computador. O protocolo é o mesmo, um app Kotlin pode mandar os mesmos quadros depois. |
| Wi-Fi | Cabo USB (`adb reverse`) | WebXR exige página segura; por Wi-Fi seria preciso HTTPS. |
| Open3D TSDF | `VoxelBlockGrid` (API de tensores) | A `ScalableTSDFVolume` do Open3D 0.20 no Windows integra sem gerar superfície (nem uma parede plana). |
| — | voxel 3 mm, truncamento 9 mm | Truncamento de 2 cm criava uma película falsa dentro da caneca (erro médio 2,2 → 1,05 mm). |
| Segmentação futura | Plano de apoio (RANSAC) + maior pedaço perto do alvo | Tira a mesa e objetos vizinhos sem rede neural. |

## Protocolo de um quadro

`[uint32 tamanho][cabeçalho JSON][profundidade crua][JPEG opcional]` — detalhes em
`backend/reconstrucao/quadro.py`. A profundidade vai sem compressão com perda. O
cabeçalho leva 5 "sondas" (`getDepthInMeters()` do próprio navegador): o servidor
confere se lê o mapa igual ao navegador e corrige sozinho se o eixo y vier invertido.

## Próximos passos

1. Ligar o A14 no cabo, abrir `/captura` e ver se a Depth API aparece. Se não
   aparecer, o caminho é outro celular (ex.: Galaxy A15 5G tem a nota) ou
   fotogrametria offline.
2. Com captura real: comparar a medida do modelo com uma régua e reprocessar
   (`backend.reprocessar`) ajustando voxel/truncamento.
3. Trazer o `.glb` direto para o cadastro do produto, sem baixar e reenviar.
