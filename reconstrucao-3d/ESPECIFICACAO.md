# Projeto: Reconstrução 3D em tempo real usando câmera Android

> Registro consolidado da conversa sobre os projetos `Software_3D_engine` e `Objectron`, e sobre a arquitetura proposta para reconstruir objetos reais em 3D usando um celular Android.

## 1. Objetivo do projeto

Desenvolver um sistema que utilize a câmera de um celular Android para reconstruir objetos reais em 3D progressivamente, enquanto o usuário movimenta o aparelho ao redor do objeto.

O resultado desejado é uma geometria tridimensional que possa ser visualizada, rotacionada, ampliada e exportada em formatos como `.OBJ`, `.PLY` ou `.GLB`.

Isso é **reconstrução 3D**, não apenas detecção de objetos ou desenho de uma caixa delimitadora.

### Diferença entre as abordagens discutidas

- **Câmera virtual:** usada pelo `Software_3D_engine`; representa um observador matemático dentro de uma cena 3D. Não captura o mundo real.
- **Câmera física:** captura imagens do ambiente real por meio do sensor do celular.
- **Objectron:** estima posição, orientação e dimensões aproximadas de determinadas categorias de objetos, representando-os com uma caixa 3D. Não reconstrói uma malha detalhada e completa do objeto.
- **Fotogrametria:** usa várias imagens sobrepostas para estimar posições de câmeras e reconstruir geometria 3D.
- **Reconstrução RGB-D:** combina imagem colorida, profundidade e pose da câmera para integrar observações em uma representação 3D.

## 2. Projetos de referência analisados

### 2.1 Software_3D_engine

Repositório: https://github.com/StanislavPetrovV/Software_3D_engine

Motor de renderização 3D didático em Python. A implementação discutida usa Pygame, NumPy e Numba e trabalha com modelos OBJ.

Arquivos e responsabilidades citados:

| Arquivo | Responsabilidade |
|---|---|
| `main.py` | Inicialização, loop principal e carregamento de modelos |
| `object_3d.py` | Dados e desenho dos objetos |
| `camera.py` | Câmera virtual e seus controles |
| `projection.py` | Projeção em perspectiva e conversão para tela |
| `matrix_functions.py` | Matrizes de transformação |

Pipeline descrito:

1. Carregar vértices (`v`) e faces (`f`) de um arquivo OBJ.
2. Aplicar transformações geométricas, como escala, rotação e translação.
3. Transformar os vértices para o espaço da câmera.
4. Aplicar projeção em perspectiva.
5. Fazer a divisão pela coordenada homogênea `w`.
6. Converter as coordenadas para pixels.
7. Desenhar os polígonos com Pygame.

Exemplo de rotação no eixo Y:

```python
def rotate_y(a):
    return np.array([
        [math.cos(a), 0, -math.sin(a), 0],
        [0, 1, 0, 0],
        [math.sin(a), 0, math.cos(a), 0],
        [0, 0, 0, 1]
    ])
```

O carregador OBJ apresentado na conversa lê vértices e faces. O exemplo principal usa `resources/t_34_obj.obj`.

O código apresentado desenha contornos de polígonos com `pygame.draw.polygon(..., 1)`, caracterizando uma visualização wireframe. A implementação descrita é didática e não oferece, por si só, um pipeline completo de superfícies texturizadas.

Limitações mencionadas na análise:

- Não há carregamento completo de texturas UV e materiais.
- Não há iluminação realista ou sombras.
- Não há Z-buffer por pixel.
- Não há rasterização completa de triângulos preenchidos.
- O clipping é simplificado e pode gerar artefatos em cenas complexas.

O projeto pode servir como referência para entender câmera, matrizes e projeção, mas não é responsável por reconstruir objetos reais.

Links dos arquivos:
- https://github.com/StanislavPetrovV/Software_3D_engine/blob/main/main.py
- https://github.com/StanislavPetrovV/Software_3D_engine/blob/main/object_3d.py
- https://github.com/StanislavPetrovV/Software_3D_engine/blob/main/camera.py
- https://github.com/StanislavPetrovV/Software_3D_engine/blob/main/projection.py
- https://github.com/StanislavPetrovV/Software_3D_engine/blob/main/matrix_functions.py

