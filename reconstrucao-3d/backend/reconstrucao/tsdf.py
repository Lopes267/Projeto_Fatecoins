"""
Fusão volumétrica TSDF (seção 5 da especificação) e limpeza da malha.

Usa a VoxelBlockGrid do Open3D (API de tensores): só os blocos perto de
alguma superfície vista ocupam memória. A ScalableTSDFVolume (API antiga)
foi testada no Open3D 0.20 para Windows e integra sem gerar superfície
nenhuma — nem uma parede plana a 1 m — por isso não é usada.

Fluxo de cada quadro: profundidade do sensor -> grade da vista -> pontos no
mundo -> descarta o que está fora da região de interesse (esfera em volta do
objeto) -> integra no volume.

No fim: extrai a malha, acha o plano de apoio (mesa/chão), corta o que está
nele ou abaixo, fica com o pedaço do objeto e põe a base em y = 0.
"""
from __future__ import annotations

import numpy as np
import open3d as o3d
import open3d.core as o3c

from . import geometria as geo
from .quadro import Quadro

CINZA = 0.7        # cor usada quando o quadro não traz imagem


class Reconstrutor:
    # voxel 3 mm e truncamento de 3 voxels (9 mm): medido na caneca sintética.
    # Truncamento de 2 cm (5 x 4 mm) formava uma película falsa dentro da caneca
    # (erro médio 2,2 mm sem ruído e 3,3 mm com ruído, contra 1,05 e 1,7 mm).
    def __init__(self, voxel: float = 0.003, trunc_voxels: float = 3.0,
                 raio: float = 0.25, prof_max: float = 1.5):
        # float(): o Open3D recusa int nesses parâmetros
        self.voxel = float(voxel)
        self.trunc_voxels = float(trunc_voxels)
        self.raio = float(raio)
        self.prof_max = float(prof_max)
        self.vbg = o3d.t.geometry.VoxelBlockGrid(
            attr_names=("tsdf", "weight", "color"),
            attr_dtypes=(o3c.float32, o3c.float32, o3c.float32),
            attr_channels=((1), (1), (3)),
            # block_count é a reserva INICIAL e a tabela cresce sozinha. Cada
            # bloco de 16³ voxels custa ~80 KB: 40000 blocos reservavam 3 GB
            # por sessão. Uma esfera de 25 cm usa algumas centenas de blocos.
            voxel_size=self.voxel, block_resolution=16, block_count=1000,
            device=o3c.Device("CPU:0"))
        self.centro: np.ndarray | None = None
        self.cameras: list[list[float]] = []      # posição de cada quadro integrado
        self.integrados = 0
        self.recusados: dict[str, int] = {}
        # Conferência do mapa de profundidade contra getDepthInMeters() do navegador
        self.inverter_y = False
        self.sondas = {"conferidas": 0, "batem": None, "inverter_y": False}

    # ---------- conversão do quadro ----------

    def _conferir_sondas(self, q: Quadro):
        """
        As primeiras sondas decidem como ler o mapa: lemos o mesmo ponto pelo
        nosso caminho (matriz da especificação) e comparamos com o valor que o
        próprio navegador calculou. Se só bate com o eixo y invertido, usamos
        assim e registramos — melhor do que reconstruir espelhado sem saber.
        """
        if not q.sondas or self.sondas["conferidas"] >= 5:
            return
        acertos = {False: 0, True: 0}
        uteis = 0
        for x, y, m in q.sondas:
            if m <= 0:
                continue
            uteis += 1
            for inv in (False, True):
                lido = geo.amostrar_ponto(q.profundidade, q.norm_prof_da_vista, x, y, inv)
                if abs(lido - m) <= max(0.002, 0.01 * m):
                    acertos[inv] += 1
        if uteis == 0:
            return
        self.sondas["conferidas"] += 1
        if acertos[False] >= acertos[True]:
            self.sondas["batem"] = acertos[False] == uteis
            self.inverter_y = False
        else:
            self.sondas["batem"] = acertos[True] == uteis
            self.inverter_y = True
        self.sondas["inverter_y"] = self.inverter_y

    def preparar(self, q: Quadro) -> dict:
        self._conferir_sondas(q)
        alt_m, larg_m = q.profundidade.shape
        larg, alt = geo.grade_da_vista(q.projecao, larg_m, alt_m)
        prof = geo.amostrar_na_vista(q.profundidade, q.norm_prof_da_vista,
                                     larg, alt, self.inverter_y)
        prof[prof > self.prof_max] = 0
        if q.cor is not None:
            # A imagem da câmera já está alinhada à vista: só muda a resolução
            hc, wc = q.cor.shape[:2]
            li = np.minimum(((np.arange(alt) + 0.5) / alt * hc).astype(int), hc - 1)
            co = np.minimum(((np.arange(larg) + 0.5) / larg * wc).astype(int), wc - 1)
            cor = q.cor[li][:, co].astype(np.float32) / 255.0
        else:
            cor = np.full((alt, larg, 3), CINZA, np.float32)
        fx, fy, cx, cy = geo.intrinsecos_da_projecao(q.projecao, larg, alt)
        return {"prof": prof, "cor": cor, "K": (fx, fy, cx, cy),
                "pose": geo.pose_cv(q.transformacao)}

    # ---------- região de interesse ----------

    def _definir_centro(self, p: dict) -> bool:
        """O alvo é o que está no meio da tela no primeiro quadro bom."""
        prof = p["prof"]
        alt, larg = prof.shape
        a0, a1 = int(alt * 0.4), int(alt * 0.6) + 1
        l0, l1 = int(larg * 0.4), int(larg * 0.6) + 1
        miolo = np.zeros_like(prof)
        miolo[a0:a1, l0:l1] = prof[a0:a1, l0:l1]
        if np.count_nonzero(miolo) < 0.3 * (a1 - a0) * (l1 - l0):
            return False
        pts, _ = geo.pontos_da_profundidade(miolo, *p["K"])
        self.centro = np.median(geo.para_mundo(pts, p["pose"]), axis=0)
        return True

    def _recusar(self, motivo: str) -> bool:
        self.recusados[motivo] = self.recusados.get(motivo, 0) + 1
        return False

    # ---------- integração ----------

    def integrar(self, q: Quadro) -> bool:
        p = self.preparar(q)
        prof = p["prof"]
        if np.count_nonzero(prof) < 0.05 * prof.size:
            return self._recusar("pouca profundidade")
        if self.centro is None and not self._definir_centro(p):
            return self._recusar("sem alvo no centro")

        # Fora da esfera de interesse vira "sem medida" (0): mesa ao longe,
        # paredes e pessoas não entram no volume
        pts, idx = geo.pontos_da_profundidade(prof, *p["K"])
        mundo = geo.para_mundo(pts, p["pose"])
        fora = np.linalg.norm(mundo - self.centro, axis=1) > self.raio
        plano = prof.ravel().copy()
        plano[idx[fora]] = 0
        if np.count_nonzero(plano) < 0.02 * prof.size:
            return self._recusar("objeto fora da tela")
        prof = plano.reshape(prof.shape)

        fx, fy, cx, cy = p["K"]
        K = o3c.Tensor(np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]]), o3c.float64)
        E = o3c.Tensor(np.linalg.inv(p["pose"]), o3c.float64)
        dt = o3d.t.geometry.Image(o3c.Tensor(np.ascontiguousarray(prof, np.float32)))
        ct = o3d.t.geometry.Image(o3c.Tensor(np.ascontiguousarray(p["cor"], np.float32)))
        blocos = self.vbg.compute_unique_block_coordinates(
            dt, K, E, 1.0, self.prof_max, trunc_voxel_multiplier=self.trunc_voxels)
        self.vbg.integrate(blocos, dt, ct, K, E, 1.0, self.prof_max,
                           trunc_voxel_multiplier=self.trunc_voxels)
        self.cameras.append([float(v) for v in p["pose"][:3, 3]])
        self.integrados += 1
        return True

    # ---------- malha ----------

    def liberar(self):
        """Solta a memória do volume (a sessão terminou)."""
        self.vbg = None

    def malha_bruta(self, peso_min: float = 2.0) -> o3d.geometry.TriangleMesh:
        """Malha como está no volume, só recortada pela esfera de interesse."""
        if self.integrados == 0 or self.vbg is None:
            return o3d.geometry.TriangleMesh()
        try:
            m = self.vbg.extract_triangle_mesh(weight_threshold=peso_min).to_legacy()
        except RuntimeError:          # volume ainda sem superfície
            return o3d.geometry.TriangleMesh()
        if len(m.vertices) and self.centro is not None:
            V = np.asarray(m.vertices)
            m.remove_vertices_by_mask(np.linalg.norm(V - self.centro, axis=1) > self.raio)
        return m

    def malha_final(self, peso_min: float = 3.0, suavizar: int = 0):
        """Malha do objeto sozinho, base em y = 0. Devolve (malha, info)."""
        return limpar(self.malha_bruta(peso_min), self.centro, self.voxel, suavizar)