### 2.2 Objectron

Repositório: https://github.com/akshaybahadur21/Objectron

A implementação discutida utiliza visão computacional e MediaPipe Objectron para detectar e estimar informações 3D de objetos reais. Foi descrita como capaz de estimar centro, orientação e dimensões aproximadas de uma caixa 3D para categorias como câmera, copo, sapato e cadeira.

**Importante:** Objectron não é uma solução de reconstrução detalhada de malha. Ele serve como referência de detecção e estimativa 3D, não como o núcleo do reconstrutor desejado.

Também foi observado que Objectron é uma solução legada do MediaPipe, cujo suporte oficial foi encerrado em 1º de março de 2023. A execução pode exigir ajustes de dependências e versões.

## 3. Objetivo técnico definido

O usuário escolheu:

- Dispositivo: celular Android.
- Método: reconstrução em tempo real enquanto movimenta a câmera.
- Resultado: reconstruir a geometria de objetos reais, não apenas detectar ou desenhar uma caixa 3D.
- Processamento proposto: arquitetura híbrida, com captura e rastreamento no Android e reconstrução no computador usando Python.

A ideia é apontar o celular para um objeto, movimentá-lo ao redor e observar a geometria sendo construída progressivamente no computador.

## 4. Arquitetura recomendada

### Visão geral

```text
CELULAR ANDROID
  ├── Câmera RGB
  ├── ARCore: rastreamento e pose da câmera
  ├── ARCore Depth API: mapa de profundidade
  └── Captura de intrínsecos
          |
          | Wi-Fi / WebSocket
          v
COMPUTADOR — PYTHON
  ├── FastAPI + WebSocket
  ├── Recepção e sincronização dos frames
  ├── Conversão depth -> pontos 3D
  ├── Transformação para coordenadas do mundo
  ├── Filtragem de dados
  └── Open3D: fusão volumétrica TSDF
          |
          v
VISUALIZADOR
  ├── Nuvem de pontos
  ├── Malha progressiva
  ├── Rotação e zoom
  └── Exportação OBJ / PLY / GLB
```

### Tecnologias escolhidas

| Tecnologia | Uso |
|---|---|
| Kotlin | Aplicativo Android |
| ARCore | Rastreamento da câmera e pose 3D |
| ARCore Depth API | Estimativa de profundidade por frame |
| Camera API / ARCore | Captura das imagens RGB |
| Python 3.11 | Backend e processamento no computador |
| Open3D | Nuvens de pontos, integração RGB-D, TSDF e malhas |
| NumPy | Cálculos matriciais e vetoriais |
| FastAPI | Servidor Python |
| WebSocket | Transmissão contínua de dados |
| Three.js | Visualizador 3D no navegador |

Documentação:
- ARCore: https://developers.google.com/ar
- Dispositivos compatíveis: https://developers.google.com/ar/devices
- Open3D: https://www.open3d.org/docs/
- FastAPI: https://fastapi.tiangolo.com/
- Three.js: https://threejs.org/docs/

### Por que ARCore Depth API?

A Depth API pode fornecer um mapa de profundidade associado à câmera. Cada pixel válido contém uma estimativa da distância até a superfície observada.

Ela pode funcionar sem um sensor ToF dedicado em dispositivos compatíveis, mas a disponibilidade e a qualidade variam conforme o aparelho e as condições da cena.

A compatibilidade do celular precisa ser verificada antes de implementar a captura.

## 5. Algoritmo principal: TSDF

A recomendação inicial é utilizar **TSDF (Truncated Signed Distance Function)**, uma técnica de fusão volumétrica que integra observações de profundidade de várias posições da câmera.

Fluxo:

1. Capturar imagem RGB.
2. Obter mapa de profundidade correspondente.
3. Obter pose e intrínsecos da câmera.
4. Converter pixels com profundidade válida em pontos 3D.
5. Transformar os pontos do sistema da câmera para o sistema global.
6. Integrar as observações no volume TSDF.
7. Extrair uma malha progressivamente.

Vantagem: novas observações são integradas ao volume existente, sem precisar reconstruir todo o objeto do zero a cada frame.

O Open3D oferece ferramentas de integração RGB-D e extração de malha. A implementação precisa respeitar as convenções de coordenadas e unidades da câmera e do Open3D.

## 6. Conversão de profundidade em coordenadas 3D

Para cada pixel `(u, v)` com profundidade válida `Z`:

```text
Z = depth(u, v)

X = (u - cx) * Z / fx
Y = (v - cy) * Z / fy
```

Onde:

- `u, v`: coordenadas do pixel.
- `Z`: distância estimada pela profundidade.
- `fx, fy`: distância focal em pixels.
- `cx, cy`: centro óptico da imagem.

O resultado é um ponto 3D no referencial da câmera. Em seguida, deve-se aplicar a transformação apropriada para posicioná-lo no referencial global.

**Atenção:** é necessário verificar unidades (por exemplo, metros), orientação dos eixos, convenções de pose e sincronização entre RGB, profundidade e pose. Uma inversão incorreta da matriz pode espelhar ou deslocar a reconstrução.

## 7. Comunicação Android–PC

Foi proposta comunicação por WebSocket através de Wi-Fi.

Estrutura conceitual de um frame:

```python
frame = {
    "timestamp": 123456,
    "color": "rgb_image",
    "depth": "depth_map",
    "camera_pose": [
        # Matriz 4x4
    ],
    "intrinsics": {
        "fx": 0,
        "fy": 0,
        "cx": 0,
        "cy": 0
    }
}
```

Campos:

- `timestamp`: instante da captura, para sincronização.
- `color`: imagem RGB.
- `depth`: mapa numérico de profundidade.
- `camera_pose`: matriz 4x4 com posição e orientação.
- `intrinsics`: parâmetros internos da câmera.

O mapa de profundidade deve ser transmitido preservando seus valores numéricos. Não se deve convertê-lo para JPEG comum, pois isso destruiria a informação métrica.

É necessário definir um formato binário eficiente, compressão apropriada, controle de fila e descarte de frames atrasados para evitar latência crescente.

## 8. Estrutura de pastas sugerida

```text
RealTime3D/
│
├── android/
│   └── app/
│       └── src/main/
│           ├── java/com/realtime3d/
│           │   ├── MainActivity.kt
│           │   ├── ARCoreManager.kt
│           │   ├── DepthCapture.kt
│           │   ├── CameraTracker.kt
│           │   └── NetworkManager.kt
│           └── AndroidManifest.xml
│
├── backend/
│   ├── main.py
│   ├── websocket_server.py
│   │
│   ├── reconstruction/
│   │   ├── depth_processor.py
│   │   ├── point_cloud.py
│   │   ├── tsdf_reconstruction.py
│   │   └── mesh_extractor.py
│   │
│   └── export/
│       ├── export_obj.py
│       └── export_glb.py
│
├── viewer/
│   ├── index.html
│   ├── viewer.js
│   └── style.css
│
└── requirements.txt
```

## 9. Metas de desempenho iniciais

Valores propostos para começar os testes, não garantias:

| Processo | Frequência pretendida |
|---|---:|
| Captura da câmera | 30 FPS |
| Transmissão | 10–15 FPS |
| Integração TSDF | 5–10 FPS |
| Atualização da malha | 1–2 FPS |

É recomendável separar a frequência de captura, integração e extração de malha. A extração de malha pode ser mais pesada e não precisa acontecer em todos os frames.

## 10. Dificuldades técnicas previstas

### Compatibilidade do aparelho

- Nem todo Android suporta ARCore.
- Nem todo aparelho compatível oferece a Depth API.
- A qualidade e a disponibilidade da profundidade variam.
- É necessário consultar a lista oficial de dispositivos e testar o aparelho real.

### Segmentação do objeto