def _rotacao_entre(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Rotação que leva o vetor unitário a no vetor unitário b."""
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3) if c > 0 else np.diag([1.0, -1.0, -1.0])
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1.0 / (1.0 + c))


def _achar_apoio(malha, centro):
    """Plano horizontal abaixo do alvo com mais pontos (mesa, chão)."""
    pcd = o3d.geometry.PointCloud(malha.vertices)
    total = len(pcd.points)
    for _ in range(3):
        if len(pcd.points) < 100:
            break
        plano, inl = pcd.segment_plane(distance_threshold=0.004, ransac_n=3,
                                       num_iterations=2000)
        n = np.array(plano[:3], float)
        d = float(plano[3])
        tam = np.linalg.norm(n)
        n, d = n / tam, d / tam
        if n[1] < 0:
            n, d = -n, -d
        abaixo_do_alvo = centro is None or float(centro @ n + d) > 0.005
        if n[1] > 0.9 and len(inl) > 0.08 * total and abaixo_do_alvo:
            return n, d
        pcd = pcd.select_by_index(inl, invert=True)   # era uma parede: tenta o próximo
    return None


def limpar(malha, centro, voxel, suavizar=0):
    info = {"plano": False, "triangulos_brutos": len(malha.triangles)}
    if len(malha.triangles) == 0:
        return malha, info
    m = o3d.geometry.TriangleMesh(malha)
    cima = np.array([0.0, 1.0, 0.0])          # o 'local' do WebXR tem y para cima
    d = None

    apoio = _achar_apoio(m, centro)
    if apoio is not None:
        cima, d = apoio
        info["plano"] = True
        margem = 1.5 * voxel
        V = np.asarray(m.vertices)
        m.remove_vertices_by_mask((V @ cima + d) < margem)
        # Os vértices logo acima do corte descem até a mesa: a parede do
        # objeto vai até o apoio e a altura não perde a faixa cortada
        V = np.asarray(m.vertices).copy()
        h = V @ cima + d
        perto = h < margem + 1.5 * voxel
        V[perto] -= np.outer(h[perto], cima)
        m.vertices = o3d.utility.Vector3dVector(V)

    # Fica com o pedaço do alvo (e pedaços soltos colados a ele, como uma alça)
    if len(m.triangles):
        grupos, n_tri, _ = m.cluster_connected_triangles()
        grupos, n_tri = np.asarray(grupos), np.asarray(n_tri)
        T = np.asarray(m.triangles)
        V = np.asarray(m.vertices)
        cent_tri = V[T].mean(axis=1)
        k = len(n_tri)
        cent = np.stack([np.bincount(grupos, cent_tri[:, i], minlength=k) for i in range(3)], 1)
        cent /= np.maximum(n_tri, 1)[:, None]
        if centro is not None:
            dif = cent - centro
            horiz = np.linalg.norm(dif - np.outer(dif @ cima, cima), axis=1)
            candidatos = np.nonzero((horiz < 0.12) & (n_tri >= 0.05 * n_tri.max()))[0]
        else:
            candidatos = np.array([], int)
        principal = int(candidatos[np.argmax(n_tri[candidatos])]) if len(candidatos) else int(np.argmax(n_tri))
        manter = np.zeros(k, bool)
        manter[principal] = True
        vp = V[T[grupos == principal].ravel()]
        lo, hi = vp.min(0) - 3 * voxel, vp.max(0) + 3 * voxel
        for g in range(k):
            if g != principal and n_tri[g] >= 20:
                vg = V[T[grupos == g].ravel()]
                if np.all(vg.min(0) <= hi) and np.all(vg.max(0) >= lo):
                    manter[g] = True
        m.remove_triangles_by_mask(~manter[grupos])
        m.remove_unreferenced_vertices()
        info["pedacos"] = int(manter.sum())

    if suavizar:
        cores = np.asarray(m.vertex_colors).copy()
        m = m.filter_smooth_taubin(number_of_iterations=suavizar)
        m.vertex_colors = o3d.utility.Vector3dVector(cores)

    # Referencial do modelo: y para cima, base no apoio (y = 0), centrado em x/z
    R = _rotacao_entre(cima, np.array([0.0, 1.0, 0.0]))
    V = np.asarray(m.vertices) @ R.T
    if len(V):
        # Girado, o plano n·p + d = 0 vira y = -d
        base = -d if d is not None else V[:, 1].min()
        meio = (V.min(0) + V.max(0)) / 2
        desloc = np.array([-meio[0], -base, -meio[2]])
    else:
        desloc = np.zeros(3)
    V = V + desloc
    m.vertices = o3d.utility.Vector3dVector(V)
    m.compute_vertex_normals()

    # modelo -> mundo, para comparar com a verdade nos testes
    modelo_do_mundo = np.eye(4)
    modelo_do_mundo[:3, :3] = R
    modelo_do_mundo[:3, 3] = desloc
    info["mundo_do_modelo"] = np.linalg.inv(modelo_do_mundo)
    if len(V):
        info["medidas_cm"] = {"largura": round(float(np.ptp(V[:, 0])) * 100, 1),
                              "altura": round(float(V[:, 1].max()) * 100, 1),
                              "profundidade": round(float(np.ptp(V[:, 2])) * 100, 1)}
    info["triangulos"] = len(m.triangles)
    return m, info