O mapa de profundidade pode conter mesa, chão, parede e outros elementos. Será necessário separar o objeto de interesse do fundo, inicialmente com uma região de interesse ou máscara, e futuramente com segmentação.

### Oclusão

Partes que não aparecem na câmera não podem ser reconstruídas diretamente. O usuário precisará observar diferentes lados e partes do objeto.

### Superfícies difíceis

Superfícies brilhantes, transparentes, escuras ou sem textura podem produzir profundidade incompleta ou incorreta.

### Hardware do computador

O computador informado anteriormente pelo usuário tem:
- Windows 11.
- Intel Xeon E5-2650 v3.
- AMD XFX RX 580 de 4 GB.
- 16 GB de RAM.
- SSD NVMe de 2 TB.

A arquitetura deve começar com processamento moderado na CPU. Não se deve pressupor que a RX 580 será compatível com caminhos CUDA. Algumas acelerações do ecossistema são voltadas a NVIDIA/CUDA; alternativas para AMD dependem das bibliotecas e do ambiente.

## 11. Plano de desenvolvimento

### Etapa 1 — Aplicativo Android
- Criar projeto Kotlin.
- Integrar ARCore.
- Verificar compatibilidade e habilitar Depth API.
- Capturar RGB, profundidade, pose e intrínsecos.
- Conferir alinhamento e timestamps dos dados.

### Etapa 2 — Comunicação
- Criar servidor FastAPI.
- Implementar WebSocket.
- Transmitir dados do Android ao computador.
- Visualizar frames recebidos e medir latência.

### Etapa 3 — Reconstrução
- Converter profundidade em pontos 3D.
- Aplicar pose da câmera.
- Filtrar dados ruins.
- Integrar observações com TSDF.

### Etapa 4 — Visualização
- Exibir nuvem de pontos.
- Atualizar malha progressivamente.
- Aplicar cores/texturas.
- Permitir rotação, zoom e inspeção.

### Etapa 5 — Exportação
- Exportar OBJ, PLY e GLB.
- Salvar sessões de reconstrução.
- Permitir retomar ou processar uma captura posteriormente.

## 12. Relação com o Software_3D_engine

O `Software_3D_engine` pode servir como referência didática para câmera virtual, transformações e projeção, mas não é necessário usá-lo como renderizador final.

Para nuvens de pontos e malhas de reconstrução, Open3D é mais adequado no início. Three.js pode oferecer uma interface de visualização no navegador.

A integração futura com o motor próprio pode ser considerada depois que a captura, reconstrução e exportação estiverem estáveis.

## 13. Próxima informação necessária

Antes de iniciar a implementação, é necessário identificar o celular Android.

Informações a obter:
- Marca e modelo exatos.
- Versão do Android.
- Se possui sensor LiDAR ou ToF (se souber; não é obrigatório para usar ARCore Depth API).

Com o modelo exato, verificar:
1. Compatibilidade com ARCore.
2. Suporte à Depth API.
3. Resoluções e formatos de imagem/profundidade disponíveis.
4. Estratégia de captura e transmissão mais apropriada.

## 14. Primeiro marco do projeto

O primeiro protótipo deve conseguir:

1. Abrir a câmera do Android.
2. Capturar imagem RGB, mapa de profundidade e pose.
3. Enviar os dados ao computador via Wi-Fi.
4. Converter um frame em uma nuvem de pontos 3D.
5. Mostrar essa nuvem no computador.

Somente depois disso deve-se implementar a fusão TSDF e a malha progressiva.

**Objetivo de validação:** escanear um objeto simples e opaco, como uma caneca, movimentando o celular ao redor dele, e observar sua geometria sendo construída progressivamente no computador.

---

## Observação sobre o escopo

Este documento consolida as decisões, explicações, referências e propostas técnicas discutidas na conversa. Ele é uma especificação inicial, não uma implementação já executada ou testada. Compatibilidade do aparelho, desempenho, versões de bibliotecas e detalhes de integração precisam ser verificados durante o desenvolvimento.
